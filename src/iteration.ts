import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  ActorSchema,
  findProjectRoot,
  loadOutcome,
  runGate,
  startContribution,
  type Actor,
  type GateSnapshot,
} from "./contribution.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);

export const IterationUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
});

export const IterationLimitsSchema = z.object({
  maxRounds: z.number().int().min(1).max(100).default(5),
  maxDurationMs: z.number().int().min(1_000).max(86_400_000).default(3_600_000),
  maxNoProgressRounds: z.number().int().min(1).max(20).default(2),
  maxTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
});

export const IterationInstructionSchema = z.object({
  round: z.number().int().positive(),
  objective: z.string().min(1),
  constraints: z.array(z.string()),
  exactSource: z.object({
    headSha: z.string().min(1),
    worktreeDigest: DigestSchema,
    dirty: z.boolean(),
  }),
  failedClaims: z.array(z.object({
    index: z.number().int().nonnegative(),
    description: z.string().min(1),
    reproduce: z.string().min(1),
    actual: z.unknown().optional(),
    error: z.string().optional(),
    note: z.string().optional(),
  })).min(1),
  regressedClaims: z.array(z.number().int().nonnegative()),
  direction: z.string().min(1),
  checkpoint: z.string().min(1),
});

export const IterationRoundSchema = z.object({
  number: z.number().int().positive(),
  contributionId: SlugSchema,
  factfilePath: z.string().min(1),
  factfileDigest: DigestSchema,
  generatedAt: z.string().datetime(),
  repository: z.object({
    headSha: z.string().min(1),
    worktreeDigest: DigestSchema,
    dirty: z.boolean(),
    changedFiles: z.array(z.string()),
  }),
  gateState: z.enum(["evidence_gaps", "human_review_required", "review_blocked", "ready_for_review", "accepted"]),
  automated: z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), verified: z.boolean() }),
  humanReview: z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  passedClaimIndexes: z.array(z.number().int().nonnegative()),
  failedClaimIndexes: z.array(z.number().int().nonnegative()),
  regressedClaimIndexes: z.array(z.number().int().nonnegative()),
  noProgressRounds: z.number().int().nonnegative(),
});

const IterationStatusSchema = z.enum([
  "evaluating",
  "awaiting_agent",
  "ready_for_review",
  "human_review_required",
  "review_blocked",
  "stopped_round_limit",
  "stopped_time_limit",
  "stopped_no_progress",
  "stopped_token_limit",
  "stopped_cost_limit",
]);

const StartedPayloadSchema = z.object({
  outcomeId: SlugSchema,
  outcomeRevision: z.number().int().positive(),
  contributionId: SlugSchema,
  baseSha: z.string().min(1),
  limits: IterationLimitsSchema,
  actor: ActorSchema.optional(),
});

const AgentCheckpointPayloadSchema = z.object({
  checkpointId: SlugSchema,
  summary: z.string().min(1),
  usage: IterationUsageSchema,
  usageSource: z.enum(["agent_reported", "provider_receipt", "unknown"]),
});

const StopPayloadSchema = z.object({
  status: IterationStatusSchema.exclude(["evaluating", "awaiting_agent"]),
  reason: z.string().min(1),
});

export const IterationEventSchema = z.object({
  schemaVersion: z.literal("keyoku.dev/iteration-event/v1alpha1"),
  sessionId: SlugSchema,
  sequence: z.number().int().nonnegative(),
  at: z.string().datetime(),
  type: z.enum(["started", "agent_checkpointed", "round_completed", "instruction_issued", "stopped"]),
  payload: z.unknown(),
  previousDigest: DigestSchema.optional(),
  digest: DigestSchema,
});

export type IterationUsage = z.infer<typeof IterationUsageSchema>;
export type IterationLimits = z.infer<typeof IterationLimitsSchema>;
export type IterationInstruction = z.infer<typeof IterationInstructionSchema>;
export type IterationRound = z.infer<typeof IterationRoundSchema>;
export type IterationEvent = z.infer<typeof IterationEventSchema>;
export type IterationStatus = z.infer<typeof IterationStatusSchema>;

export interface IterationState {
  id: string;
  root: string;
  outcomeId: string;
  outcomeRevision: number;
  contributionId: string;
  baseSha: string;
  startedAt: string;
  limits: IterationLimits;
  actor?: Actor;
  status: IterationStatus;
  rounds: IterationRound[];
  currentInstruction?: IterationInstruction;
  checkpoints: Array<z.infer<typeof AgentCheckpointPayloadSchema>>;
  usage: IterationUsage;
  stopReason?: string;
  eventCount: number;
  ledgerDigest: string;
}

