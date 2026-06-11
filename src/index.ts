import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { audit, decideApproval } from "./approvals.js";
import { ConnectorManager } from "./connectors.js";
import { Harness } from "./engine.js";
import { runLearning } from "./learn.js";
import { buildServer, VERSION } from "./server.js";
import { resolveSlmFromEnv } from "./slm.js";
import { redactSecrets } from "./activity.js";
import { newId, Store } from "./store.js";
import type { ActivityEvent } from "./types.js";

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

  // Background intelligence: while the server runs, ripeness is recomputed
  // continuously and cached for the hooks to deliver into the conversation.
  // The interval is unref'd so it never holds the process open on shutdown.
  const { findRipe, loadSurfaced, saveRipe } = await import("./nudge.js");
  const digest = () => {
    try {
      saveRipe(
        harness.store.dir,
        findRipe(harness.store.listActivity(2000), loadSurfaced(harness.store.dir)),
      );
    } catch {
      /* background work must never break serving */
    }
  };
  digest();
  setInterval(digest, 60_000).unref();
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

/** Map a Claude Code tool call to an ActivityEvent. Shared by the live hook
 * (record) and transcript backfill (import) so both produce identical events. */
function buildToolEvent(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
  at: string,
  cwd?: string,
): ActivityEvent | null {
  if (!toolName) return null;
  let summary: string;
  let detail: string | undefined;
  if (toolName === "Bash") {
    const cmd = redactSecrets(String(toolInput.command ?? "").trim());
    if (!cmd) return null;
    summary = `Bash: ${cmd.slice(0, 80)}`;
    detail = cmd.slice(0, 500);
  } else if (toolName === "Edit" || toolName === "Write") {
    const filePath = String(toolInput.file_path ?? "");
    summary = `${toolName}: ${filePath}`;
    detail = filePath;
  } else if (toolName === "Read") {
    summary = `Read: ${String(toolInput.file_path ?? "")}`;
  } else if (toolName.startsWith("mcp__")) {
    // MCP tool names are mcp__<server>__<tool> — record which external
    // server the agent used so connector usage becomes learnable context.
    const parts = toolName.split("__");
    const server = parts[1] ?? "unknown";
    const mcpTool = parts.slice(2).join("__") || "tool";
    summary = `MCP: ${server}.${mcpTool}`;
    detail = redactSecrets(JSON.stringify({ server, tool: mcpTool, args: toolInput })).slice(0, 500);
  } else {
    return null; // outside the v1 trace surface
  }
  const type =
    toolName === "Bash" && /^git\s/.test(detail ?? "")
      ? ("git" as const)
      : toolName === "Bash"
        ? ("shell" as const)
        : ["Edit", "Write"].includes(toolName)
          ? ("file_change" as const)
          : ("tool_use" as const);
  return {
    id: newId("ev"),
    type,
    summary,
    ...(detail ? { detail } : {}),
    tool: toolName,
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
    at,
  };
}

/** Backfill activity from Claude Code session transcripts — kills the cold
 * start: months of real tool calls become minable history in one command. */
