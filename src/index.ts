import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  captureRepository,
  findProjectRoot,
  listOutcomes,
  publishFactfile,
  readVerifiedFactfile,
  renderFactfileGithubMarkdown,
  reviewContribution,
  runGate,
  startContribution,
} from "./contribution.js";
import { customizeProof, initProof } from "./project-profile.js";
import { evaluateEvidence } from "./assurance-adapter.js";
import { parseJsonBytesRejectDuplicateKeys } from "./canonical-json.js";
import { runProofDemo } from "./proof-demo.js";
import { PUBLIC_CLI_SURFACE, PUBLIC_MCP_SURFACE, type PublicCliCommand } from "./public-surface.js";
import { buildPublicServer, VERSION } from "./public-server.js";
import { pulseCmd } from "./pulse-cli.js";
import { startProofSessionServer } from "./session-server.js";

export {
  ActorSchema,
  ContributionManifestSchema,
  GateSnapshotSchema,
  OutcomeSchema,
  ProjectManifestSchema,
  ReviewEventSchema,
  captureRepository,
  findProjectRoot,
  initProject,
  listFactfileHistory,
  listOutcomeHistory,
  listOutcomes,
  loadContribution,
  loadOutcome,
  loadProject,
  publishFactfile,
  readVerifiedFactfile,
  renderFactfileGithubMarkdown,
  renderFactfileHtml,
  renderFactfileMarkdown,
  reviewContribution,
  runGate,
  startContribution,
  type Actor,
  type ContributionManifest,
  type FactfileHistoryItem,
  type GateSnapshot,
  type Outcome,
  type ProjectManifest,
  type ReviewEvent,
  type VerifiedFactfileExpectations,
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
export { customizeProof, detectProject, initProof, renderGithubWorkflow, type ProjectKind, type ProjectProfile } from "./project-profile.js";
export { buildPublicServer, VERSION } from "./public-server.js";
export { PUBLIC_CLI_SURFACE, PUBLIC_MCP_SURFACE, LEGACY_SURFACE_POLICY } from "./public-surface.js";
export { startProofSessionServer, type ProofSessionServer } from "./session-server.js";
export * from "./canonical-json.js";
export * from "./assurance-adapter.js";
export * from "./pulse.js";
export * from "./pulse-fixtures.js";
export * from "./pulse-conformance.js";

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function flagValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  argv.forEach((value, index) => {
    if (value === flag && argv[index + 1] && !argv[index + 1]!.startsWith("--")) values.push(argv[index + 1]!);
  });
  return values;
}

function help(): void {
  const commands = PUBLIC_CLI_SURFACE.map((command) => `  keyoku ${command.name.padEnd(10)} ${command.summary}`).join("\n");
  console.log(`Keyoku v${VERSION} — exact-revision proof and trusted progress for agent work

Usage:
  keyoku <command> [options]

Public commands:
${commands}

Start here:
  keyoku proof demo --open
  keyoku proof init
  keyoku proof run <outcome>
  keyoku proof serve <contribution>

Boundaries:
  Keyoku verifies repository-owned checks; it does not run an agent.
  Assurance is an optional caller-selected adapter, not an agent protocol.
  MCP can report work and request decisions, but cannot accept human review.
  Pulse plans and renders updates; it never sends to a channel by itself.

Use 'keyoku proof --help', 'keyoku factfile --help', or 'keyoku pulse help' for details.`);
}

function proofHelp(): void {
  console.log(`Keyoku proof — one bounded outcome, one exact-source Factfile

Usage:
  keyoku proof demo [--dir DIR] [--open]
  keyoku proof init [--outcome ID] [--title TEXT] [--objective TEXT] [--check COMMAND]
  keyoku proof customize <outcome> [common outcome options]
  keyoku proof run <outcome> [--base REF] [--summary TEXT] [--new]
  keyoku proof ci <outcome> [--base REF] [--summary TEXT]
  keyoku proof serve <contribution> [--port NUMBER] [--no-open]
  keyoku proof review <contribution> --reviewer NAME --comment TEXT [--criterion ID --verdict pass|fail]
  keyoku proof accept <contribution> --reviewer NAME --comment TEXT

Only an identified human may use review or accept. Any source change makes the
current Factfile stale and requires a new proof run.`);
}

