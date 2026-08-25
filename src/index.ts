import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { audit, decideApproval } from "./approvals.js";
import { ConnectorManager } from "./connectors.js";
import {
  findProjectRoot,
  initProject,
  listOutcomes,
  listOutcomeHistory,
  listFactfileHistory,
  loadContribution,
  loadProject,
  publishFactfile,
  reviewContribution,
  renderFactfileGithubMarkdown,
  runGate,
  startContribution,
} from "./contribution.js";
import { archCmd } from "./arch.js";
import { deckCmd } from "./deck.js";
import { demoCmd } from "./demo.js";
import { startProofSessionServer } from "./session-server.js";
import { customizeProof, initProof } from "./project-profile.js";
import { runProofDemo } from "./proof-demo.js";
import { pulseCmd } from "./pulse-cli.js";
import { iterationCmd } from "./iteration-cli.js";
import { Harness } from "./engine.js";
import { runLearning } from "./learn.js";
import { buildServer, VERSION } from "./server.js";
import { resolveSlmFromEnv } from "./slm.js";
import { redactSecrets } from "./activity.js";
import { newId, Store } from "./store.js";
import type { ActivityEvent, WorkflowStep, WorkflowStepTemplate, WorkflowTemplate } from "./types.js";

export { ConnectorManager } from "./connectors.js";
export {
  ActorSchema,
  ContributionManifestSchema,
  OutcomeSchema,
  ProjectManifestSchema,
  ReviewEventSchema,
  captureRepository,
  findProjectRoot,
  initProject,
  listOutcomes,
  listOutcomeHistory,
  loadContribution,
  loadOutcome,
  loadProject,
  publishFactfile,
  reviewContribution,
  renderFactfileHtml,
  renderFactfileGithubMarkdown,
  renderFactfileMarkdown,
  runGate,
  startContribution,
  type Actor,
  type ContributionManifest,
  type GateSnapshot,
  type FactfileHistoryItem,
  type Outcome,
  type ProjectManifest,
  type ReviewEvent,
} from "./contribution.js";
export {
  AgentPresenceSchema,
  DecisionOptionSchema,
  DecisionRequestSchema,
  DirectionProposalSchema,
  InstructionSchema,
  ProofSessionEventSchema,
  WorkItemSchema,
  acknowledgeInstruction,
  heartbeatAgent,
  nextInstruction,
  queueInstruction,
  readProofSession,
  reportWork,
  proposeDirection,
  requestDecision,
  resolveDecision,
  type AgentPresence,
  type DecisionRequest,
  type DirectionProposal,
  type Instruction,
  type ProofSessionState,
  type WorkItem,
} from "./proof-session.js";
export { startProofSessionServer, type ProofSessionServer } from "./session-server.js";
export { customizeProof, detectProject, initProof, renderGithubWorkflow, type ProjectKind, type ProjectProfile } from "./project-profile.js";
export { Harness } from "./engine.js";
export { buildServer, VERSION } from "./server.js";
export { Store } from "./store.js";
export * from "./pulse.js";
export * from "./pulse-fixtures.js";
export * from "./iteration.js";

// stdout is the MCP protocol channel in serve mode — all human output in that
// mode MUST go to stderr.
const log = (...args: unknown[]) => console.error(...args);

function buildHarness(): Harness {
  const store = new Store();
  // Pass the lite model (if configured) so workflow-suggestion re-ranking can use it
  // when opted in (KEYOKU_SLM_SUGGEST=1). Cheap to construct; no network until used.
  return new Harness(store, new ConnectorManager(store), resolveSlmFromEnv());
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function flagValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1] && !argv[index + 1]!.startsWith("--")) values.push(argv[index + 1]!);
  }
  return values;
}

/**
 * Matches keyoku's own hook command (`node <…>/index.js <verb>`) STRUCTURALLY —
 * regardless of whether the install path happens to contain the literal
 * "keyoku". Used by both init (idempotent self-heal — no duplicate hooks, and
 * foreign hooks that merely mention "keyoku" survive) and doctor (a decoy
 * " record" substring can no longer false-green a missing hook).
 */
// Matches BOTH the current `node <…>/index.js <verb>` form AND the legacy bare
// `keyoku <verb>` (with optional path prefix) that v1.x shipped when keyoku was
// on PATH — so doctor greens a legacy install and init dedups/replaces it
// instead of double-wiring. ANCHORED (^…$): the whole command must BE the keyoku
// invocation, so a foreign hook that merely passes "keyoku record" as a DATA
// argument (echo keyoku record, worklog keyoku record) is NOT claimed — init
// must never green or delete someone else's hook.
const KEYOKU_HOOK_RE = /^(?:node\s+\S*index\.js|(?:\S*[/\\])?keyoku)\s+(record|brief|context)\s*$/;

function isKeyokuHookGroup(entry: unknown, verb?: "record" | "brief" | "context"): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const inner = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(inner)) return false;
  return inner.some((h) => {
    const cmd = h && typeof (h as { command?: unknown }).command === "string" ? (h as { command: string }).command : "";
    const m = cmd.match(KEYOKU_HOOK_RE);
    return m !== null && (!verb || m[1] === verb);
  });
}