async function importCmd(argv: string[]): Promise<void> {
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { readdirSync, readFileSync } = await import("node:fs");
  const { enrichWithEntities } = await import("./activity.js");

  const dirIdx = argv.indexOf("--dir");
  const root =
    dirIdx >= 0 && argv[dirIdx + 1] ? argv[dirIdx + 1] : join(homedir(), ".claude", "projects");
  const limitIdx = argv.indexOf("--limit");
  const limit = limitIdx >= 0 && Number(argv[limitIdx + 1]) > 0 ? Number(argv[limitIdx + 1]) : 10_000;

  let files: string[] = [];
  try {
    files = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => String(f).endsWith(".jsonl"))
      .map((f) => join(root, String(f)));
  } catch (err) {
    console.error(`Cannot read ${root}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const store = new Store();
  // Dedupe against everything already recorded — live hook or prior imports.
  const seen = new Set(store.listActivity().map((e) => `${e.sessionId ?? ""}|${e.at}|${e.summary}`));

  const events: ActivityEvent[] = [];
  let scanned = 0;
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.includes('"tool_use"')) continue;
      let obj: { type?: string; timestamp?: string; sessionId?: string; cwd?: string; message?: { content?: unknown } };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type !== "assistant" || !obj.timestamp) continue;
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
        scanned++;
        const ev = buildToolEvent(
          block.name,
          block.input ?? {},
          String(obj.sessionId ?? ""),
          String(obj.timestamp),
          obj.cwd ? String(obj.cwd) : undefined,
        );
        if (!ev) continue;
        const key = `${ev.sessionId ?? ""}|${ev.at}|${ev.summary}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(ev);
      }
    }
  }

  events.sort((a, b) => a.at.localeCompare(b.at));
  const recent = events.slice(-limit);
  for (const ev of recent) store.appendActivity(enrichWithEntities(ev));

  // Conventions ingestion: CLAUDE.md files are ground truth the user already
  // wrote — file each project's sections into the knowledge layer once, so
  // declared conventions ground refinement alongside observed patterns.
  const { basename } = await import("node:path");
  const roots = new Set<string>();
  for (const ev of recent) {
    if (!ev.cwd) continue;
    const m = ev.cwd.match(/^(.*\/Development\/[^/]+)/);
    roots.add(m ? m[1] : ev.cwd);
  }
  let conventionsFiled = 0;
  for (const dir of roots) {
    const project = basename(dir).toLowerCase();
    const subject = `conventions:${project}`;
    if (store.listKnowledge(subject).length > 0) continue; // idempotent
    let text: string;
    try {
      text = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    } catch {
      continue;
    }
    const sections = text
      .split(/\n(?=## )/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 10);
    for (const section of sections) {
      store.appendKnowledge({
        id: newId("kn"),
        subject,
        kind: "note",
        fact: section.slice(0, 600),
        source: "user",
        at: new Date().toISOString(),
      });
      conventionsFiled += 1;
    }
  }

  console.log(
    `Imported ${recent.length} events from ${files.length} transcript file(s) (${scanned} tool calls scanned).` +
      (conventionsFiled > 0 ? `\nFiled ${conventionsFiled} convention section(s) from CLAUDE.md into the knowledge layer.` : "") +
      (recent.length > 0 ? "\nRun workflow_suggest in your agent — your history is now minable." : ""),
  );
}

/** UserPromptSubmit hook: practice injection. Match the user's prompt and
 * project against saved workflows and practice knowledge, and put 1–2 lines
 * in front of the agent BEFORE it acts — workflows consulted, not invoked.
 * Strict relevance threshold: silence is the default. */
async function contextCmd(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return;
    let prompt = "";
    let cwd = "";
    try {
      const o = JSON.parse(raw);
      prompt = String(o.prompt ?? "");
      cwd = String(o.cwd ?? "");
    } catch {
      prompt = raw;
    }
    if (!prompt) return;

    const store = new Store();
    const lines: string[] = [];

    // Saved workflows matching the prompt (word overlap, ≥2 hits to speak)
    const words = new Set(
      prompt
        .toLowerCase()
        .split(/[^a-z0-9-]+/)
        .filter((w) => w.length > 3),
    );
    if (words.size > 0) {
      const scored = store
        .listTemplates()
        .map((t) => {
          const hay = `${t.slug} ${t.name} ${t.description}`.toLowerCase();
          let score = 0;
          for (const w of words) if (hay.includes(w)) score += 1;
          return { t, score };
        })
        .filter((x) => x.score >= 2)
        .sort((a, b) => b.score - a.score);
      if (scored[0]) {
        lines.push(
          `Saved workflow matches this request: '${scored[0].t.slug}' (${scored[0].t.name}) — prefer workflow_execute { slug: "${scored[0].t.slug}" } over redoing it manually.`,
        );
      }
    }

    // Project practice from the knowledge layer (cwd → practice:<project>)
    const proj = cwd.match(/\/Development\/([^/]+)/)?.[1]?.toLowerCase();
    if (proj) {
      for (const p of store.listKnowledge(`practice:${proj}`).slice(-2)) {
        lines.push(`House pattern in ${proj}: ${p.fact.slice(0, 200)}`);
      }
    }

    if (lines.length === 0) return;
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `[keyoku] ${lines.slice(0, 2).join(" | ")}`,
        },
      }),
    );
  } catch {
    /* never block a prompt */
  }
}

/** SessionStart hook: one context line so the agent starts every session
 * aware of the workflow catalog and any unsaved patterns. */
async function brief(): Promise<void> {
  try {
    const { formatBrief, loadSurfaced, resolveRipe } = await import("./nudge.js");
    const store = new Store();
    const ripe = resolveRipe(store.dir, loadSurfaced(store.dir), () => store.listActivity(2000));
    const line = formatBrief(store.listTemplates().length, ripe.length);
    if (line) console.log(line);
  } catch {
    /* never block session start */
  }
}

/** Bake an approved workflow into the current repo as a Claude Code skill —
 * the repo-resident, reviewable, team-shareable projection of the template.
 * The store stays canonical; this artifact is derived and carries provenance. */
