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

  // Codex sessions: rollout-*.jsonl under ~/.codex/sessions (or --codex-dir).
  // Two line shapes exist in the wild: bare items ({"type":"function_call",…})
  // and response_item-wrapped ({"type":"response_item","payload":{…}}).
  const codexIdx = argv.indexOf("--codex-dir");
  const codexRoot =
    codexIdx >= 0 && argv[codexIdx + 1] ? argv[codexIdx + 1] : join(homedir(), ".codex", "sessions");
  let codexFiles: string[] = [];
  try {
    codexFiles = (readdirSync(codexRoot, { recursive: true }) as string[])
      .filter((f) => String(f).endsWith(".jsonl"))
      .map((f) => join(codexRoot, String(f)));
  } catch {
    /* codex not installed */
  }
  let codexScanned = 0;
  for (const file of codexFiles) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let sid = "";
    let cwd: string | undefined;
    let lastTs = "";
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof obj.timestamp === "string") lastTs = obj.timestamp;
      if (!sid && typeof obj.id === "string") sid = obj.id;
      const item = (obj.type === "response_item" ? obj.payload : obj) as Record<string, unknown> | null;
      if (!item || typeof item !== "object") continue;
      if (!cwd) {
        const m = line.match(/<cwd>([^<]+)<\/cwd>/);
        if (m) cwd = m[1];
      }
      if (item.type !== "function_call" || typeof item.name !== "string") continue;
      if (!/shell|exec|command/i.test(item.name)) continue;
      let cmd = "";
      try {
        const a = JSON.parse(String(item.arguments ?? "{}")) as { command?: unknown };
        const c = a.command;
        cmd = Array.isArray(c)
          ? c.length >= 3 && /^(bash|sh|zsh)$/.test(String(c[0]))
            ? String(c[c.length - 1])
            : c.map(String).join(" ")
          : String(c ?? "");
      } catch {
        continue;
      }
      if (!cmd) continue;
      codexScanned += 1;
      const ev = buildToolEvent("Bash", { command: cmd }, sid || file, lastTs || new Date(0).toISOString(), cwd);
      if (!ev) continue;
      const key = `${ev.sessionId ?? ""}|${ev.at}|${ev.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(ev);
    }
  }
  scanned += codexScanned;

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
    `Imported ${recent.length} events from ${files.length} Claude + ${codexFiles.length} Codex transcript file(s) (${scanned} tool calls scanned).` +
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
    if (await isPaused()) return;
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
    if (await isPaused()) return;
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
  const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");

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

  // --agents-md [file]: bake into an AGENTS.md managed block instead — the
  // Codex-native (and agent-agnostic) projection. Sections are keyed by slug
  // so re-exports update in place.
  const agentsIdx = argv.indexOf("--agents-md");
  if (agentsIdx >= 0) {
    const next = argv[agentsIdx + 1];
    const target = next && !next.startsWith("-") && next !== slug ? next : join(process.cwd(), "AGENTS.md");
    const START = "<!-- keyoku:workflows -->";
    const END = "<!-- /keyoku:workflows -->";
    const section = `### keyoku:${template.slug} — ${template.name}\n\n${template.description}\n\nRun via the keyoku MCP server: call \`workflow_execute { "slug": "${template.slug}" }\`; resume pauses with \`execution_complete\`. Generated by keyoku (run ${template.timesRun}×) — re-export to update, do not hand-edit.\n\nSteps:\n${steps}\n`;
    let doc = "";
    try {
      doc = readFileSync(target, "utf8");
    } catch {
      /* new file */
    }
    let before: string;
    let inside: string;
    let after: string;
    const s = doc.indexOf(START);
    const e = doc.indexOf(END);
    if (s >= 0 && e > s) {
      before = doc.slice(0, s + START.length);
      inside = doc.slice(s + START.length, e);
      after = doc.slice(e);
    } else {
      before = `${doc.replace(/\n*$/, doc.trim() ? "\n\n" : "")}${START}`;
      inside = "\n";
      after = `${END}\n`;
    }
    const slugRe = new RegExp(`^\\s*### keyoku:${template.slug}\\b`);
    const kept = inside.split(/\n(?=### keyoku:)/).filter((c) => c.trim() !== "" && !slugRe.test(c));
    const newInside = `${["", ...kept].join("\n").replace(/\n*$/, "\n")}\n${section}`;
    writeFileSync(target, `${before}${newInside}${after}`);
    console.log(`Baked '${template.slug}' → ${target} (AGENTS.md managed block)
Codex and every AGENTS.md-reading agent now knows this workflow.`);
    return;
  }

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

/** Privacy switch: while ~/.keyoku/paused exists, nothing records and the
 * hooks inject nothing. One command each way. */
async function isPaused(): Promise<boolean> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { resolveHome } = await import("./store.js");
  return existsSync(join(resolveHome(), "paused"));
}

async function pause(): Promise<void> {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const store = new Store();
  writeFileSync(join(store.dir, "paused"), new Date().toISOString());
  console.log("keyoku paused — nothing will be recorded or injected until `keyoku resume`.");
}