export interface StartIterationInput {
  root?: string;
  outcomeId: string;
  limits?: Partial<IterationLimits>;
  actor?: Actor;
  baseSha?: string;
}

export interface CheckpointIterationInput {
  root?: string;
  sessionId: string;
  checkpointId: string;
  summary: string;
  usage?: Partial<IterationUsage>;
  usageSource?: "agent_reported" | "provider_receipt" | "unknown";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function slug(value: string): string {
  const normalized = value.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return normalized || "iteration";
}

function iterationDir(root: string, sessionId: string): string {
  return join(root, ".keyoku", "runtime", "iterations", sessionId);
}

function eventPath(root: string, sessionId: string): string {
  return join(iterationDir(root, sessionId), "events.jsonl");
}

function parsePayload(event: IterationEvent): unknown {
  switch (event.type) {
    case "started": return StartedPayloadSchema.parse(event.payload);
    case "agent_checkpointed": return AgentCheckpointPayloadSchema.parse(event.payload);
    case "round_completed": return IterationRoundSchema.parse(event.payload);
    case "instruction_issued": return IterationInstructionSchema.parse(event.payload);
    case "stopped": return StopPayloadSchema.parse(event.payload);
  }
}

function sealEvent(input: Omit<IterationEvent, "digest">): IterationEvent {
  return IterationEventSchema.parse({ ...input, digest: digest(input) });
}

function appendEvent(root: string, sessionId: string, type: IterationEvent["type"], payload: unknown): IterationEvent {
  const events = readIterationEvents(root, sessionId, false);
  const previous = events.at(-1);
  const event = sealEvent({
    schemaVersion: "keyoku.dev/iteration-event/v1alpha1",
    sessionId,
    sequence: events.length,
    at: new Date().toISOString(),
    type,
    payload,
    ...(previous ? { previousDigest: previous.digest } : {}),
  });
  mkdirSync(iterationDir(root, sessionId), { recursive: true });
  appendFileSync(eventPath(root, sessionId), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  return event;
}

export function readIterationEvents(rootInput: string | undefined, sessionId: string, requireExisting = true): IterationEvent[] {
  const root = findProjectRoot(rootInput);
  const path = eventPath(root, sessionId);
  if (!existsSync(path)) {
    if (requireExisting) throw new Error(`Unknown iteration session '${sessionId}'.`);
    return [];
  }
  const events = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line, index) => {
    let parsed: IterationEvent;
    try { parsed = IterationEventSchema.parse(JSON.parse(line)); }
    catch (error) { throw new Error(`Invalid iteration event ${index}: ${error instanceof Error ? error.message : String(error)}`); }
    if (parsed.sessionId !== sessionId || parsed.sequence !== index) throw new Error(`Iteration ledger sequence mismatch at event ${index}.`);
    parsePayload(parsed);
    const { digest: claimed, ...unsigned } = parsed;
    if (digest(unsigned) !== claimed) throw new Error(`Iteration ledger digest mismatch at event ${index}.`);
    return parsed;
  });
  for (let index = 0; index < events.length; index += 1) {
    const expected = index ? events[index - 1]!.digest : undefined;
    if (events[index]!.previousDigest !== expected) throw new Error(`Iteration ledger chain mismatch at event ${index}.`);
  }
  return events;
}

function zeroUsage(): IterationUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, toolCalls: 0, costUsd: 0 };
}

function addUsage(total: IterationUsage, next: IterationUsage): IterationUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cachedInputTokens: total.cachedInputTokens + next.cachedInputTokens,
    toolCalls: total.toolCalls + next.toolCalls,
    costUsd: Number((total.costUsd + next.costUsd).toFixed(8)),
  };
}

