import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildPulseFixture } from "./pulse-fixtures.js";
import {
  appendPulseEvent,
  planPulseDispatch,
  readPulseEvents,
  renderPulseProjection,
  replayPulseEvents,
  sealPulseEvent,
  verifyAndSealLocalCheckpoint,
  writePulseProjection,
  type PulseAudience,
  type PulseEvent,
} from "./pulse.js";

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

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseEvents(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const value = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(value)) throw new Error("Pulse input JSON must be an event array or JSONL.");
    return value;
  }
  return trimmed.split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as unknown; }
    catch (error) { throw new Error(`Invalid Pulse JSONL at input line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

function pulseHelp(): string {
  return `Keyoku Pulse — trusted progress across exact-source Factfiles

Usage:
  keyoku pulse fixture generic|processyard [--out events.jsonl] [--json]
  keyoku pulse ingest [--file events.jsonl|-] [--root DIR] [--json]
  keyoku pulse status [--root DIR] [--json]
  keyoku pulse plan [--root DIR] [--now ISO] [--stale-after-ms N] [--debounce-ms N] [--delivered DIGEST] [--json]
  keyoku pulse checkpoint publish --file draft.json [--root DIR] [--json]
  keyoku pulse render [--root DIR] [--audience stakeholder|developer|timeline|email|text|json] [--out FILE] [--json]

Pulse appends to .keyoku/pulse/events.jsonl. It plans and renders delivery;
it never sends email, Slack, Teams, webhook, or MCP messages by itself.

Adapter contract:
  Emit strict keyoku.dev/pulse-event/v1alpha1 JSONL for Codex, Claude Code,
  GitHub Actions/CI, stdin, webhooks, or any other harness. Event and source
  digests are mandatory. Use checkpoint publish to verify local Factfile bytes
  before a checkpoint_published event enters the ledger.`;
}

function numberFlag(argv: string[], flag: string, fallback: number): number {
  const raw = flagValue(argv, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a non-negative number.`);
  return value;
}