async function resume(): Promise<void> {
  const { rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const store = new Store();
  rmSync(join(store.dir, "paused"), { force: true });
  console.log("keyoku resumed — recording and context injection are active again.");
}

/** Health check for the whole installation — the support-thread killer. */
async function doctor(): Promise<void> {
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { existsSync, readFileSync } = await import("node:fs");
  const { resolveSlmFromEnv } = await import("./slm.js");
  const store = new Store();
  let failures = 0;
  const check = (ok: boolean | "info", label: string, detail = ""): void => {
    const mark = ok === true ? "✓" : ok === "info" ? "–" : "✗";
    if (ok === false) failures += 1;
    console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ""}`);
  };
  console.log("keyoku doctor\n");

  let settings = "";
  try { settings = readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"); } catch { /* missing */ }
  check(settings.includes(" record"), "PostToolUse hook (recording)");
  check(settings.includes(" brief"), "SessionStart hook (brief)");
  check(settings.includes(" context"), "UserPromptSubmit hook (practice injection)");

  let claudeJson = "";
  try { claudeJson = readFileSync(join(homedir(), ".claude.json"), "utf8"); } catch { /* missing */ }
  check(claudeJson.includes('"keyoku"'), "MCP server registered in ~/.claude.json");

  const codexCfg = join(homedir(), ".codex", "config.toml");
  if (existsSync(codexCfg)) {
    let toml = "";
    try { toml = readFileSync(codexCfg, "utf8"); } catch { /* unreadable */ }
    check(toml.includes("[mcp_servers.keyoku]"), "Codex MCP registration (~/.codex/config.toml)", "run keyoku init to wire");
  } else {
    check("info", "Codex not detected", "skipping");
  }

  const paused = existsSync(join(store.dir, "paused"));
  check(!paused, paused ? "recording PAUSED" : "recording active", paused ? "run `keyoku resume`" : "");

  const activity = store.listActivity();
  check(
    activity.length > 0,
    `activity log: ${activity.length} events`,
    activity.length > 0 ? `last at ${activity[activity.length - 1].at}` : "run `keyoku import` or use your agent",
  );

  const slm = resolveSlmFromEnv();
  check("info", `SLM tier: ${slm ? `${slm.name} (${slm.model})` : "none — agent-as-refiner handles refinement"}`);

  const engineUrl = process.env.KEYOKU_ENGINE_URL?.trim();
  if (engineUrl) {
    let ok = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${engineUrl.replace(/\/+$/, "")}/api/v1/health`, { signal: controller.signal });
      clearTimeout(timer);
      ok = res.ok;
    } catch { /* unreachable */ }
    check(ok, `engine reachable at ${engineUrl}`);
  } else {
    check("info", "engine not configured", "set KEYOKU_ENGINE_URL to enable the brain");
  }

  console.log(failures === 0 ? "\nAll core checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

async function record(): Promise<void> {
  if (await isPaused()) return;
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

async function init(argv: string[] = []): Promise<void> {
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { execSync, spawnSync } = await import("node:child_process");

  // Resolve a DURABLE absolute path to this dist/index.js. Under `npx keyoku
  // init` the running script lives in the evictable ~/.npm/_npx/<hash> cache —
  // npm can prune it at any time, which would break the MCP server and every
  // hook. When we detect that, resolve the global install instead, and abort
  // with guidance if there isn't one: a setup written from the npx cache is a
  // time bomb, not a convenience.
  const runningPath = fileURLToPath(import.meta.url);
  let selfPath = runningPath;
  if (/[/\\]_npx[/\\]/.test(runningPath)) {
    let durable: string | undefined;
    try {
      const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
      const candidate = join(globalRoot, "keyoku", "dist", "index.js");
      if (existsSync(candidate)) durable = candidate;
    } catch {
      /* npm not resolvable — fall through to the guidance below */
    }
    if (!durable) {
      throw new Error(
        "keyoku is running from the temporary npx cache (~/.npm/_npx/…), which " +
          "npm can evict at any time.\nA setup written from here would silently " +
          "break later. Install keyoku durably first, then re-run init:\n\n" +
          "  npm install -g keyoku\n  keyoku init\n",
      );
    }
    selfPath = durable;
  }

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

  // Always wire hooks to the absolute durable entry path. We deliberately do
  // NOT probe `command -v keyoku`: under `npx keyoku init` npx injects an
  // ephemeral `keyoku` onto PATH for the lifetime of the process, so the probe
  // returns a false positive and we'd bake in a bare `keyoku record` that can
  // never resolve once npx exits. An absolute `node <path>` has no PATH
  // dependence and survives upgrades (global node_modules/keyoku is stable).
  const hookCmd = `node ${selfPath} record`;

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

  // Codex: same MCP server, wired into ~/.codex/config.toml automatically
  // when Codex is installed (or forced with --codex).
  const codexCfgPath = join(home, ".codex", "config.toml");
  let codexLine = "Codex:            not detected (rerun with --codex after installing)";
  if (existsSync(codexCfgPath) || argv.includes("--codex")) {
    let toml = "";
    try {
      toml = readFileSync(codexCfgPath, "utf8");
    } catch {
      mkdirSync(join(home, ".codex"), { recursive: true });
    }
    if (toml.includes("[mcp_servers.keyoku]")) {
      codexLine = "Codex:            already wired";
    } else {
      writeFileSync(
        codexCfgPath,
        `${toml.replace(/\n*$/, toml ? "\n\n" : "")}[mcp_servers.keyoku]\ncommand = "node"\nargs = ["${selfPath}"]\n`,
      );
      codexLine = `Codex:            MCP server added to ${codexCfgPath}`;
    }
  }

  console.log(`keyoku initialised.

  MCP server:       ${mcpHow}
  PostToolUse hook: ${settingsPath} (${hookCmd})
  ${codexLine}

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
  keyoku import [--dir D]           Backfill activity from Claude Code + Codex transcripts
  keyoku export <slug> [--agents-md] Bake a workflow into ./.claude/skills (or AGENTS.md)
  keyoku pause | resume             Privacy switch — stop/start all recording & injection
  keyoku doctor                     Verify hooks, MCP registration, engine, and activity
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
    case "pause":
      return pause();
    case "resume":
      return resume();
    case "doctor":
      return doctor();
    case "init":
      return init(rest);
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