async function exportCmd(argv: string[]): Promise<void> {
  const { join } = await import("node:path");
  const { mkdirSync, writeFileSync } = await import("node:fs");

  const slug = argv.find((a) => !a.startsWith("-"));
  if (!slug) {
    console.error("Usage: keyoku export <workflow-slug> [--dir <skills-dir>]");
    process.exit(2);
  }
  const store = new Store();
  const template = store.getTemplate(slug);
  if (!template) {
    console.error(`No approved workflow '${slug}'. See: keyoku status`);
    process.exit(2);
  }
  const dirIdx = argv.indexOf("--dir");
  const skillsDir =
    dirIdx >= 0 && argv[dirIdx + 1] ? argv[dirIdx + 1] : join(process.cwd(), ".claude", "skills");
  const dir = join(skillsDir, template.slug);
  mkdirSync(dir, { recursive: true });

  const steps = template.steps
    .map((s, i) => {
      const what =
        s.type === "bash"
          ? `run \`${s.command}\`${s.cwd ? ` (cwd: ${s.cwd})` : ""}`
          : s.type === "mcp_call"
            ? `call connector \`${s.connector}\` tool \`${s.tool}\``
            : s.type === "agent_prompt"
              ? `(agent step) ${s.prompt ?? s.summary}`
              : `(human review) ${s.message ?? s.summary}`;
      return `${i + 1}. **${s.summary}** — ${what}`;
    })
    .join("\n");

  const skill = `---
name: ${template.slug}
description: ${template.description.replace(/\n/g, " ")} (learned by keyoku from observed activity; prefer running it via the keyoku MCP server)
---

# ${template.name}

> Generated by keyoku from approved workflow \`${template.slug}\`
> (updated ${template.updatedAt}, run ${template.timesRun}×). This file is a
> derived artifact — if you hand-edit it, tell keyoku so the change is
> learned back as drift evidence instead of silently diverging.

Preferred execution: call the keyoku MCP tool
\`workflow_execute { "slug": "${template.slug}" }\` and handle any paused
steps with \`execution_complete\` until it reports completed. Fall back to
performing the steps manually only if keyoku is unavailable.

## Steps

${steps}
`;
  const path = join(dir, "SKILL.md");
  writeFileSync(path, skill);
  console.log(`Baked '${template.slug}' → ${path}
Commit it to share the workflow with your team; the keyoku store remains the living source of truth.`);
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

  // Append directly to the activity JSONL — no MCP server needed.
  const event = buildToolEvent(
    toolName,
    toolInput,
    sessionId,
    new Date().toISOString(),
    String(hookData.cwd ?? "") || undefined,
  );
  if (!event) return;
  const { enrichWithEntities } = await import("./activity.js");
  const store = new Store();
  store.appendActivity(enrichWithEntities(event));

  // Proactive surfacing: every Nth recorded event, check whether a pattern
  // has newly crossed the suggestion threshold and inject a one-time nudge
  // into the session via the PostToolUse additionalContext channel. The
  // agent sees it and offers — nobody has to remember to ask.
  try {
    const every = Number(process.env.KEYOKU_NUDGE_EVERY ?? "25");
    if (!Number.isFinite(every) || every <= 0) return;
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const counterPath = join(store.dir, "hook.counter");
    let n = 0;
    try {
      n = Number(readFileSync(counterPath, "utf8")) || 0;
    } catch {
      /* first run */
    }
    n += 1;
    writeFileSync(counterPath, String(n));
    if (n % every !== 0) return;

    const { formatNudge, loadSurfaced, resolveRipe, saveSurfaced } = await import("./nudge.js");
    const surfaced = loadSurfaced(store.dir);
    const ripe = resolveRipe(store.dir, surfaced, () => store.listActivity(2000));
    if (ripe.length === 0) return;
    const top = ripe[0];
    surfaced.add(top.key);
    saveSurfaced(store.dir, surfaced);
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: formatNudge(top) },
      }),
    );
  } catch {
    /* nudging must never break the session */
  }
  // Exit 0 — hooks must not block Claude Code on failure
}