async function executePulseCommand(argv: string[]): Promise<unknown> {
  const [sub = "help", ...rest] = argv;
  const root = resolve(flagValue(rest, "--root") ?? process.cwd());
  if (sub === "help" || sub === "--help" || sub === "-h") return { kind: "help", text: pulseHelp() };
  if (sub === "fixture") {
    const name = rest.find((value) => !value.startsWith("--") && value !== flagValue(rest, "--out"));
    if (name !== "generic" && name !== "processyard") throw new Error("Usage: keyoku pulse fixture generic|processyard [--out events.jsonl]");
    const fixture = buildPulseFixture(name);
    const jsonl = `${fixture.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const out = flagValue(rest, "--out");
    if (out) writeFileSync(resolve(out), jsonl, "utf8");
    return { kind: "fixture", fixture, jsonl, out: out ? resolve(out) : undefined };
  }
  if (sub === "ingest") {
    const file = flagValue(rest, "--file") ?? "-";
    const raw = file === "-" ? await stdin() : readFileSync(resolve(file), "utf8");
    const events = parseEvents(raw);
    const results = events.map((event) => appendPulseEvent(root, event as Record<string, unknown>));
    return { kind: "ingest", root, path: results[0]?.path ?? resolve(root, ".keyoku", "pulse", "events.jsonl"), appended: results.filter((result) => result.status === "appended").length, deduplicated: results.filter((result) => result.status === "deduplicated").length, eventIds: results.map((result) => result.event.id) };
  }
  if (sub === "status") {
    const events = readPulseEvents(root);
    const state = replayPulseEvents(events);
    return {
      kind: "status",
      root,
      eventCount: events.length,
      leases: state.leases.map((lease) => ({ id: lease.lease.id, harness: lease.lease.harness, projectId: lease.lease.project.id, runId: lease.lease.runId, agentId: lease.lease.agent.id, task: lease.lease.task, state: lease.state, heartbeatAt: lease.heartbeatAt, latestCheckpointId: lease.latestCheckpointId, sourceDigest: lease.currentSource.verifiedDigest })),
      checkpoints: state.checkpoints.map((checkpoint) => ({ id: checkpoint.id, title: checkpoint.title, publishedAt: checkpoint.publishedAt, trigger: checkpoint.materialTrigger, sourceDigest: checkpoint.source.verifiedDigest, contentDigest: checkpoint.contentDigest })),
    };
  }
  if (sub === "plan") {
    return {
      kind: "plan",
      root,
      decision: planPulseDispatch({
        events: readPulseEvents(root),
        now: flagValue(rest, "--now"),
        staleAfterMs: numberFlag(rest, "--stale-after-ms", 5 * 60_000),
        debounceMs: numberFlag(rest, "--debounce-ms", 30_000),
        deliveredContentDigests: flagValues(rest, "--delivered"),
      }),
    };
  }
  if (sub === "checkpoint") {
    if (rest[0] !== "publish") throw new Error("Usage: keyoku pulse checkpoint publish --file draft.json [--root DIR]");
    const file = flagValue(rest, "--file");
    if (!file) throw new Error("--file is required for Pulse checkpoint publication.");
    const draft = JSON.parse(readFileSync(resolve(file), "utf8")) as { eventId?: unknown; checkpoint?: unknown };
    if (typeof draft.eventId !== "string" || !draft.checkpoint || typeof draft.checkpoint !== "object") throw new Error("Checkpoint draft requires eventId and checkpoint fields.");
    const checkpoint = verifyAndSealLocalCheckpoint(root, draft.checkpoint as Parameters<typeof verifyAndSealLocalCheckpoint>[1]);
    const event = sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: draft.eventId, type: "checkpoint_published", at: checkpoint.publishedAt, leaseId: checkpoint.leaseIds[0], checkpoint });
    const result = appendPulseEvent(root, event);
    return { kind: "checkpoint", root, status: result.status, event, path: result.path };
  }
  if (sub === "render") {
    const audience = (flagValue(rest, "--audience") ?? "stakeholder") as PulseAudience;
    if (!["stakeholder", "developer", "timeline", "email", "text", "json"].includes(audience)) throw new Error(`Unknown Pulse audience '${audience}'.`);
    const decision = planPulseDispatch({
      events: readPulseEvents(root),
      now: flagValue(rest, "--now"),
      staleAfterMs: numberFlag(rest, "--stale-after-ms", 5 * 60_000),
      debounceMs: numberFlag(rest, "--debounce-ms", 30_000),
      deliveredContentDigests: flagValues(rest, "--delivered"),
    });
    if (!decision.snapshot || !["send", "coalesce"].includes(decision.outcome)) throw new Error(`Pulse render refused dispatcher outcome '${decision.outcome}' (${decision.reasonCode}).`);
    const out = flagValue(rest, "--out");
    const output = out ? undefined : renderPulseProjection(decision.snapshot, audience);
    const path = out ? writePulseProjection(out, decision.snapshot, audience) : undefined;
    return { kind: "render", root, audience, decision, output, path };
  }
  throw new Error(`Unknown Pulse command '${sub}'.\n\n${pulseHelp()}`);
}

export async function pulseCmd(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  try {
    const result = await executePulseCommand(argv);
    if (json) {
      const serializable = result && typeof result === "object" ? { ...(result as Record<string, unknown>) } : result;
      if (serializable && typeof serializable === "object") {
        delete (serializable as Record<string, unknown>).jsonl;
        delete (serializable as Record<string, unknown>).output;
      }
      console.log(JSON.stringify({ ok: true, result: serializable }, null, 2));
      return;
    }
    const typed = result as { kind: string; text?: string; jsonl?: string; out?: string; fixture?: { description: string }; appended?: number; deduplicated?: number; eventCount?: number; leases?: unknown[]; checkpoints?: unknown[]; decision?: { outcome: string; reason: string; checkpointIds: string[] }; output?: string; path?: string; audience?: string; status?: string; event?: PulseEvent };
    if (typed.kind === "help") console.log(typed.text);
    else if (typed.kind === "fixture") {
      if (typed.out) console.log(`Wrote ${typed.fixture?.description}\n${typed.out}`);
      else process.stdout.write(typed.jsonl ?? "");
    } else if (typed.kind === "ingest") console.log(`Pulse ingested ${typed.appended} event(s); ${typed.deduplicated} deduplicated.`);
    else if (typed.kind === "status") console.log(`Keyoku Pulse\n${typed.eventCount} events · ${typed.leases?.length ?? 0} leases · ${typed.checkpoints?.length ?? 0} verified checkpoints`);
    else if (typed.kind === "plan") console.log(`${typed.decision?.outcome}: ${typed.decision?.reason}\n${typed.decision?.checkpointIds.join("\n") ?? ""}`.trim());
    else if (typed.kind === "checkpoint") console.log(`Pulse checkpoint ${typed.status}: ${typed.event?.id}\n${typed.path}`);
    else if (typed.kind === "render") {
      if (typed.path) console.log(`Rendered ${typed.audience}: ${typed.path}`);
      else process.stdout.write(typed.output ?? "");
    }
  } catch (error) {
    if (!json) throw error;
    console.log(JSON.stringify({ ok: false, error: { code: "pulse_error", message: error instanceof Error ? error.message : String(error) } }, null, 2));
    process.exitCode = 2;
  }
}