async function serve(): Promise<void> {
  const harness = buildHarness();
  const server = buildServer(harness);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Kill any in-flight bash step and its whole process group — grandchildren
    // must not outlive the server — and mark the executions they belonged to
    // failed so a restart doesn't see a permanently-"running" ghost.
    const { killAllBashSteps } = await import("./executor.js");
    killAllBashSteps();
    for (const exec of harness.store.listExecutions("running")) {
      exec.status = "failed";
      const step = exec.steps[exec.currentStep];
      if (step && step.status === "running") {
        step.status = "failed";
        step.error = "interrupted by server shutdown";
      }
      exec.completedAt = new Date().toISOString();
      harness.store.saveExecution(exec);
    }
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
  console.log(`keyoku v${VERSION} — continuous proof for human-owned software\n`);
  try {
    const root = findProjectRoot();
    const project = loadProject(root);
    const outcomes = listOutcomes(root);
    console.log(`Project: ${project.name} (${project.id})\nRoot: ${root}\nOutcomes: ${outcomes.length}`);
    for (const outcome of outcomes) {
      console.log(`  ${outcome.id}@${outcome.revision} — ${outcome.title}`);
    }
  } catch {
    console.log("Project: not initialized (run 'keyoku project init')");
  }
  console.log(`\nPersonal harness home: ${harness.store.dir}`);
  if (goals.length === 0) {
    console.log("Goals: (none)");
  } else {
    console.log("Goals:");
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

async function focusCmd(rest: string[]): Promise<void> {
  const harness = buildHarness();
  try {
    const arg = rest[0];
    if (arg === "--clear" || arg === "clear") {
      const prev = harness.clearFocus();
      console.log(prev ? `Focus cleared (was '${prev.goalSlug}').` : "No focus was set.");
      return;
    }
    if (!arg) {
      const f = harness.getFocus();
      console.log(
        f
          ? `Focused: ${f.goalSlug}${f.cwd ? ` (cwd ${f.cwd})` : ""} since ${f.at}`
          : "No goal focused. Set one with: keyoku focus <goal>",
      );
      return;
    }
    const f = harness.setFocus(arg, { cwd: process.cwd() });
    console.log(`Focused '${f.goalSlug}'. Actions under ${f.cwd ?? "any dir"} are now captured into its trace live.`);
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

  // JSON.stringify yields a valid YAML double-quoted scalar (quotes/backslashes
  // escaped) — so a description containing ':' or '#' or a leading '[' can't
  // produce invalid frontmatter that breaks every skill-loading agent.
  const descLine = `${template.description.replace(/\n/g, " ")} (learned by keyoku from observed activity; prefer running it via the keyoku MCP server)`;
  const skill = `---
name: ${JSON.stringify(template.slug)}
description: ${JSON.stringify(descLine)}
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
  writeFileSync(join(store.dir, "paused"), new Date().toISOString(), { mode: 0o600 });
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

  // Parse the config STRUCTURALLY — a substring check false-greens on any
  // unrelated hook whose command happens to contain " record"/" brief" etc.
  let settingsObj: Record<string, unknown> = {};
  try { settingsObj = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")); } catch { /* missing/invalid */ }
  const hookGroups = (event: string): unknown[] => {
    const hooks = (settingsObj.hooks ?? {}) as Record<string, unknown>;
    return Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  };
  check(hookGroups("PostToolUse").some((h) => isKeyokuHookGroup(h, "record")), "PostToolUse hook (recording)");
  check(hookGroups("SessionStart").some((h) => isKeyokuHookGroup(h, "brief")), "SessionStart hook (brief)");
  check(hookGroups("UserPromptSubmit").some((h) => isKeyokuHookGroup(h, "context")), "UserPromptSubmit hook (practice injection)");

  let claudeObj: Record<string, unknown> = {};
  try { claudeObj = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")); } catch { /* missing/invalid */ }
  const mcpServers = (claudeObj.mcpServers ?? {}) as Record<string, unknown>;
  check(typeof mcpServers.keyoku === "object" && mcpServers.keyoku !== null, "MCP server registered in ~/.claude.json");

  const codexCfg = join(homedir(), ".codex", "config.toml");
  if (existsSync(codexCfg)) {
    let toml = "";
    try { toml = readFileSync(codexCfg, "utf8"); } catch { /* unreadable */ }
    const block = toml.match(/\[mcp_servers\.keyoku\][\s\S]*?(?=\n\[|$)/)?.[0];
    const wiredPath = block?.match(/args\s*=\s*\[\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, "$1");
    if (!block) {
      check(false, "Codex MCP registration (~/.codex/config.toml)", "run keyoku init to wire");
    } else if (wiredPath && !existsSync(wiredPath)) {
      check(false, "Codex MCP registration (~/.codex/config.toml)", "stale path — re-run keyoku init to heal");
    } else {
      check(true, "Codex MCP registration (~/.codex/config.toml)");
    }
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
  const { autoRecordToFocusGoal } = await import("./engine.js");
  const store = new Store();
  const enriched = enrichWithEntities(event);
  store.appendActivity(enriched);
  // Live muscle memory: if a goal is focused, capture this action into its trace.
  autoRecordToFocusGoal(store, enriched);

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
    writeFileSync(counterPath, String(n), { mode: 0o600 });
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
  const others = postToolUse.filter((h) => !isKeyokuHookGroup(h));
  others.push({
    matcher: "Bash|Edit|Write|Read|mcp__.*",
    hooks: [{ type: "command", command: hookCmd }],
  });
  hooks.PostToolUse = others;

  // SessionStart brief: the agent opens every session knowing the workflow
  // catalog and whether unsaved patterns are waiting.
  const briefCmd = hookCmd.replace(/ record$/, " brief");
  const sessionStart = (Array.isArray(hooks.SessionStart) ? hooks.SessionStart : []) as unknown[];
  const ssOthers = sessionStart.filter((h) => !isKeyokuHookGroup(h));
  ssOthers.push({ hooks: [{ type: "command", command: briefCmd }] });
  hooks.SessionStart = ssOthers;

  // UserPromptSubmit practice injection: saved workflows and house patterns
  // are consulted before the agent acts — the practice layer's wire.
  const contextCmdStr = hookCmd.replace(/ record$/, " context");
  const promptSubmit = (Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : []) as unknown[];
  const psOthers = promptSubmit.filter((h) => !isKeyokuHookGroup(h));
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
    const codexBlockRe = /\[mcp_servers\.keyoku\][\s\S]*?(?=\n\[|$)/;
    const existingBlock = toml.match(codexBlockRe)?.[0];
    const wiredPath = existingBlock?.match(/args\s*=\s*\[\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, "$1");
    const escaped = selfPath.replace(/\\/g, "\\\\");
    if (existingBlock && wiredPath === selfPath) {
      codexLine = "Codex:            already wired";
    } else if (existingBlock) {
      // Heal a stale path SURGICALLY — rewrite only the args line inside the
      // keyoku block, leaving the rest of the user's config untouched. Reporting
      // "already wired" while the path is dead would leave Codex silently broken.
      const healed = toml.replace(codexBlockRe, (blk) =>
        blk.replace(/args\s*=\s*\[[^\]]*\]/, `args = ["${escaped}"]`),
      );
      writeFileSync(codexCfgPath, healed);
      codexLine = `Codex:            stale MCP path healed in ${codexCfgPath}`;
    } else {
      writeFileSync(
        codexCfgPath,
        `${toml.replace(/\n*$/, toml ? "\n\n" : "")}[mcp_servers.keyoku]\ncommand = "node"\nargs = ["${escaped}"]\n`,
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
  console.log(`keyoku v${VERSION} — continuous proof for human-owned software

Usage:
  keyoku [serve]                    Run as an MCP server on stdio (default)
  keyoku proof init                 Detect this project and install the free proof workflow
  keyoku proof customize <outcome>  Change outcome language, checks, decisions, or scope
  keyoku proof run <outcome>        Create an exact-snapshot Factfile locally
  keyoku proof serve <contribution> Open a live human ↔ agent proof session
  keyoku proof ci <outcome>         Render a native GitHub Check summary and artifact
  keyoku demo <init|record|watch>   Recorded, agent-watched product demo as evidence
  keyoku deck init                  Write a commented .keyoku/deck.yaml template
  keyoku deck build [--for P]       Deterministically render one persona's HTML deck
  keyoku deck plan "<ask>"          Agent drafts/updates deck.yaml from a natural prompt
  keyoku arch render <spec.yaml>    Render a standalone architecture-diagram SVG [-o <out.svg>]
  keyoku project init               Add portable .keyoku project metadata
  keyoku proof demo [--open]        Run a real proof in a disposable repository
  keyoku project show               Explain the current Keyoku project
  keyoku outcome list               List repository outcome contracts
  keyoku outcome history <id>       Show the Git history of an outcome contract
  keyoku contribution start <outcome>
                                     Open an accountable contribution
  keyoku contribution show <id>     Show contribution status and actors
  keyoku contribution review <id>   Append a human review note
  keyoku contribution accept <id>   Accept the exact current proven snapshot
  keyoku gate <contribution>        Verify outcome and render its Factfile
  keyoku factfile <contribution>    Print the generated HTML report path
  keyoku factfile publish <id>      Explicitly upload canonical JSON to keyoku-engine
  keyoku iterate start <outcome>    Start a bounded prove → repair → re-prove session
  keyoku iterate status <session>   Inspect exact-round evidence and stop conditions
  keyoku iterate checkpoint <id>    Re-prove after an idempotent agent checkpoint
  keyoku pulse help                 Append, plan, and render trusted cross-checkpoint progress
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
  keyoku proof demo --open
  keyoku proof init
  keyoku proof customize review-ready-change --objective "A user can complete checkout"
  keyoku proof run review-ready-change

Project proof lives in .keyoku/. Personal agent memory lives in $KEYOKU_HOME (default ~/.keyoku).`);
}

async function proofCmd(rest: string[]): Promise<void> {
  const sub = rest[0] ?? "run";
  if (sub === "demo") {
    const directory = flagValue(rest, "--dir");
    await runProofDemo({
      ...(directory ? { root: directory } : {}),
      open: rest.includes("--open"),
      log: (line) => console.log(line),
    });
    return;
  }
  if (sub === "init") {
    const result = initProof({
      outcomeId: flagValue(rest, "--outcome"),
      title: flagValue(rest, "--title"),
      objective: flagValue(rest, "--objective"),
      check: flagValue(rest, "--check"),
      forceWorkflow: rest.includes("--force-workflow"),
    });
    console.log(`Keyoku proof is ready for ${result.profile.label}.\nOutcome: ${resolve(result.outcomePath)}\nGitHub workflow: ${resolve(result.workflowPath)}\n\nReview the outcome language, then run:\n  keyoku proof run ${result.outcome.id}`);
    return;
  }
  if (sub === "customize") {
    const outcomeId = rest[1];
    if (!outcomeId || outcomeId.startsWith("-")) throw new Error("Usage: keyoku proof customize <outcome> [--title <text>] [--objective <text>] [--check <command> --claim <text> --why <text>] [--decision <question> --decision-id <id> --guidance <text>] [--include <glob>] [--exclude <glob>] [--max-files <n>]");
    const maxFilesValue = flagValue(rest, "--max-files");
    const maxChangedFiles = maxFilesValue === undefined ? undefined : Number(maxFilesValue);
    if (maxChangedFiles !== undefined && (!Number.isInteger(maxChangedFiles) || maxChangedFiles <= 0)) throw new Error("--max-files must be a positive integer.");
    const include = flagValues(rest, "--include");
    const exclude = flagValues(rest, "--exclude");
    const hasEdits = ["--title", "--objective", "--check", "--decision", "--include", "--exclude", "--max-files"].some((flag) => rest.includes(flag));
    if (!hasEdits) {
      const outcome = listOutcomes(findProjectRoot()).find((candidate) => candidate.id === outcomeId);
      if (!outcome) throw new Error(`Unknown outcome '${outcomeId}'.`);
      console.log(`${outcome.title} · revision ${outcome.revision}\n\nOutcome\n  ${outcome.objective}\n\nAutomated claims (${outcome.criteria.length})\n${outcome.criteria.map((criterion, index) => `  ${index + 1}. ${criterion.description}`).join("\n")}\n\nHuman decisions (${outcome.humanCriteria.length})\n${outcome.humanCriteria.map((criterion, index) => `  ${index + 1}. ${criterion.description}`).join("\n") || "  None declared"}\n\nCustomize without editing YAML:\n  keyoku proof customize ${outcome.id} --objective "What must be observably true"\n  keyoku proof customize ${outcome.id} --check "npm run test:e2e" --claim "Checkout works end to end" --why "This is the user-visible outcome"\n  keyoku proof customize ${outcome.id} --decision "The flow is clear on mobile" --guidance "Inspect the attached desktop and mobile screenshots"\n  keyoku proof customize ${outcome.id} --include "src/**" --include "tests/**" --max-files 25`);
      return;
    }
    const result = customizeProof({
      root: findProjectRoot(),
      outcomeId,
      title: flagValue(rest, "--title"),
      objective: flagValue(rest, "--objective"),
      check: flagValue(rest, "--check"),
      claim: flagValue(rest, "--claim"),
      why: flagValue(rest, "--why"),
      decision: flagValue(rest, "--decision"),
      decisionId: flagValue(rest, "--decision-id"),
      guidance: flagValue(rest, "--guidance"),
      ...(include.length ? { include } : {}),
      ...(exclude.length ? { exclude } : {}),
      ...(maxChangedFiles !== undefined ? { maxChangedFiles } : {}),
    });
    console.log(`Updated ${result.outcome.id} to revision ${result.outcome.revision}.\nChanged: ${result.changes.join(", ")}\nContract: ${resolve(result.outcomePath)}\n\nRun the new proof:\n  keyoku proof run ${result.outcome.id}`);
    return;
  }
  if (sub === "serve") {
    const contributionId = rest[1];
    if (!contributionId || contributionId.startsWith("-")) throw new Error("Usage: keyoku proof serve <contribution-id> [--port <number>] [--no-open]");
    const portValue = flagValue(rest, "--port");
    const port = portValue === undefined ? undefined : Number(portValue);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error("--port must be an integer from 0 to 65535.");
    const session = await startProofSessionServer({ root: findProjectRoot(), contributionId, ...(port !== undefined ? { port } : {}) });
    console.log(`Keyoku live proof session\n${session.url}\n\nThe link is local, token-scoped, and remains valid while this process runs.`);
    if (!rest.includes("--no-open")) {
      try {
        if (process.platform === "darwin") execFileSync("open", [session.url], { stdio: "ignore" });
        else if (process.platform === "win32") execFileSync("cmd", ["/c", "start", "", session.url], { stdio: "ignore" });
        else execFileSync("xdg-open", [session.url], { stdio: "ignore" });
      } catch { console.error("Could not open a browser automatically; use the URL above."); }
    }
    await new Promise<void>((resolvePromise) => {
      const stop = () => { void session.close().finally(resolvePromise); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  if (sub !== "run" && sub !== "ci") throw new Error("Usage: keyoku proof demo|init|customize|serve|run|ci [outcome]");
  const outcomeId = rest[1];
  if (!outcomeId || outcomeId.startsWith("-")) throw new Error(`Usage: keyoku proof ${sub} <outcome> [--base <git-ref>] [--summary <text>]`);
  const root = findProjectRoot();
  const githubActor = process.env.GITHUB_ACTOR;
  const harness = flagValue(rest, "--harness") ?? (sub === "ci" ? "GitHub Actions" : undefined);
  const model = flagValue(rest, "--model");
  const actorName = flagValue(rest, "--actor") ?? (sub === "ci" ? githubActor ?? "GitHub Actions" : undefined);
  const contribution = startContribution({
    root,
    outcomeId,
    title: flagValue(rest, "--title"),
    summary: flagValue(rest, "--summary"),
    baseSha: flagValue(rest, "--base") ?? process.env.KEYOKU_BASE_SHA,
    reuseActive: sub === "run" && !rest.includes("--new"),
    ...(actorName || harness || model ? { actor: {
      kind: harness || model ? "agent" as const : "human" as const,
      id: flagValue(rest, "--actor-id") ?? (sub === "ci" ? `github:${githubActor ?? "actions"}:${process.env.GITHUB_RUN_ID ?? "local"}` : actorName ?? "local-agent"),
      name: actorName ?? model ?? harness ?? "Agent",
      role: sub === "ci" ? "proof runner" : "contributor",
      ...(harness ? { harness } : {}),
      ...(model ? { model } : {}),
      ...(harness || model ? { ownerId: flagValue(rest, "--owner") ?? "repository-owner" } : {}),
    } } : {}),
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `contribution_id=${contribution.id}\n`, "utf8");
  const snapshot = await runGate(root, contribution.id);
  const dir = resolve(root, ".keyoku", "contributions", contribution.id);
  const githubMarkdown = renderFactfileGithubMarkdown(snapshot);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, githubMarkdown, "utf8");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `state=${snapshot.state}\nfactfile=${dir}/factfile.html\n`, "utf8");
  console.log(`${snapshot.state.replaceAll("_", " ").toUpperCase()} — ${snapshot.summary.passed}/${snapshot.summary.total} automated claims; ${snapshot.humanReview.pending} human decisions pending\nContribution: ${contribution.id}\nGitHub summary: ${dir}/factfile.github.md\nFull Factfile: ${dir}/factfile.html`);
  const machineBlocked = snapshot.state === "evidence_gaps" || snapshot.state === "review_blocked";
  if (machineBlocked || (sub === "run" && snapshot.state !== "ready_for_review" && snapshot.state !== "accepted")) process.exitCode = 1;
}

function projectCmd(rest: string[]): void {
  const sub = rest[0] ?? "show";
  if (sub === "init") {
    const manifest = initProject({
      id: flagValue(rest, "--id"),
      name: flagValue(rest, "--name"),
      summary: flagValue(rest, "--summary"),
    });
    console.log(`Created .keyoku/project.yaml for ${manifest.name}.\n\nNext: add an outcome contract under .keyoku/outcomes/.`);
    return;
  }
  if (sub === "show") {
    const root = findProjectRoot();
    const project = loadProject(root);
    const outcomes = listOutcomes(root);
    console.log(`${project.name} (${project.id})\n${project.summary}\n\nRoot: ${root}\nOutcomes: ${outcomes.length}`);
    return;
  }
  throw new Error("Usage: keyoku project init|show");
}

function outcomeCmd(rest: string[]): void {
  const sub = rest[0] ?? "list";
  if (sub === "history") {
    const id = rest[1];
    if (!id) throw new Error("Usage: keyoku outcome history <id>");
    const history = listOutcomeHistory(findProjectRoot(), id);
    if (!history.length) {
      console.log(`No committed history for '${id}' yet. Commit the outcome contract to make its revisions public.`);
      return;
    }
    console.log(`${id} — repository-owned outcome history\n`);
    for (const entry of history) console.log(`  ${entry.sha.slice(0, 12)}  ${entry.authoredAt}  r${entry.revision ?? "?"}  ${entry.subject} — ${entry.author}`);
    return;
  }
  if (sub !== "list") throw new Error("Usage: keyoku outcome list|history <id>");
  const outcomes = listOutcomes();
  if (outcomes.length === 0) {
    console.log("No outcomes yet. Add .keyoku/outcomes/<id>.yaml.");
    return;
  }
  for (const outcome of outcomes) {
    console.log(`  ${outcome.id}@${outcome.revision} — ${outcome.title} (${outcome.criteria.length} criteria)`);
  }
}

function contributionCmd(rest: string[]): void {
  const sub = rest[0];
  const ref = rest[1];
  if (sub === "start") {
    if (!ref) throw new Error("Usage: keyoku contribution start <outcome> [--title <title>] [--harness <name>] [--model <name>]");
    const root = findProjectRoot();
    const actorName = flagValue(rest, "--actor");
    const harness = flagValue(rest, "--harness");
    const model = flagValue(rest, "--model");
    const contribution = startContribution({
      root,
      outcomeId: ref,
      title: flagValue(rest, "--title"),
      summary: flagValue(rest, "--summary"),
      ...(actorName || harness || model
        ? {
            actor: {
              kind: harness || model ? "agent" : "human",
              id: flagValue(rest, "--actor-id") ?? actorName ?? `${harness ?? "agent"}:${model ?? "unspecified"}`,
              name: actorName ?? model ?? harness ?? "Agent",
              role: harness || model ? "implementer" : "accountable owner",
              ...(harness ? { harness } : {}),
              ...(model ? { model } : {}),
              ...(harness || model ? { ownerId: flagValue(rest, "--owner") ?? "local-human" } : {}),
            },
          }
        : {}),
    });
    console.log(`Started ${contribution.id}\nOutcome: ${contribution.outcomeId}@${contribution.outcomeRevision}\nStatus: ${contribution.status}\n\nVerify with: keyoku gate ${contribution.id}`);
    return;
  }
  if (sub === "show") {
    if (!ref) throw new Error("Usage: keyoku contribution show <id>");
    const contribution = loadContribution(findProjectRoot(), ref);
    console.log(`${contribution.title}\n${contribution.id}\nOutcome: ${contribution.outcomeId}@${contribution.outcomeRevision}\nStatus: ${contribution.status}\nActors: ${contribution.actors.map((actor) => `${actor.name} (${actor.kind})`).join(", ")}`);
    return;
  }
  if (sub === "review" || sub === "accept") {
    if (!ref) throw new Error(`Usage: keyoku contribution ${sub} <id> --comment <text> [--reviewer <name>]`);
    const comment = flagValue(rest, "--comment");
    if (!comment) throw new Error("A non-empty --comment is required so the public receipt explains the human decision.");
    const reviewerName = flagValue(rest, "--reviewer");
    const verdictValue = flagValue(rest, "--verdict");
    if (verdictValue && verdictValue !== "pass" && verdictValue !== "fail") throw new Error("--verdict must be pass or fail.");
    const snapshot = reviewContribution({
      root: findProjectRoot(),
      contributionId: ref,
      decision: sub === "accept" ? "accepted" : "note",
      comment,
      criterionId: flagValue(rest, "--criterion"),
      verdict: verdictValue as "pass" | "fail" | undefined,
      ...(reviewerName ? { reviewer: { kind: "human", id: flagValue(rest, "--reviewer-id") ?? reviewerName, name: reviewerName, role: "reviewer" } } : {}),
    });
    console.log(`${sub === "accept" ? "ACCEPTED" : "REVIEW RECORDED"} — ${snapshot.outcome.title}\nSnapshot: ${snapshot.repository.headSha.slice(0, 12)}+${snapshot.repository.worktreeDigest.slice(0, 12)}\nFactfile: ${resolve(findProjectRoot(), ".keyoku", "contributions", ref, "factfile.html")}`);
    return;
  }
  throw new Error("Usage: keyoku contribution start|show|review|accept <ref>");
}

async function gateCmd(rest: string[]): Promise<void> {
  const ref = rest.find((value) => !value.startsWith("-"));
  if (!ref) throw new Error("Usage: keyoku gate <contribution-id>");
  const root = findProjectRoot();
  const snapshot = await runGate(root, ref);
  const report = resolve(root, ".keyoku", "contributions", snapshot.contribution.id, "factfile.html");
  console.log(`${snapshot.state.replaceAll("_", " ").toUpperCase()} — automated ${snapshot.summary.passed}/${snapshot.summary.total}; human ${snapshot.humanReview.passed}/${snapshot.humanReview.total}\nSnapshot: ${snapshot.repository.headSha.slice(0, 12)}+${snapshot.repository.worktreeDigest.slice(0, 12)}\nFactfile: ${report}`);
  if (snapshot.state !== "ready_for_review" && snapshot.state !== "accepted") process.exitCode = 1;
}

async function factfileCmd(rest: string[]): Promise<void> {
  if (rest[0] === "publish") {
    const ref = rest[1];
    if (!ref) throw new Error("Usage: keyoku factfile publish <contribution-id> [--engine <url>]");
    const engine = flagValue(rest, "--engine") ?? process.env.KEYOKU_ENGINE_URL;
    if (!engine) throw new Error("Set KEYOKU_ENGINE_URL or pass --engine <url>. Publishing is never automatic.");
    const result = await publishFactfile(
      findProjectRoot(),
      ref,
      engine,
      process.env.KEYOKU_ENGINE_TOKEN ?? process.env.KEYOKU_SESSION_TOKEN,
    );
    console.log(`Published ${ref} to ${engine}\n${JSON.stringify(result, null, 2)}`);
    return;
  }
  const ref = rest.find((value) => !value.startsWith("-"));
  if (!ref) throw new Error("Usage: keyoku factfile <contribution-id>");
  const path = resolve(findProjectRoot(), ".keyoku", "contributions", ref, "factfile.html");
  if (!existsSync(path)) throw new Error(`No Factfile for '${ref}'. Run 'keyoku gate ${ref}' first.`);
  console.log(path);
}

/** Repair hollow muscle memory: populate converged goals' empty workflows from
 *  their recorded trace or the activity log (work that was logged but, under an
 *  older build, never lifted into steps). `--dry-run` shows what would change. */
async function backfillCmd(rest: string[]): Promise<void> {
  const dryRun = rest.includes("--dry-run") || rest.includes("-n");
  const harness = buildHarness();
  const report = harness.repairWorkflows({ dryRun });
  const changed = report.filter((r) => r.status === "populated" || r.status === "would-populate");
  const none = report.filter((r) => r.status === "no-activity");
  const skipped = report.filter((r) => r.status === "skipped");
  console.log(`keyoku backfill${dryRun ? " (dry run)" : ""} — ${report.length} converged goal(s) examined\n`);
  for (const r of report) {
    const mark =
      r.status === "populated" ? "✓ populated     " :
      r.status === "would-populate" ? "→ would populate" :
      r.status === "no-activity" ? "· no activity   " :
      "  has steps      ";
    const delta = r.inferred > r.before ? ` (${r.before} → ${r.inferred} steps)` : "";
    console.log(`  ${mark} ${r.slug}${delta}`);
  }
  console.log(
    `\n${dryRun ? "Would populate" : "Populated"} ${changed.length} hollow workflow(s); ` +
    `${skipped.length} already had steps; ${none.length} had no recoverable activity.`,
  );
  if (dryRun && changed.length > 0) console.log("\nRun `keyoku backfill` (no flag) to apply.");
}

/** Data-trust inspector: show exactly what keyoku has stored about you in
 *  KEYOKU_HOME, file sizes + permissions, redaction posture, and how to scope or
 *  wipe it. `--secrets` scans the activity log for known secret patterns (a
 *  tripwire confirming write-time redaction held). Read-only. */
async function inspect(rest: string[]): Promise<void> {
  const { statSync, existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const store = new Store();
  const fmt = (n: number) =>
    n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`;
  console.log(`keyoku inspect — ${store.dir}\n`);

  const goals = store.listGoals();
  const byStatus = goals.reduce((a, g) => { a[g.status] = (a[g.status] ?? 0) + 1; return a; }, {} as Record<string, number>);
  console.log(`Goals:      ${goals.length} (${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(", ") || "none"})`);
  const wf = store.listWorkflows();
  const hollow = wf.filter((w) => w.steps.length === 0).length;
  const rawWf = wf.filter((w) => w.steps.some((s) => s.source === "activity")).length;
  console.log(`Workflows:  ${wf.length} (${hollow} hollow, ${rawWf} with raw activity steps — refine via 'keyoku refine <slug>')`);
  console.log(`Patterns: ${store.listPatterns().length}  Templates: ${store.listTemplates().length}  Executions: ${store.listExecutions().length}  Knowledge: ${store.listKnowledge().length}`);
  const conns = store.listConnectors();
  console.log(`Connectors: ${conns.length}${conns.length ? ` (${conns.map((c) => `${c.name}:${c.autonomy}`).join(", ")})` : ""}`);

  const act = store.listActivity();
  console.log(`\nActivity:   ${act.length} events`);
  if (act.length > 0) {
    console.log(`  span:      ${(act[0].at ?? "?").slice(0, 10)} → ${(act[act.length - 1].at ?? "?").slice(0, 10)}`);
    console.log(`  recording: ${existsSync(join(store.dir, "paused")) ? "PAUSED ('keyoku resume' to re-enable)" : "active ('keyoku pause' to stop)"}`);
  }

  console.log(`\nStored files (perms should be 600/700 — credential-grade):`);
  for (const f of ["goals.json", "workflows.json", "activity.jsonl", "knowledge.jsonl", "connectors.json", "focus.json", "audit.jsonl", "patterns.json"]) {
    const p = join(store.dir, f);
    if (!existsSync(p)) continue;
    const s = statSync(p);
    const mode = (s.mode & 0o777).toString(8);
    const warn = mode !== "600" ? "  ⚠️ expected 600" : "";
    console.log(`  ${f.padEnd(18)} ${fmt(s.size).padStart(9)}  mode ${mode}${warn}`);
  }

  console.log(`\nPrivacy:`);
  console.log(`  Secrets are redacted at write time (bearer tokens + key=value credentials → «redacted»).`);
  if (rest.includes("--secrets")) {
    let hits = 0;
    try {
      const text = readFileSync(join(store.dir, "activity.jsonl"), "utf8");
      hits = (text.match(/AIza[\w-]{30,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[\w-]{10,}/g) ?? []).length;
    } catch { /* no log */ }
    console.log(`  --secrets scan: ${hits === 0 ? "no known secret patterns in the activity log ✓" : `⚠️ ${hits} secret-like string(s) found — review/redact`}`);
  } else {
    console.log(`  Scan with 'keyoku inspect --secrets' (tripwire for write-time redaction).`);
  }
  console.log(`  Scope/stop: 'keyoku pause'.  Wipe everything: delete ${store.dir}.`);
}

/** Deterministic floor for refine: map a learned workflow's steps to runnable
 *  template steps, dropping omission markers and collapsing consecutive dups. */
function collapseStepsForTemplate(steps: WorkflowStep[]): WorkflowStepTemplate[] {
  const out: WorkflowStepTemplate[] = [];
  let lastKey = "";
  for (const s of steps) {
    if (/intermediate step(s)? omitted/.test(s.summary)) continue;
    const key = `${s.tool ?? ""}:${s.summary}`;
    if (key === lastKey) continue;
    lastKey = key;
    if ((s.tool === "Bash" || /^Bash:/.test(s.summary)) && s.detail) {
      out.push({ type: "bash", summary: s.summary.slice(0, 100), command: s.detail.slice(0, 500) });
    } else {
      out.push({ type: "agent_prompt", summary: s.summary.slice(0, 100), prompt: `Perform: ${s.summary}` });
    }
  }
  return out;
}

/** SLM polish: name, de-noise, merge dups, and {{parameterize}} run-specific
 *  values. Returns null on any failure so the deterministic floor stands. */
async function slmRefine(
  slm: NonNullable<ReturnType<typeof resolveSlmFromEnv>>,
  objective: string,
  draft: WorkflowStepTemplate[],
): Promise<{ name: string; description: string; steps: WorkflowStepTemplate[] } | null> {
  const list = draft.map((s, i) => `${i + 1}. [${s.type}] ${s.summary}${s.command ? ` :: ${s.command}` : ""}`).join("\n");
  const prompt = `Refine this learned workflow into a clean, reusable template.\nObjective: ${objective}\nRaw steps:\n${list}\n\nDrop inspection/noise, merge duplicates, keep the essential ordered actions, and replace run-specific values (paths, names, messages) with {{placeholders}}. Keep bash commands runnable. Return ONLY JSON: {"name": string, "description": string, "steps": [{"type":"bash"|"agent_prompt","summary":string,"command"?:string,"prompt"?:string}]}.`;
  const raw = await slm.complete(prompt, { json: true, maxTokens: 1200 });
  const parsed = JSON.parse(raw.replace(/```[a-zA-Z]*/g, "").trim()) as {
    name?: unknown; description?: unknown; steps?: unknown;
  };
  if (!Array.isArray(parsed.steps)) return null;
  const steps = parsed.steps
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .filter((s) => (s.type === "bash" || s.type === "agent_prompt") && typeof s.summary === "string")
    .map((s) => ({
      type: s.type as "bash" | "agent_prompt",
      summary: String(s.summary).slice(0, 100),
      ...(typeof s.command === "string" ? { command: s.command.slice(0, 500) } : {}),
      ...(typeof s.prompt === "string" ? { prompt: s.prompt } : {}),
    }));
  if (steps.length === 0) return null;
  return {
    name: (typeof parsed.name === "string" && parsed.name.trim()) || "refined workflow",
    description: (typeof parsed.description === "string" && parsed.description.trim()) || objective,
    steps,
  };
}

/** Turn a raw/backfilled workflow into a clean, parameterized template. Prints a
 *  reviewable draft; `--apply` saves it as a runnable template (workflow_execute). */
async function refineCmd(rest: string[]): Promise<void> {
  const slug = rest.find((a) => !a.startsWith("-"));
  if (!slug) {
    console.error("Usage: keyoku refine <workflow-slug> [--apply]   (list slugs with: keyoku inspect)");
    process.exitCode = 1;
    return;
  }
  const apply = rest.includes("--apply");
  const harness = buildHarness();
  const wf = harness.store.getWorkflow(slug);
  if (!wf) {
    console.error(`No workflow '${slug}'.`);
    process.exitCode = 1;
    return;
  }
  const draft = collapseStepsForTemplate(wf.steps);
  let name = wf.slug;
  let description = wf.objective;
  let refined = draft;
  const slm = resolveSlmFromEnv();
  if (slm) {
    try {
      const polished = await slmRefine(slm, wf.objective, draft);
      if (polished) ({ name, description, steps: refined } = polished);
    } catch { /* keep the deterministic draft */ }
  }
  console.log(`keyoku refine ${slug} — ${wf.steps.length} raw steps → ${refined.length} refined${slm ? " (SLM-polished)" : " (deterministic)"}\n`);
  console.log(`name: ${name}\ndesc: ${description}\nsteps:`);
  refined.forEach((s, i) => console.log(`  ${i + 1}. [${s.type}] ${s.summary}${s.command ? ` :: ${s.command}` : ""}`));
  if (!apply) {
    console.log(`\nReview, then save with: keyoku refine ${slug} --apply  (or workflow_approve via MCP).`);
    return;
  }
  const now = new Date().toISOString();
  const existing = harness.store.getTemplate(slug);
  const template: WorkflowTemplate = existing
    ? { ...existing, name, description, steps: refined, updatedAt: now }
    : {
        id: newId("tmpl"),
        slug,
        name,
        description,
        steps: refined,
        trigger: { type: "on_demand" },
        approvedAt: now,
        createdAt: now,
        updatedAt: now,
        timesRun: 0,
      };
  harness.store.saveTemplate(template);
  console.log(`\nSaved template '${slug}'. Run it with: workflow_execute { slug: "${slug}" }`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd ?? "serve") {
    case "serve":
      return serve();
    case "status":
      return status();
    case "project":
      return projectCmd(rest);
    case "proof":
      return proofCmd(rest);
    case "demo":
      return demoCmd(rest);
    case "deck":
      return deckCmd(rest);
    case "arch":
      return archCmd(rest);
    case "outcome":
      return outcomeCmd(rest);
    case "contribution":
      return contributionCmd(rest);
    case "gate":
      return gateCmd(rest);
    case "factfile":
      return factfileCmd(rest);
    case "pulse":
      return pulseCmd(rest);
    case "iterate":
      return iterationCmd(rest);
    case "assess":
      return assess(rest[0]);
    case "watch":
      return watch(rest[0], rest);
    case "learn":
      return learn();
    case "focus":
      return focusCmd(rest);
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
    case "inspect":
      return inspect(rest);
    case "refine":
      return refineCmd(rest);
    case "backfill":
    case "repair":
      return backfillCmd(rest);
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

function isCliEntrypoint(): boolean {
  const argvEntry = process.argv[1];
  if (!argvEntry) return false;
  const here = fileURLToPath(import.meta.url);
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(argvEntry) === real(here);
}

if (isCliEntrypoint()) {
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
}