async function init(): Promise<void> {
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { execSync, spawnSync } = await import("node:child_process");

  // Resolve the absolute path to this dist/index.js
  const selfPath = fileURLToPath(import.meta.url);

  const home = homedir();
  const claudeDir = join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  function loadJson(p: string): Record<string, unknown> {
    if (!existsSync(p)) return {};
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      throw new Error(`${p} exists but is not valid JSON. Fix or remove it, then re-run keyoku init.`);
    }
  }
  function writeJsonAtomic(p: string, data: unknown): void {
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, p);
  }

  // 1. MCP server registration. Claude Code reads user-scoped MCP servers from
  // ~/.claude.json — NOT from settings.json and NOT from a mcp.json. Prefer
  // the official CLI; fall back to editing ~/.claude.json when it isn't on PATH.
  let mcpHow: string;
  const viaCli = spawnSync(
    "claude",
    ["mcp", "add", "--scope", "user", "keyoku", "--", "node", selfPath],
    { stdio: "ignore" },
  );
  if (viaCli.status === 0) {
    mcpHow = "registered via `claude mcp add --scope user keyoku`";
  } else {
    const claudeJsonPath = join(home, ".claude.json");
    const claudeJson = loadJson(claudeJsonPath);
    const servers = (claudeJson.mcpServers ?? {}) as Record<string, unknown>;
    servers["keyoku"] = { type: "stdio", command: "node", args: [selfPath] };
    claudeJson.mcpServers = servers;
    writeJsonAtomic(claudeJsonPath, claudeJson);
    mcpHow = `written to ${claudeJsonPath}`;
  }

  // 2. PostToolUse hook — hooks DO live in settings.json. Also clean up the
  // mcpServers key an older keyoku init wrote there (Claude Code ignores it).
  const settingsPath = join(claudeDir, "settings.json");
  const settings = loadJson(settingsPath);
  if (settings.mcpServers && typeof settings.mcpServers === "object") {
    const stray = settings.mcpServers as Record<string, unknown>;
    delete stray["keyoku"];
    if (Object.keys(stray).length === 0) delete settings.mcpServers;
  }

  // Prefer the PATH-resolved bin — it survives package upgrades. Fall back to
  // the absolute dist path for local checkouts.
  let hookCmd = `node ${selfPath} record`;
  try {
    execSync("command -v keyoku", { stdio: "ignore", shell: "/bin/sh" });
    hookCmd = "keyoku record";
  } catch {
    /* not on PATH — keep the absolute path */
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const postToolUse = (Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : []) as unknown[];
  // Drop any previous keyoku hook entry (it may point at a stale install path),
  // then add the current one — idempotent and self-healing across upgrades.
  const others = postToolUse.filter(
    (h) => !(typeof h === "object" && h !== null && JSON.stringify(h).includes("keyoku")),
  );
  others.push({
    matcher: "Bash|Edit|Write|Read|mcp__.*",
    hooks: [{ type: "command", command: hookCmd }],
  });
  hooks.PostToolUse = others;

  // SessionStart brief: the agent opens every session knowing the workflow
  // catalog and whether unsaved patterns are waiting.
  const briefCmd = hookCmd.replace(/ record$/, " brief");
  const sessionStart = (Array.isArray(hooks.SessionStart) ? hooks.SessionStart : []) as unknown[];
  const ssOthers = sessionStart.filter(
    (h) => !(typeof h === "object" && h !== null && JSON.stringify(h).includes("keyoku")),
  );
  ssOthers.push({ hooks: [{ type: "command", command: briefCmd }] });
  hooks.SessionStart = ssOthers;

  // UserPromptSubmit practice injection: saved workflows and house patterns
  // are consulted before the agent acts — the practice layer's wire.
  const contextCmdStr = hookCmd.replace(/ record$/, " context");
  const promptSubmit = (Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : []) as unknown[];
  const psOthers = promptSubmit.filter(
    (h) => !(typeof h === "object" && h !== null && JSON.stringify(h).includes("keyoku")),
  );
  psOthers.push({ hooks: [{ type: "command", command: contextCmdStr }] });
  hooks.UserPromptSubmit = psOthers;

  settings.hooks = hooks;
  writeJsonAtomic(settingsPath, settings);

  console.log(`keyoku initialised.

  MCP server:       ${mcpHow}
  PostToolUse hook: ${settingsPath} (${hookCmd})

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
  console.log(`keyoku v${VERSION} — the harness with muscle memory

Usage:
  keyoku [serve]                    Run as an MCP server on stdio (default)
  keyoku init                       Wire up Claude Code hook + MCP config
  keyoku status                     Show goals, connectors, learned workflows
  keyoku assess <goal>              One-shot convergence check (exit 0 = converged)
  keyoku watch <goal>|--all         Re-assess on an interval [--interval <seconds>]
  keyoku learn                      Mine patterns from activity (SLM or heuristic)
  keyoku record                     Record a PostToolUse hook event (reads stdin JSON)
  keyoku import [--dir D]           Backfill activity from Claude Code transcripts
  keyoku export <slug> [--dir D]    Bake a workflow into ./.claude/skills as a skill
  keyoku brief                      Session-start context line (used by the SessionStart hook)
  keyoku context                    Practice injection for a prompt (used by the UserPromptSubmit hook)
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
    case "import":
      return importCmd(rest);
    case "export":
      return exportCmd(rest);
    case "brief":
      return brief();
    case "context":
      return contextCmd();
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