export function readIteration(rootInput: string | undefined, sessionId: string): IterationState {
  const root = findProjectRoot(rootInput);
  const events = readIterationEvents(root, sessionId);
  const first = events[0];
  if (!first || first.type !== "started") throw new Error(`Iteration session '${sessionId}' has no start event.`);
  const started = StartedPayloadSchema.parse(first.payload);
  const state: IterationState = {
    id: sessionId,
    root,
    outcomeId: started.outcomeId,
    outcomeRevision: started.outcomeRevision,
    contributionId: started.contributionId,
    baseSha: started.baseSha,
    startedAt: first.at,
    limits: started.limits,
    ...(started.actor ? { actor: started.actor } : {}),
    status: "evaluating",
    rounds: [],
    checkpoints: [],
    usage: zeroUsage(),
    eventCount: events.length,
    ledgerDigest: events.at(-1)!.digest,
  };
  for (const event of events.slice(1)) {
    if (event.type === "agent_checkpointed") {
      const checkpoint = AgentCheckpointPayloadSchema.parse(event.payload);
      state.checkpoints.push(checkpoint);
      state.usage = addUsage(state.usage, checkpoint.usage);
      state.status = "evaluating";
    } else if (event.type === "round_completed") {
      state.rounds.push(IterationRoundSchema.parse(event.payload));
    } else if (event.type === "instruction_issued") {
      state.currentInstruction = IterationInstructionSchema.parse(event.payload);
      state.status = "awaiting_agent";
    } else if (event.type === "stopped") {
      const stopped = StopPayloadSchema.parse(event.payload);
      state.status = stopped.status;
      state.stopReason = stopped.reason;
      delete state.currentInstruction;
    }
  }
  return state;
}

function failedClaims(snapshot: GateSnapshot): IterationInstruction["failedClaims"] {
  return snapshot.evidence.flatMap((criterion, index) => criterion.pass ? [] : [{
    index,
    description: criterion.description,
    reproduce: criterion.verification.reproduce,
    ...(criterion.actual !== undefined ? { actual: criterion.actual } : {}),
    ...(criterion.error ? { error: criterion.error } : {}),
    ...(criterion.note ? { note: criterion.note } : {}),
  }]);
}

function buildInstruction(snapshot: GateSnapshot, round: IterationRound, sessionId: string): IterationInstruction {
  return IterationInstructionSchema.parse({
    round: round.number,
    objective: snapshot.outcome.objective,
    constraints: snapshot.outcome.constraints,
    exactSource: {
      headSha: snapshot.repository.headSha,
      worktreeDigest: snapshot.repository.worktreeDigest,
      dirty: snapshot.repository.dirty,
    },
    failedClaims: failedClaims(snapshot),
    regressedClaims: round.regressedClaimIndexes,
    direction: "Change only the product and tests needed to make the failed claims observably true. Do not edit proof output, do not record human judgments, and do not claim completion from agent activity.",
    checkpoint: `After the work is coherent, call iteration_checkpoint for session '${sessionId}' using a unique idempotency key. Keyoku will rerun the repository-owned probes against the new exact source state.`,
  });
}

function stopStatus(snapshot: GateSnapshot, state: IterationState, round: IterationRound): z.infer<typeof StopPayloadSchema> | undefined {
  if (snapshot.summary.verified) {
    if (snapshot.humanReview.failed > 0) return { status: "review_blocked", reason: "Automated evidence passes, but at least one accountable human criterion is recorded as failed." };
    if (snapshot.humanReview.pending > 0) return { status: "human_review_required", reason: "Automated evidence passes. Declared human judgments remain pending and cannot be filled by the iteration controller." };
    return { status: "ready_for_review", reason: "All automated and declared human criteria pass for the exact recorded source snapshot. Final acceptance still belongs to an accountable human." };
  }
  const elapsed = Date.now() - Date.parse(state.startedAt);
  if (round.number >= state.limits.maxRounds) return { status: "stopped_round_limit", reason: `Stopped after the configured ${state.limits.maxRounds} proof rounds.` };
  if (elapsed >= state.limits.maxDurationMs) return { status: "stopped_time_limit", reason: `Stopped after exceeding the configured ${state.limits.maxDurationMs}ms duration.` };
  if (round.noProgressRounds >= state.limits.maxNoProgressRounds) return { status: "stopped_no_progress", reason: `Stopped after ${round.noProgressRounds} consecutive checkpoints produced no source change.` };
  const totalTokens = state.usage.inputTokens + state.usage.outputTokens;
  if (state.limits.maxTokens !== undefined && totalTokens >= state.limits.maxTokens) return { status: "stopped_token_limit", reason: `Stopped at ${totalTokens} reported tokens, meeting or exceeding the configured ${state.limits.maxTokens} token ceiling.` };
  if (state.limits.maxCostUsd !== undefined && state.usage.costUsd >= state.limits.maxCostUsd) return { status: "stopped_cost_limit", reason: `Stopped at $${state.usage.costUsd.toFixed(6)} reported cost, meeting or exceeding the configured $${state.limits.maxCostUsd.toFixed(6)} ceiling.` };
  return undefined;
}

