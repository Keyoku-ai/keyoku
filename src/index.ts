import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { audit, decideApproval } from "./approvals.js";
import { ConnectorManager } from "./connectors.js";
import { Harness } from "./engine.js";
import { runLearning } from "./learn.js";
import { buildServer, VERSION } from "./server.js";
import { resolveSlmFromEnv } from "./slm.js";
import { Store } from "./store.js";

// stdout is the MCP protocol channel in serve mode — all human output in that
// mode MUST go to stderr.
const log = (...args: unknown[]) => console.error(...args);

function buildHarness(): Harness {
  const store = new Store();
  return new Harness(store, new ConnectorManager(store));
}

async function serve(): Promise<void> {
  const harness = buildHarness();
  const server = buildServer(harness);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Don't let a wedged connector child block exit forever — cap the close.
    await Promise.race([
      harness.connectors.closeAll(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // When the MCP client goes away (stdin EOF / transport close), exit instead
  // of orphaning this process and its connector children.
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  server.server.onclose = () => {
    void shutdown();
  };
  await server.connect(new StdioServerTransport());
  log(`keyoku v${VERSION} serving on stdio (home: ${harness.store.dir})`);
}

async function status(): Promise<void> {
  const harness = buildHarness();
  const goals = harness.store.listGoals();
  console.log(`keyoku v${VERSION} — home: ${harness.store.dir}\n`);
  if (goals.length === 0) {
    console.log("No goals yet. Connect from Claude Code and use goal_create.");
  } else {
    for (const g of goals) {
      console.log(
        `  [${g.status.toUpperCase().padEnd(9)}] ${g.slug} — ${g.objective} (${g.usedIterations}/${g.maxIterations} iterations, ${g.criteria.length} criteria)`,
      );
    }
  }
  const connectors = harness.connectors.list();
  const workflows = harness.store.listWorkflows();
  console.log(`\nConnectors: ${connectors.map((c) => c.name).join(", ") || "(none)"}`);
  console.log(
    `Workflows learned: ${workflows.map((w) => `${w.slug} (${w.stats.convergences}x)`).join(", ") || "(none)"}`,
  );
}

// Exit codes: 0 = converged, 1 = not converged, 2 = error (unknown goal etc.)
async function assess(ref: string | undefined): Promise<void> {
  if (!ref) {
    console.error("Usage: keyoku-harness assess <goal-slug>");
    process.exit(2);
  }
  const harness = buildHarness();
  try {
    const report = await harness.assess(ref);
    for (const c of report.criteria) {
      const mark = c.pass ? "✓" : "✗";
      const note = c.pass ? "" : ` — ${c.error ?? `got ${JSON.stringify(c.actual)?.slice(0, 120)}`}`;
      console.log(`  ${mark} [${c.id}] ${c.description}${note}`);
    }
    console.log(`\n${report.guidance}`);
    process.exitCode = report.converged ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  } finally {
    await harness.connectors.closeAll();
  }
}

async function watch(ref: string | undefined, argv: string[]): Promise<void> {
  const all = ref === "--all" || argv.includes("--all");
  if (!all && (!ref || ref.startsWith("-"))) {
    console.error("Usage: keyoku-harness watch <goal-slug>|--all [--interval <seconds>]");
    process.exit(2);
  }
  const intervalIdx = argv.indexOf("--interval");
  const intervalSec = intervalIdx >= 0 ? Number(argv[intervalIdx + 1]) : 60;
  if (!Number.isFinite(intervalSec) || intervalSec < 1) {
    console.error("--interval must be a positive number of seconds");
    process.exit(2);
  }
  const harness = buildHarness();
  if (!all) {
    try {
      harness.getGoal(ref!);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  }
  const label = all ? "all active + converged goals" : `'${ref}'`;
  console.log(`Watching ${label} every ${intervalSec}s (Ctrl-C to stop)…`);
  const checkOne = async (slug: string) => {
    try {
      const report = await harness.assess(slug);
      const stamp = new Date().toISOString();
      if (report.converged) {
        console.log(`[${stamp}] ${slug} ✓ converged (${report.criteria.length} criteria)`);
      } else {
        const drift = report.driftDetected ? " DRIFT!" : "";
        console.log(`[${stamp}] ${slug} ✗ ${report.unmetCount} unmet${drift}`);
        for (const c of report.criteria.filter((c) => !c.pass)) {
          console.log(`    ✗ [${c.id}] ${c.description}`);
        }
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ${slug} assess failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const check = async () => {
    const targets = all
      ? harness.store
          .listGoals()
          .filter((g) => g.status === "active" || g.status === "converged")
          .map((g) => g.slug)
      : [ref!];
    if (targets.length === 0) console.log("(no active or converged goals to watch)");
    for (const slug of targets) await checkOne(slug);
  };
  // Guard against overlap: if probes outrun the interval, skip the tick rather
  // than piling up concurrent assessments of the same goal.
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await check();
    } finally {
      inFlight = false;
    }
  };
  await tick();
  setInterval(tick, intervalSec * 1000);
}

async function learn(): Promise<void> {
  const harness = buildHarness();
  const slm = resolveSlmFromEnv();
  console.log(
    slm
      ? `Mining patterns with ${slm.name} (${slm.model})…`
      : "No SLM configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY) — mining heuristically…",
  );
  const result = await runLearning(harness.store, slm);
  audit(harness.store, {
    actor: "cli",
    op: "learn",
    summary: `${result.method}: ${result.created} created, ${result.reinforced} reinforced`,
    ok: true,
  });
  console.log(
    `Done (${result.method}): ${result.minedCandidates} candidates → ${result.created} new, ${result.reinforced} reinforced, ${result.totalPatterns} total patterns.`,
  );
  for (const p of harness.store.listPatterns()) {
    console.log(`  • ${p.name} [stability ${p.stability}] — ${p.steps.join(" → ")}`);
  }
}

async function record(): Promise<void> {
  // Called by Claude Code PostToolUse hook — reads JSON from stdin.
  // Format: { tool_name, tool_input, tool_response, session_id }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return; // nothing on stdin — no-op

  let hookData: Record<string, unknown> = {};
  try { hookData = JSON.parse(raw); } catch { return; } // malformed — skip silently

  const toolName = String(hookData.tool_name ?? "");
  const toolInput = (hookData.tool_input ?? {}) as Record<string, unknown>;
  const sessionId = String(hookData.session_id ?? "");

  // Build a human-readable summary from the tool name + key input fields.
  let summary = toolName;
  let detail: string | undefined;
  if (toolName === "Bash") {
    const cmd = String(toolInput.command ?? "").trim();
    summary = `Bash: ${cmd.slice(0, 80)}`;
    detail = cmd.slice(0, 500);
  } else if (toolName === "Edit" || toolName === "Write") {
    const filePath = String(toolInput.file_path ?? "");
    summary = `${toolName}: ${filePath}`;
    detail = filePath;
  } else if (toolName === "Read") {
    summary = `Read: ${String(toolInput.file_path ?? "")}`;
  }

  // Determine git-ness from Bash commands
  const type =
    toolName === "Bash" && String(detail ?? "").match(/^git\s/)
      ? ("git" as const)
      : toolName === "Bash"
        ? ("shell" as const)
        : ["Edit", "Write"].includes(toolName)
          ? ("file_change" as const)
          : ("tool_use" as const);

  // Append directly to the activity JSONL — no MCP server needed.
  const { Store } = await import("./store.js");
  const { enrichWithEntities } = await import("./activity.js");
  const { newId } = await import("./store.js");
  const store = new Store();
  let event = {
    id: newId("ev"),
    type,
    summary,
    ...(detail ? { detail } : {}),
    tool: toolName || undefined,
    sessionId: sessionId || undefined,
    at: new Date().toISOString(),
  };
  // @ts-ignore — enrichWithEntities accepts ActivityEvent but we've inlined the shape
  event = enrichWithEntities(event);
  store.appendActivity(event as Parameters<typeof store.appendActivity>[0]);
  // Exit 0 — hooks must not block Claude Code on failure
}

async function init(): Promise<void> {
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");

  // Resolve the absolute path to this dist/index.js
  const selfPath = fileURLToPath(import.meta.url);

  const home = homedir();
  const claudeDir = join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  // Claude Code reads BOTH MCP servers and hooks from ~/.claude/settings.json.
  // A separate mcp.json is NOT read by Claude Code — everything goes in settings.
  const settingsPath = join(claudeDir, "settings.json");

  function readJsonFile(p: string): Record<string, unknown> {
    if (!existsSync(p)) return {};
    const raw = readFileSync(p, "utf8");
    try { return JSON.parse(raw); }
    catch {
      throw new Error(
        `${p} exists but could not be parsed as JSON. Fix or delete it first, then re-run keyoku init.`,
      );
    }
  }

  const settings = readJsonFile(settingsPath);

  // 1. MCP server entry
  const mcpServers = ((settings.mcpServers ?? {}) as Record<string, unknown>);
  mcpServers["keyoku"] = { command: "node", args: [selfPath] };
  settings.mcpServers = mcpServers;

  // 2. PostToolUse hook
  const hooks = ((settings.hooks ?? {}) as Record<string, unknown>);
  const postToolUse = (Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : []) as unknown[];
  const alreadyWired = postToolUse.some(
    (h) => typeof h === "object" && h !== null && JSON.stringify(h).includes("keyoku"),
  );
  if (!alreadyWired) {
    postToolUse.push({
      matcher: "Bash|Edit|Write|Read",
      hooks: [{ type: "command", command: `node ${selfPath} record` }],
    });
  }
  hooks.PostToolUse = postToolUse;
  settings.hooks = hooks;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  console.log(`keyoku initialised.

  MCP server + PostToolUse hook written to: ${settingsPath}

  Restart Claude Code for changes to take effect.
  State lives in ~/.keyoku/

  Try: keyoku status
       keyoku serve   (or just open Claude Code — it auto-connects)`);
}

async function approvals(rest: string[]): Promise<void> {
  const harness = buildHarness();
  const [sub, id, ...reasonParts] = rest;
  if (sub === "approve" || sub === "deny") {
    if (!id) {
      console.error(`Usage: keyoku-harness approvals ${sub} <id>${sub === "deny" ? " [reason]" : ""}`);
      process.exit(2);
    }
    try {
      const approval = await decideApproval(
        harness.store,
        id,
        sub === "approve" ? "approve" : "deny",
        (c, t, a) => harness.connectors.callTool(c, t, a),
        reasonParts.join(" ") || undefined,
      );
      audit(harness.store, {
        actor: "cli",
        op: `approval_${sub}`,
        target: approval.connector,
        summary: `${approval.tool} → ${approval.status}`,
        ok: approval.status !== "failed",
      });
      console.log(`${approval.id}: ${approval.status}${approval.result ? ` — ${approval.result.slice(0, 400)}` : ""}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
    } finally {
      await harness.connectors.closeAll();
    }
    return;
  }
  const list = harness.store.listApprovals();
  if (list.length === 0) {
    console.log("No approval requests.");
    return;
  }
  for (const a of list) {
    console.log(`  [${a.status.toUpperCase().padEnd(8)}] ${a.id} ${a.connector}.${a.tool} — ${a.reason} (${a.requestedAt})`);
  }
  if (list.some((a) => a.status === "pending")) {
    console.log("\nDecide with: keyoku-harness approvals approve|deny <id> [reason]");
  }
}

function auditCmd(rest: string[]): void {
  const harness = buildHarness();
  const limit = rest[0] ? Number(rest[0]) : 50;
  const entries = harness.store.listAudit(Number.isFinite(limit) && limit > 0 ? limit : 50);
  if (entries.length === 0) {
    console.log("Audit trail is empty.");
    return;
  }
  for (const e of entries) {
    console.log(`  ${e.at} [${e.actor}] ${e.ok ? "✓" : "✗"} ${e.op}${e.target ? ` ${e.target}` : ""}${e.summary ? ` — ${e.summary}` : ""}`);
  }
}

function help(): void {
  console.log(`keyoku v${VERSION} — always-on activity tracer and workflow automation layer

Usage:
  keyoku [serve]                    Run as an MCP server on stdio (default)
  keyoku init                       Wire up Claude Code hook + MCP config
  keyoku status                     Show goals, connectors, learned workflows
  keyoku assess <goal>              One-shot convergence check (exit 0 = converged)
  keyoku watch <goal>|--all         Re-assess on an interval [--interval <seconds>]
  keyoku learn                      Mine patterns from activity (SLM or heuristic)
  keyoku record                     Record a PostToolUse hook event (reads stdin JSON)
  keyoku approvals                  List queue; approve|deny <id> [reason] to decide
  keyoku audit [n]                  Show the last n audit entries
  keyoku help | version

Quick start:
  npx keyoku init          Wire into Claude Code (adds MCP + PostToolUse hook)
  npx keyoku status        Check what's being tracked
  npx keyoku serve         Start the MCP server manually

State lives in $KEYOKU_HOME (default ~/.keyoku).`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd ?? "serve") {
    case "serve":
      return serve();
    case "status":
      return status();
    case "assess":
      return assess(rest[0]);
    case "watch":
      return watch(rest[0], rest);
    case "learn":
      return learn();
    case "record":
      return record();
    case "init":
      return init();
    case "approvals":
      return approvals(rest);
    case "audit":
      return auditCmd(rest);
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      help();
      return;
    default:
      console.error(`Unknown command '${cmd}'.\n`);
      help();
      process.exit(1);
  }
}

main().catch((err) => {
  // Expected errors (bad refs, corrupt store) read as messages, not crashes;
  // KEYOKU_DEBUG=1 restores stacks for the unexpected kind.
  const detail =
    process.env.KEYOKU_DEBUG && err instanceof Error
      ? err.stack ?? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  console.error(detail);
  process.exit(2);
});