async function proofCmd(rest: string[]): Promise<void> {
  const sub = rest[0] ?? "help";
  if (["help", "--help", "-h"].includes(sub)) return proofHelp();
  if (sub === "demo") {
    const directory = flagValue(rest, "--dir");
    await runProofDemo({ ...(directory ? { root: directory } : {}), open: rest.includes("--open"), log: (line) => console.log(line) });
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
    if (!outcomeId || outcomeId.startsWith("-")) throw new Error("Usage: keyoku proof customize <outcome> [--title TEXT] [--objective TEXT] [--check COMMAND --claim TEXT --why TEXT] [--decision QUESTION --decision-id ID --guidance TEXT] [--include GLOB] [--exclude GLOB] [--max-files N]");
    const maxFilesValue = flagValue(rest, "--max-files");
    const maxChangedFiles = maxFilesValue === undefined ? undefined : Number(maxFilesValue);
    if (maxChangedFiles !== undefined && (!Number.isInteger(maxChangedFiles) || maxChangedFiles <= 0)) throw new Error("--max-files must be a positive integer.");
    const include = flagValues(rest, "--include");
    const exclude = flagValues(rest, "--exclude");
    const hasEdits = ["--title", "--objective", "--check", "--decision", "--include", "--exclude", "--max-files"].some((flag) => rest.includes(flag));
    if (!hasEdits) {
      const outcome = listOutcomes(findProjectRoot()).find((candidate) => candidate.id === outcomeId);
      if (!outcome) throw new Error(`Unknown outcome '${outcomeId}'.`);
      console.log(`${outcome.title} · revision ${outcome.revision}\n\nOutcome\n  ${outcome.objective}\n\nAutomated claims (${outcome.criteria.length})\n${outcome.criteria.map((criterion, index) => `  ${index + 1}. ${criterion.description}`).join("\n")}\n\nHuman decisions (${outcome.humanCriteria.length})\n${outcome.humanCriteria.map((criterion, index) => `  ${index + 1}. ${criterion.description}`).join("\n") || "  None declared"}`);
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
    if (!contributionId || contributionId.startsWith("-")) throw new Error("Usage: keyoku proof serve <contribution> [--port NUMBER] [--no-open]");
    const rawPort = flagValue(rest, "--port");
    const port = rawPort === undefined ? undefined : Number(rawPort);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) throw new Error("--port must be an integer from 0 to 65535.");
    const session = await startProofSessionServer({ root: findProjectRoot(), contributionId, ...(port !== undefined ? { port } : {}) });
    console.log(`Keyoku live proof session\n${session.url}\n\nThe link is loopback-only, token-scoped, and valid only while this process runs.`);
    if (!rest.includes("--no-open")) {
      try {
        if (process.platform === "darwin") execFileSync("open", [session.url], { stdio: "ignore" });
        else if (process.platform === "win32") execFileSync("cmd", ["/c", "start", "", session.url], { stdio: "ignore" });
        else execFileSync("xdg-open", [session.url], { stdio: "ignore" });
      } catch { console.error("Could not open a browser automatically; use the URL above."); }
    }
    await new Promise<void>((done) => {
      const stop = () => { void session.close().finally(done); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  if (sub === "review" || sub === "accept") {
    const contributionId = rest[1];
    const reviewerName = flagValue(rest, "--reviewer")?.trim();
    const comment = flagValue(rest, "--comment")?.trim();
    if (!contributionId || !reviewerName || !comment) throw new Error(`Usage: keyoku proof ${sub} <contribution> --reviewer NAME --comment TEXT${sub === "review" ? " [--criterion ID --verdict pass|fail]" : ""}`);
    const verdict = flagValue(rest, "--verdict");
    if (verdict && verdict !== "pass" && verdict !== "fail") throw new Error("--verdict must be pass or fail.");
    const snapshot = reviewContribution({
      root: findProjectRoot(),
      contributionId,
      decision: sub === "accept" ? "accepted" : "note",
      comment,
      criterionId: flagValue(rest, "--criterion"),
      verdict: verdict as "pass" | "fail" | undefined,
      reviewer: { kind: "human", id: flagValue(rest, "--reviewer-id") ?? reviewerName, name: reviewerName, role: "reviewer" },
    });
    console.log(`${sub === "accept" ? "ACCEPTED" : "REVIEW RECORDED"} — ${snapshot.outcome.title}\nFactfile: ${resolve(findProjectRoot(), ".keyoku", "contributions", contributionId, "factfile.html")}`);
    return;
  }
  if (sub !== "run" && sub !== "ci") throw new Error(`Unknown proof command '${sub}'. Run 'keyoku proof --help'.`);
  const outcomeId = rest[1];
  if (!outcomeId || outcomeId.startsWith("-")) throw new Error(`Usage: keyoku proof ${sub} <outcome> [--base REF] [--summary TEXT]`);
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
  const directory = resolve(root, ".keyoku", "contributions", contribution.id);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderFactfileGithubMarkdown(snapshot), "utf8");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `state=${snapshot.state}\nfactfile=${directory}/factfile.html\n`, "utf8");
  console.log(`${snapshot.state.replaceAll("_", " ").toUpperCase()} — ${snapshot.summary.passed}/${snapshot.summary.total} automated claims; ${snapshot.humanReview.pending} human decisions pending\nContribution: ${contribution.id}\nFull Factfile: ${directory}/factfile.html`);
  if (["evidence_gaps", "review_blocked"].includes(snapshot.state) || (sub === "run" && !["ready_for_review", "accepted"].includes(snapshot.state))) process.exitCode = 1;
}

function factfileHelp(): void {
  console.log(`Keyoku Factfile — inspectable proof for one exact source checkpoint

Usage:
  keyoku factfile inspect <contribution> [--json]
  keyoku factfile verify <contribution> [--json]
  keyoku factfile assess --file evidence.json [--json]
  keyoku factfile publish <contribution> [--engine URL]

Inspect verifies the Factfile's schema and content digest. Verify additionally
requires the current Git head and worktree to match. Assess evaluates a neutral,
content-digested envelope without running commands or granting human approval.
Publication is explicit.`);
}

async function factfileCmd(rest: string[]): Promise<void> {
  const sub = rest[0] ?? "help";
  if (["help", "--help", "-h"].includes(sub)) return factfileHelp();
  if (sub === "assess") {
    const file = flagValue(rest, "--file");
    if (!file) throw new Error("Usage: keyoku factfile assess --file evidence.json [--json]");
    const input = parseJsonBytesRejectDuplicateKeys(readFileSync(resolve(file)), `Invalid evidence envelope ${resolve(file)}`);
    const assessment = evaluateEvidence(input);
    if (rest.includes("--json")) console.log(JSON.stringify({ ok: true, result: { kind: "assess", assessment } }, null, 2));
    else console.log(`${assessment.status.toUpperCase()} — ${assessment.workId ?? "invalid envelope"}\n${assessment.reasons.map((reason) => `- ${reason.message}`).join("\n")}`);
    if (assessment.status === "rejected" || assessment.status === "stale") process.exitCode = 1;
    return;
  }
  const contributionId = rest[1];
  if (!contributionId || contributionId.startsWith("-")) throw new Error(`Usage: keyoku factfile ${sub} <contribution>`);
  const root = findProjectRoot();
  if (sub === "publish") {
    const engine = flagValue(rest, "--engine") ?? process.env.KEYOKU_ENGINE_URL;
    if (!engine) throw new Error("Set KEYOKU_ENGINE_URL or pass --engine URL. Publishing is never automatic.");
    const result = await publishFactfile(root, contributionId, engine, process.env.KEYOKU_ENGINE_TOKEN ?? process.env.KEYOKU_SESSION_TOKEN);
    console.log(`Published ${contributionId} to ${engine}\n${JSON.stringify(result, null, 2)}`);
    return;
  }
  if (sub !== "inspect" && sub !== "verify") throw new Error(`Unknown Factfile command '${sub}'. Run 'keyoku factfile --help'.`);
  const path = resolve(root, ".keyoku", "contributions", contributionId, "factfile.json");
  if (!existsSync(path)) throw new Error(`No Factfile for '${contributionId}'. Run 'keyoku proof run <outcome>' first.`);
  const snapshot = readVerifiedFactfile(path, { contributionId });
  let sourceCurrent: boolean | undefined;
  if (sub === "verify") {
    const current = captureRepository(root, snapshot.repository.baseSha);
    sourceCurrent = current.headSha === snapshot.repository.headSha && current.worktreeDigest === snapshot.repository.worktreeDigest;
    if (!sourceCurrent) throw new Error("Factfile is authentic but stale: the current Git head or worktree no longer matches. Run proof again.");
  }
  const result = {
    contribution: contributionId,
    state: snapshot.state,
    declaredChecks: `${snapshot.summary.passed}/${snapshot.summary.total}`,
    humanDecisions: `${snapshot.humanReview.passed}/${snapshot.humanReview.total}`,
    digestVerified: true,
    ...(sourceCurrent !== undefined ? { sourceCurrent } : {}),
    path,
  };
  if (rest.includes("--json")) console.log(JSON.stringify({ ok: true, result }, null, 2));
  else console.log(`${sub === "verify" ? "VERIFIED CURRENT" : "AUTHENTIC FACTFILE"} — ${snapshot.outcome.title}\nState: ${snapshot.state}\nDeclared checks: ${result.declaredChecks}\nHuman decisions: ${result.humanDecisions}\n${path}`);
}

async function serve(): Promise<void> {
  const server = buildPublicServer();
  await server.connect(new StdioServerTransport());
  console.error(`keyoku v${VERSION} serving ${PUBLIC_MCP_SURFACE.length} bounded tools on stdio`);
}

function doctor(rest: string[]): void {
  let project: { root: string; outcomes: number } | null = null;
  try {
    const root = findProjectRoot();
    project = { root, outcomes: listOutcomes(root).length };
  } catch {
    project = null;
  }
  const engineUrl = process.env.KEYOKU_ENGINE_URL;
  const safeEngineUrl = engineUrl ? (() => {
    try {
      const url = new URL(engineUrl);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return "invalid URL";
    }
  })() : undefined;
  const supportedNode = Number(process.versions.node.split(".")[0]) >= 20;
  const report = {
    ok: supportedNode,
    version: VERSION,
    node: process.version,
    supportedNode,
    publicCliCommands: PUBLIC_CLI_SURFACE.map((item) => item.name),
    publicMcpTools: PUBLIC_MCP_SURFACE.map((item) => item.name),
    project,
    engine: safeEngineUrl ? { configured: true, url: safeEngineUrl } : { configured: false, required: false },
    boundaries: { runsAgent: false, sendsPulseDelivery: false, mcpCanAcceptHumanReview: false },
  };
  if (rest.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(`keyoku doctor v${VERSION}\n✓ Node ${process.versions.node}${report.supportedNode ? "" : " (Node 20+ required)"}\n✓ ${report.publicCliCommands.length} public CLI commands\n✓ ${report.publicMcpTools.length} bounded MCP tools\n${project ? `✓ Project: ${project.root} (${project.outcomes} outcome${project.outcomes === 1 ? "" : "s"})` : "· No Keyoku project in this directory"}\n${report.engine.configured ? `· Optional Engine configured: ${report.engine.url}` : "· Optional Engine not configured"}`);
  if (!report.supportedNode) process.exitCode = 2;
}

const COMMAND_HANDLERS: Record<PublicCliCommand, (rest: string[]) => void | Promise<void>> = {
  proof: proofCmd,
  factfile: factfileCmd,
  pulse: pulseCmd,
  serve,
  doctor,
  version: () => console.log(VERSION),
  help,
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const globalJson = argv[0] === "--json";
  if (globalJson) argv.shift();
  const requested = argv.shift() ?? "help";
  const alias = requested === "--help" || requested === "-h" ? "help" : requested === "--version" || requested === "-v" ? "version" : requested;
  if (!Object.prototype.hasOwnProperty.call(COMMAND_HANDLERS, alias)) {
    console.error(`Unknown command '${requested}'.\n`);
    help();
    process.exitCode = 2;
    return;
  }
  if (globalJson) argv.push("--json");
  await COMMAND_HANDLERS[alias as PublicCliCommand](argv);
}

function isCliEntrypoint(): boolean {
  const argvEntry = process.argv[1];
  if (!argvEntry) return false;
  const here = fileURLToPath(import.meta.url);
  const canonical = (path: string): string => {
    try { return realpathSync(path); }
    catch { return resolve(path); }
  };
  return canonical(argvEntry) === canonical(here);
}

if (isCliEntrypoint()) {
  main().catch((error) => {
    const detail = process.env.KEYOKU_DEBUG && error instanceof Error
      ? error.stack ?? error.message
      : error instanceof Error ? error.message : String(error);
    console.error(detail);
    process.exit(2);
  });
}