async function evaluateRound(root: string, sessionId: string): Promise<IterationState> {
  const before = readIteration(root, sessionId);
  const snapshot = await runGate(root, before.contributionId);
  const prior = before.rounds.at(-1);
  const passedClaimIndexes = snapshot.evidence.flatMap((item, index) => item.pass ? [index] : []);
  const failedClaimIndexes = snapshot.evidence.flatMap((item, index) => item.pass ? [] : [index]);
  const regressedClaimIndexes = prior?.passedClaimIndexes.filter((index) => failedClaimIndexes.includes(index)) ?? [];
  const noProgressRounds = prior && prior.repository.headSha === snapshot.repository.headSha && prior.repository.worktreeDigest === snapshot.repository.worktreeDigest
    ? prior.noProgressRounds + 1
    : 0;
  const round = IterationRoundSchema.parse({
    number: before.rounds.length + 1,
    contributionId: before.contributionId,
    factfilePath: resolve(root, ".keyoku", "contributions", before.contributionId, "factfile.json"),
    factfileDigest: snapshot.digest,
    generatedAt: snapshot.generatedAt,
    repository: {
      headSha: snapshot.repository.headSha,
      worktreeDigest: snapshot.repository.worktreeDigest,
      dirty: snapshot.repository.dirty,
      changedFiles: snapshot.repository.changedFiles,
    },
    gateState: snapshot.state,
    automated: snapshot.summary,
    humanReview: snapshot.humanReview,
    passedClaimIndexes,
    failedClaimIndexes,
    regressedClaimIndexes,
    noProgressRounds,
  });
  appendEvent(root, sessionId, "round_completed", round);
  const afterRound = readIteration(root, sessionId);
  const stopped = stopStatus(snapshot, afterRound, round);
  if (stopped) appendEvent(root, sessionId, "stopped", stopped);
  else appendEvent(root, sessionId, "instruction_issued", buildInstruction(snapshot, round, sessionId));
  return readIteration(root, sessionId);
}

export async function startIteration(input: StartIterationInput): Promise<IterationState> {
  const root = findProjectRoot(input.root);
  const outcome = loadOutcome(root, input.outcomeId);
  const limits = IterationLimitsSchema.parse(input.limits ?? {});
  const contribution = startContribution({
    root,
    outcomeId: outcome.id,
    title: `Behavior iteration: ${outcome.title}`,
    summary: "Keyoku-governed proof and repair loop",
    baseSha: input.baseSha,
    ...(input.actor ? { actor: input.actor } : {}),
  });
  const sessionId = slug(`${outcome.id}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`);
  appendEvent(root, sessionId, "started", StartedPayloadSchema.parse({
    outcomeId: outcome.id,
    outcomeRevision: outcome.revision,
    contributionId: contribution.id,
    baseSha: contribution.baseSha,
    limits,
    ...(input.actor ? { actor: input.actor } : {}),
  }));
  return evaluateRound(root, sessionId);
}

export async function checkpointIteration(input: CheckpointIterationInput): Promise<IterationState> {
  const root = findProjectRoot(input.root);
  const state = readIteration(root, input.sessionId);
  const checkpoint = AgentCheckpointPayloadSchema.parse({
    checkpointId: input.checkpointId,
    summary: input.summary,
    usage: IterationUsageSchema.parse(input.usage ?? {}),
    usageSource: input.usageSource ?? (input.usage ? "agent_reported" : "unknown"),
  });
  const duplicate = state.checkpoints.find((checkpoint) => checkpoint.checkpointId === input.checkpointId);
  if (duplicate) {
    if (stableJson(duplicate) !== stableJson(checkpoint)) throw new Error(`Checkpoint idempotency conflict for '${input.checkpointId}'.`);
    return state;
  }
  if (state.status !== "awaiting_agent") throw new Error(`Iteration '${state.id}' is ${state.status}; it is not accepting another agent checkpoint.`);
  appendEvent(root, state.id, "agent_checkpointed", checkpoint);
  return evaluateRound(root, state.id);
}

export function currentIterationInstruction(rootInput: string | undefined, sessionId: string): IterationInstruction | undefined {
  return readIteration(rootInput, sessionId).currentInstruction;
}
