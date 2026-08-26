import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import { bytesDigest, canonicalJson, canonicalJsonDigest } from "./canonical-json.js";
import { readVerifiedFactfile } from "./contribution.js";

const PULSE_DIR = join(".keyoku", "pulse");
const PULSE_EVENTS_FILE = "events.jsonl";
const HexShaSchema = z.string().regex(/^[a-f0-9]{7,64}$/, "must be a lowercase hexadecimal revision");
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a sha256 digest");
const TimestampSchema = z.string().datetime();
const IdSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

/** JSON with recursively sorted object keys is Keyoku Pulse's digest input. */
export function stablePulseJson(value: unknown): string {
  return canonicalJson(value);
}

export function pulseDigest(value: unknown): string {
  return canonicalJsonDigest(value);
}

export function pulseBytesDigest(value: Uint8Array): string {
  return bytesDigest(value);
}

function withoutKey<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

export const PulseSourceIdentitySchema = z.object({
  canonicalRoot: z.string().min(1).max(2_000),
  branch: z.string().min(1).max(500).optional(),
  baseSha: HexShaSchema.optional(),
  headSha: HexShaSchema,
  worktreeDigest: DigestSchema,
  ancestryShas: z.array(HexShaSchema).max(500).default([]),
  verifiedDigest: DigestSchema,
}).strict().superRefine((source, context) => {
  const expected = pulseDigest(withoutKey(source, "verifiedDigest"));
  if (source.verifiedDigest !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["verifiedDigest"], message: `does not match source identity (expected ${expected})` });
  }
});

export type PulseSourceIdentity = z.infer<typeof PulseSourceIdentitySchema>;

export function sealPulseSource(input: Omit<PulseSourceIdentity, "verifiedDigest">): PulseSourceIdentity {
  const unsigned = {
    ...input,
    ancestryShas: input.ancestryShas ?? [],
  };
  return PulseSourceIdentitySchema.parse({ ...unsigned, verifiedDigest: pulseDigest(unsigned) });
}

export function pulseSourcesCompatible(left: PulseSourceIdentity, right: PulseSourceIdentity): boolean {
  if (left.canonicalRoot !== right.canonicalRoot) return false;
  if (left.verifiedDigest === right.verifiedDigest) return true;
  return left.ancestryShas.includes(right.headSha) || right.ancestryShas.includes(left.headSha);
}

export const PulseLeaseStateSchema = z.enum(["working", "verifying", "blocked", "failed", "completed", "abandoned"]);
export type PulseLeaseState = z.infer<typeof PulseLeaseStateSchema>;

export const AgentActivityLeaseSchema = z.object({
  schemaVersion: z.literal("keyoku.dev/pulse-lease/v1alpha1"),
  id: IdSchema,
  harness: z.string().min(1).max(240),
  project: z.object({ id: IdSchema, name: z.string().min(1).max(500) }).strict(),
  runId: IdSchema,
  agent: z.object({ id: IdSchema, name: z.string().min(1).max(500), model: z.string().max(240).optional() }).strict(),
  canonicalSourceRoot: z.string().min(1).max(2_000),
  task: z.object({ id: IdSchema, title: z.string().min(1).max(1_000), outcome: z.string().min(1).max(4_000) }).strict(),
  startedAt: TimestampSchema,
  heartbeatAt: TimestampSchema,
  state: PulseLeaseStateSchema,
  currentSource: PulseSourceIdentitySchema,
  latestCheckpointId: IdSchema.optional(),
}).strict().superRefine((lease, context) => {
  if (lease.currentSource.canonicalRoot !== lease.canonicalSourceRoot) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["currentSource", "canonicalRoot"], message: "must match canonicalSourceRoot" });
  }
  if (Date.parse(lease.heartbeatAt) < Date.parse(lease.startedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["heartbeatAt"], message: "cannot precede startedAt" });
  }
});

export type AgentActivityLease = z.infer<typeof AgentActivityLeaseSchema>;

export const PulseDecisionRequestSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(1_000),
  whyHuman: z.string().min(1).max(4_000),
  requestedAction: z.string().min(1).max(4_000),
  options: z.array(z.string().min(1).max(1_000)).min(1).max(5).optional(),
}).strict();

export const PulseFactfileReferenceSchema = z.object({
  id: IdSchema,
  path: z.string().min(1).max(4_000),
  digest: DigestSchema,
  sourceDigest: DigestSchema,
  bytesDigest: DigestSchema.optional(),
  state: z.enum(["evidence_gaps", "human_review_required", "review_blocked", "ready_for_review", "accepted"]),
}).strict();

export const PulseEvidenceBindingSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("local_factfiles"),
    verifiedRoot: z.string().min(1).max(4_000),
  }).strict(),
  z.object({
    mode: z.literal("adapter_attested"),
    adapter: z.string().min(1).max(500),
    responsibility: z.string().min(1).max(4_000),
  }).strict(),
  z.object({
    mode: z.literal("fixture"),
    label: z.string().min(1).max(1_000),
  }).strict(),
]);

export const PulseVerificationSchema = z.object({
  status: z.literal("verified"),
  verifiedAt: TimestampSchema,
  methods: z.array(z.object({
    kind: z.enum(["command", "http", "mcp", "human"]),
    label: z.string().min(1).max(1_000),
    reproduce: z.string().min(1).max(8_000),
    result: z.string().min(1).max(4_000),
    evidenceDigest: DigestSchema.optional(),
  }).strict()).min(1).max(100),
}).strict();

export const PulseAssetSchema = z.object({
  kind: z.enum(["screenshot", "video", "poster", "trace", "report", "log", "code"]),
  path: z.string().min(1).max(4_000),
  label: z.string().min(1).max(1_000),
  caption: z.string().min(1).max(4_000),
  digest: DigestSchema.optional(),
  posterPath: z.string().min(1).max(4_000).optional(),
  posterDigest: DigestSchema.optional(),
}).strict();

export const PulseMaterialTriggerSchema = z.enum([
  "verified_checkpoint",
  "owner_decision",
  "regression_stopped",
  "deployment_incident",
  "recovery",
]);

const VerifiedCheckpointFields = z.object({
  schemaVersion: z.literal("keyoku.dev/pulse-checkpoint/v1alpha1"),
  id: IdSchema,
  projectId: IdSchema,
  runId: IdSchema,
  leaseIds: z.array(IdSchema).min(1).max(100),
  title: z.string().min(1).max(1_000),
  changeSummary: z.string().min(1).max(8_000),
  whyItMatters: z.string().min(1).max(8_000),
  publishedAt: TimestampSchema,
  source: PulseSourceIdentitySchema,
  verification: PulseVerificationSchema,
  evidenceBinding: PulseEvidenceBindingSchema,
  factfiles: z.array(PulseFactfileReferenceSchema).min(1).max(100),
  assets: z.array(PulseAssetSchema).max(100).default([]),
  limitations: z.array(z.string().min(1).max(4_000)).min(1).max(100),
  nextTask: z.string().min(1).max(4_000).optional(),
  humanDecisionRequest: PulseDecisionRequestSchema.optional(),
  materialTrigger: PulseMaterialTriggerSchema,
  contentDigest: DigestSchema,
}).strict();

export const VerifiedCheckpointSchema = VerifiedCheckpointFields.superRefine((checkpoint, context) => {
  if (new Set(checkpoint.leaseIds).size !== checkpoint.leaseIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["leaseIds"], message: "must not contain duplicates" });
  }
  checkpoint.factfiles.forEach((factfile, index) => {
    if (factfile.sourceDigest !== checkpoint.source.verifiedDigest) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["factfiles", index, "sourceDigest"], message: "must match the checkpoint source digest" });
    }
  });
  if (checkpoint.evidenceBinding.mode === "local_factfiles") {
    checkpoint.factfiles.forEach((factfile, index) => {
      if (!factfile.bytesDigest) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["factfiles", index, "bytesDigest"], message: "is required for locally verified Factfiles" });
      }
    });
    checkpoint.assets.forEach((asset, index) => {
      if (!asset.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets", index, "digest"], message: "is required for locally verified assets" });
      if (asset.posterPath && !asset.posterDigest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets", index, "posterDigest"], message: "is required for a locally verified poster" });
    });
  }
  const expected = pulseDigest(withoutKey(checkpoint, "contentDigest"));
  if (checkpoint.contentDigest !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["contentDigest"], message: `does not match checkpoint content (expected ${expected})` });
  }
});

export type VerifiedCheckpoint = z.infer<typeof VerifiedCheckpointSchema>;

export function sealVerifiedCheckpoint(input: Omit<VerifiedCheckpoint, "contentDigest">): VerifiedCheckpoint {
  const unsigned = { ...input, assets: input.assets ?? [] };
  return VerifiedCheckpointSchema.parse({ ...unsigned, contentDigest: pulseDigest(unsigned) });
}

type LocalCheckpointInput = Omit<VerifiedCheckpoint, "contentDigest" | "factfiles" | "evidenceBinding"> & {
  factfiles: Array<{ path: string }>;
};

/**
 * Promote local Factfile bytes into a Pulse checkpoint. A digest-shaped
 * reference is never sufficient: canonical Factfile content, its own digest,
 * and its exact head/worktree identity are all checked before sealing.
 */
export function verifyAndSealLocalCheckpoint(rootInput: string, input: LocalCheckpointInput): VerifiedCheckpoint {
  const root = resolve(rootInput);
  if (input.source.canonicalRoot !== root && input.source.canonicalRoot !== `file://${root}`) {
    throw new Error(`Checkpoint canonical source root '${input.source.canonicalRoot}' does not match verified root '${root}'.`);
  }
  const references = input.factfiles.map(({ path: pathInput }) => {
    const absolute = resolve(root, pathInput);
    const relativePath = relative(root, absolute);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`Factfile path is outside the verified root: ${pathInput}`);
    if (!existsSync(absolute)) throw new Error(`Factfile does not exist: ${relativePath}`);
    const bytes = readFileSync(absolute);
    const factfile = readVerifiedFactfile(absolute);
    if (resolve(factfile.repository.repositoryRoot) !== root || factfile.repository.headSha !== input.source.headSha || factfile.repository.worktreeDigest !== input.source.worktreeDigest) {
      throw new Error(`Factfile source does not match checkpoint source at ${relativePath}.`);
    }
    return PulseFactfileReferenceSchema.parse({
      id: factfile.id,
      path: relativePath,
      digest: factfile.digest,
      sourceDigest: input.source.verifiedDigest,
      bytesDigest: pulseBytesDigest(bytes),
      state: factfile.state,
    });
  });
  const assets = input.assets.map((asset) => {
    const absolute = resolve(root, asset.path);
    const relativePath = relative(root, absolute);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`Pulse asset path is outside the verified root: ${asset.path}`);
    if (!existsSync(absolute)) throw new Error(`Pulse asset does not exist: ${relativePath}`);
    const digest = pulseBytesDigest(readFileSync(absolute));
    if (asset.digest && asset.digest !== digest) throw new Error(`Pulse asset digest mismatch: ${relativePath}`);
    if (!asset.posterPath) return { ...asset, path: relativePath, digest };
    const posterAbsolute = resolve(root, asset.posterPath);
    const posterRelative = relative(root, posterAbsolute);
    if (posterRelative.startsWith("..") || isAbsolute(posterRelative)) throw new Error(`Pulse poster path is outside the verified root: ${asset.posterPath}`);
    if (!existsSync(posterAbsolute)) throw new Error(`Pulse poster does not exist: ${posterRelative}`);
    const posterDigest = pulseBytesDigest(readFileSync(posterAbsolute));
    if (asset.posterDigest && asset.posterDigest !== posterDigest) throw new Error(`Pulse poster digest mismatch: ${posterRelative}`);
    return { ...asset, path: relativePath, digest, posterPath: posterRelative, posterDigest };
  });
  return sealVerifiedCheckpoint({
    ...input,
    factfiles: references,
    assets,
    evidenceBinding: { mode: "local_factfiles", verifiedRoot: root },
  });
}

const EventIdentityFields = {
  schemaVersion: z.literal("keyoku.dev/pulse-event/v1alpha1"),
  id: IdSchema,
  at: TimestampSchema,
  eventDigest: DigestSchema,
} as const;

const StartedEventSchema = z.object({
  ...EventIdentityFields,
  type: z.literal("started"),
  leaseId: IdSchema,
  lease: AgentActivityLeaseSchema,
}).strict();
const HeartbeatEventSchema = z.object({
  ...EventIdentityFields,
  type: z.literal("heartbeat"),
  leaseId: IdSchema,
  state: z.enum(["working", "verifying", "blocked"]),
  source: PulseSourceIdentitySchema,
  latestCheckpointId: IdSchema.optional(),
}).strict();
const VerificationStartedEventSchema = z.object({
  ...EventIdentityFields,
  type: z.literal("verification_started"),
  leaseId: IdSchema,
  source: PulseSourceIdentitySchema,
}).strict();
const CheckpointPublishedEventSchema = z.object({
  ...EventIdentityFields,
  type: z.literal("checkpoint_published"),
  leaseId: IdSchema,
  checkpoint: VerifiedCheckpointSchema,
}).strict();
const BlockedEventSchema = z.object({
  ...EventIdentityFields,
  type: z.literal("blocked"),
  leaseId: IdSchema,
  source: PulseSourceIdentitySchema,
  reason: z.string().min(1).max(8_000),
  humanDecisionRequest: PulseDecisionRequestSchema.optional(),
}).strict();
const FailedEventSchema = z.object({
  ...EventIdentityFields,
  type: z.literal("failed"),
  leaseId: IdSchema,
  source: PulseSourceIdentitySchema,
  reason: z.string().min(1).max(8_000),
}).strict();
const CompletedEventSchema = z.object({
  ...EventIdentityFields,
  type: z.literal("completed"),
  leaseId: IdSchema,
  source: PulseSourceIdentitySchema,
  checkpointId: IdSchema,
}).strict();
const AbandonedEventSchema = z.object({
  ...EventIdentityFields,
  type: z.literal("abandoned"),
  leaseId: IdSchema,
  source: PulseSourceIdentitySchema,
  reason: z.string().min(1).max(8_000),
}).strict();

const PulseEventDiscriminatedSchema = z.discriminatedUnion("type", [
  StartedEventSchema,
  HeartbeatEventSchema,
  VerificationStartedEventSchema,
  CheckpointPublishedEventSchema,
  BlockedEventSchema,
  FailedEventSchema,
  CompletedEventSchema,
  AbandonedEventSchema,
]);

export const PulseEventSchema = PulseEventDiscriminatedSchema.superRefine((event, context) => {
  const expected = pulseDigest(withoutKey(event, "eventDigest"));
  if (event.eventDigest !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["eventDigest"], message: `does not match event content (expected ${expected})` });
  }
  if (event.type === "started" && event.lease.id !== event.leaseId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lease", "id"], message: "must match leaseId" });
  }
  if (event.type === "checkpoint_published" && !event.checkpoint.leaseIds.includes(event.leaseId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["checkpoint", "leaseIds"], message: "must include the publishing lease" });
  }
});

export type PulseEvent = z.infer<typeof PulseEventSchema>;

export function sealPulseEvent(input: Record<string, unknown>): PulseEvent {
  const unsigned = withoutKey(input, "eventDigest");
  return PulseEventSchema.parse({ ...unsigned, eventDigest: pulseDigest(unsigned) });
}

function pulseEventsPath(rootInput: string): string {
  return join(resolve(rootInput), PULSE_DIR, PULSE_EVENTS_FILE);
}

export interface PulseAppendResult {
  status: "appended" | "deduplicated";
  event: PulseEvent;
  path: string;
}

export function readPulseEvents(rootInput: string): PulseEvent[] {
  const path = pulseEventsPath(rootInput);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line, index) => {
    try {
      return PulseEventSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid Pulse event at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export function appendPulseEvent(rootInput: string, input: PulseEvent | Record<string, unknown>): PulseAppendResult {
  const root = resolve(rootInput);
  const event = PulseEventSchema.parse(input);
  const existing = readPulseEvents(root).find((candidate) => candidate.id === event.id);
  const path = pulseEventsPath(root);
  if (existing) {
    if (existing.eventDigest !== event.eventDigest) throw new Error(`Pulse event id '${event.id}' already exists with different content.`);
    return { status: "deduplicated", event: existing, path };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
  return { status: "appended", event, path };
}

export interface PulseLeaseProjection {
  lease: AgentActivityLease;
  state: PulseLeaseState;
  heartbeatAt: string;
  currentSource: PulseSourceIdentity;
  latestCheckpointId?: string;
  lastEventAt: string;
}

export interface PulseReplayState {
  leases: PulseLeaseProjection[];
  checkpoints: VerifiedCheckpoint[];
  events: PulseEvent[];
  latestTrustedCheckpoint?: VerifiedCheckpoint;
}

function ensureForwardSource(previous: PulseSourceIdentity, next: PulseSourceIdentity, eventId: string): void {
  if (!pulseSourcesCompatible(previous, next)) {
    throw new Error(`Pulse event '${eventId}' conflicts with the lease's canonical source ancestry.`);
  }
  if (previous.verifiedDigest !== next.verifiedDigest && !next.ancestryShas.includes(previous.headSha)) {
    throw new Error(`Pulse event '${eventId}' moves source backward or omits the previous head from ancestry.`);
  }
}

export function replayPulseEvents(input: PulseEvent[]): PulseReplayState {
  const parsed = input.map((event) => PulseEventSchema.parse(event));
  const unique = new Map<string, PulseEvent>();
  for (const event of parsed) {
    const existing = unique.get(event.id);
    if (existing && existing.eventDigest !== event.eventDigest) throw new Error(`Pulse event id '${event.id}' has conflicting content in replay.`);
    if (!existing) unique.set(event.id, event);
  }
  const rank: Record<PulseEvent["type"], number> = {
    started: 0,
    heartbeat: 1,
    verification_started: 1,
    checkpoint_published: 2,
    blocked: 3,
    failed: 3,
    completed: 3,
    abandoned: 3,
  };
  const events = [...unique.values()].sort((left, right) => left.at.localeCompare(right.at) || rank[left.type] - rank[right.type] || left.id.localeCompare(right.id));
  const orderingKeys = new Map<string, PulseEvent>();
  for (const event of events) {
    const key = `${event.leaseId}|${event.at}|${rank[event.type]}`;
    const existing = orderingKeys.get(key);
    if (existing) throw new Error(`Pulse events '${existing.id}' and '${event.id}' have ambiguous ordering for lease '${event.leaseId}' at ${event.at}.`);
    orderingKeys.set(key, event);
  }
  const leases = new Map<string, PulseLeaseProjection>();
  const checkpoints = new Map<string, VerifiedCheckpoint>();
  for (const event of events) {
    if (event.type === "started") {
      if (leases.has(event.leaseId)) throw new Error(`Pulse lease '${event.leaseId}' started more than once.`);
      leases.set(event.leaseId, {
        lease: event.lease,
        state: event.lease.state,
        heartbeatAt: event.lease.heartbeatAt,
        currentSource: event.lease.currentSource,
        latestCheckpointId: event.lease.latestCheckpointId,
        lastEventAt: event.at,
      });
      continue;
    }
    const projection = leases.get(event.leaseId);
    if (!projection) throw new Error(`Pulse event '${event.id}' references unknown lease '${event.leaseId}'.`);
    if (Date.parse(event.at) < Date.parse(projection.lastEventAt)) throw new Error(`Pulse event '${event.id}' is out of order for lease '${event.leaseId}'.`);
    if (event.type === "heartbeat") {
      ensureForwardSource(projection.currentSource, event.source, event.id);
      projection.currentSource = event.source;
      projection.heartbeatAt = event.at;
      projection.state = event.state;
      projection.latestCheckpointId = event.latestCheckpointId ?? projection.latestCheckpointId;
    } else if (event.type === "verification_started") {
      ensureForwardSource(projection.currentSource, event.source, event.id);
      projection.currentSource = event.source;
      projection.heartbeatAt = event.at;
      projection.state = "verifying";
    } else if (event.type === "checkpoint_published") {
      ensureForwardSource(projection.currentSource, event.checkpoint.source, event.id);
      const prior = checkpoints.get(event.checkpoint.id);
      if (prior && prior.contentDigest !== event.checkpoint.contentDigest) throw new Error(`Checkpoint id '${event.checkpoint.id}' has conflicting content.`);
      checkpoints.set(event.checkpoint.id, event.checkpoint);
      projection.currentSource = event.checkpoint.source;
      projection.heartbeatAt = event.at;
      projection.latestCheckpointId = event.checkpoint.id;
    } else {
      ensureForwardSource(projection.currentSource, event.source, event.id);
      projection.currentSource = event.source;
      projection.heartbeatAt = event.at;
      if (event.type === "blocked") projection.state = "blocked";
      if (event.type === "failed") projection.state = "failed";
      if (event.type === "abandoned") projection.state = "abandoned";
      if (event.type === "completed") {
        const checkpoint = checkpoints.get(event.checkpointId);
        if (!checkpoint) throw new Error(`Pulse completion '${event.id}' references unknown checkpoint '${event.checkpointId}'.`);
        if (checkpoint.source.verifiedDigest !== event.source.verifiedDigest) throw new Error(`Pulse completion '${event.id}' source does not match its checkpoint.`);
        projection.latestCheckpointId = checkpoint.id;
        projection.state = "completed";
      }
    }
    projection.lastEventAt = event.at;
  }
  const checkpointList = [...checkpoints.values()].sort((left, right) => left.publishedAt.localeCompare(right.publishedAt) || left.id.localeCompare(right.id));
  return {
    leases: [...leases.values()].sort((left, right) => left.lease.id.localeCompare(right.lease.id)),
    checkpoints: checkpointList,
    events,
    latestTrustedCheckpoint: checkpointList.at(-1),
  };
}

export const PulseDispatchOutcomeSchema = z.enum(["send", "defer", "deduplicate", "suppress", "coalesce", "stale_no_send"]);
export type PulseDispatchOutcome = z.infer<typeof PulseDispatchOutcomeSchema>;

export interface PulseContentSnapshot {
  schemaVersion: "keyoku.dev/pulse-snapshot/v1alpha1";
  id: string;
  projectId: string;
  asOf: string;
  checkpointIds: string[];
  checkpoints: VerifiedCheckpoint[];
  source: PulseSourceIdentity;
  contentDigest: string;
}

export interface PulseDispatchDecision {
  schemaVersion: "keyoku.dev/pulse-dispatch/v1alpha1";
  outcome: PulseDispatchOutcome;
  reasonCode: string;
  reason: string;
  plannedAt: string;
  failClosed: boolean;
  checkpointIds: string[];
  snapshot?: PulseContentSnapshot;
  frozenSnapshot?: PulseContentSnapshot;
}

function buildPulseSnapshot(checkpointsInput: VerifiedCheckpoint[]): PulseContentSnapshot {
  const checkpoints = [...checkpointsInput].sort((left, right) => left.publishedAt.localeCompare(right.publishedAt) || left.id.localeCompare(right.id));
  if (checkpoints.length === 0) throw new Error("A Pulse content snapshot requires at least one verified checkpoint.");
  const projectId = checkpoints[0]!.projectId;
  if (checkpoints.some((checkpoint) => checkpoint.projectId !== projectId)) throw new Error("Cannot combine checkpoints from different projects.");
  const source = checkpoints.at(-1)!.source;
  const content = { projectId, checkpointDigests: checkpoints.map((checkpoint) => checkpoint.contentDigest) };
  const contentDigest = pulseDigest(content);
  return {
    schemaVersion: "keyoku.dev/pulse-snapshot/v1alpha1",
    id: `pulse-${contentDigest.slice(0, 20)}`,
    projectId,
    asOf: checkpoints.at(-1)!.publishedAt,
    checkpointIds: checkpoints.map((checkpoint) => checkpoint.id),
    checkpoints,
    source,
    contentDigest,
  };
}

export interface PlanPulseDispatchOptions {
  events: PulseEvent[];
  now?: string;
  staleAfterMs?: number;
  debounceMs?: number;
  deliveredContentDigests?: string[];
}

export function planPulseDispatch(options: PlanPulseDispatchOptions): PulseDispatchDecision {
  const now = options.now ?? new Date().toISOString();
  const staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
  const debounceMs = options.debounceMs ?? 30_000;
  const delivered = new Set(options.deliveredContentDigests ?? []);
  const decision = (partial: Omit<PulseDispatchDecision, "schemaVersion" | "plannedAt">): PulseDispatchDecision => ({
    schemaVersion: "keyoku.dev/pulse-dispatch/v1alpha1",
    plannedAt: now,
    ...partial,
  });
  const futureEvents = options.events.filter((event) => Date.parse(event.at) > Date.parse(now));
  if (futureEvents.length > 0) {
    return decision({
      outcome: "suppress",
      reasonCode: "future_event",
      reason: `${futureEvents.length} event${futureEvents.length === 1 ? " is" : "s are"} dated after the planning instant. Dispatch failed closed.`,
      failClosed: true,
      checkpointIds: [],
    });
  }
  const state = replayPulseEvents(options.events);
  if (state.events.length === 0) {
    return decision({ outcome: "suppress", reasonCode: "no_activity", reason: "No Pulse activity exists.", failClosed: false, checkpointIds: [] });
  }
  const active = state.leases.filter((lease) => ["working", "verifying", "blocked"].includes(lease.state));
  const stale = active.filter((lease) => Date.parse(now) - Date.parse(lease.heartbeatAt) > staleAfterMs);
  if (stale.length > 0) {
    const trusted = state.latestTrustedCheckpoint ? buildPulseSnapshot([state.latestTrustedCheckpoint]) : undefined;
    return decision({
      outcome: "stale_no_send",
      reasonCode: "stale_activity_lease",
      reason: `No normal update: ${stale.length} active lease${stale.length === 1 ? " is" : "s are"} stale; the last trusted checkpoint is frozen.`,
      failClosed: true,
      checkpointIds: trusted?.checkpointIds ?? [],
      ...(trusted ? { frozenSnapshot: trusted } : {}),
    });
  }
  const allSnapshots = state.checkpoints.map((checkpoint) => buildPulseSnapshot([checkpoint]));
  const undelivered = state.checkpoints.filter((checkpoint, index) => !delivered.has(allSnapshots[index]!.contentDigest));
  if (state.checkpoints.length > 0 && undelivered.length === 0) {
    return decision({
      outcome: "deduplicate",
      reasonCode: "already_delivered",
      reason: "Every verified checkpoint in this replay is already content-bound to a recorded delivery.",
      failClosed: false,
      checkpointIds: state.checkpoints.map((checkpoint) => checkpoint.id),
    });
  }
  if (undelivered.length === 0) {
    if (active.some((lease) => lease.state === "working" || lease.state === "verifying")) {
      return decision({ outcome: "defer", reasonCode: "fresh_uncheckpointed_work", reason: "Fresh work is in progress, but no verified checkpoint exists. Partial activity is not reportable.", failClosed: false, checkpointIds: [] });
    }
    return decision({ outcome: "suppress", reasonCode: "no_material_checkpoint", reason: "Lifecycle activity exists without a material verified checkpoint.", failClosed: false, checkpointIds: [] });
  }
  const projectIds = new Set(undelivered.map((checkpoint) => checkpoint.projectId));
  const compatible = projectIds.size === 1 && undelivered.every((left, index) => undelivered.slice(index + 1).every((right) => pulseSourcesCompatible(left.source, right.source)));
  if (!compatible) {
    return decision({ outcome: "suppress", reasonCode: "source_conflict", reason: "Undelivered checkpoints do not share a compatible project and source ancestry. Dispatch failed closed.", failClosed: true, checkpointIds: undelivered.map((checkpoint) => checkpoint.id) });
  }
  const freshWorking = active.filter((lease) => lease.state === "working" || lease.state === "verifying");
  if (freshWorking.length > 0) {
    return decision({
      outcome: "defer",
      reasonCode: "fresh_agents_working",
      reason: `${freshWorking.length} fresh lease${freshWorking.length === 1 ? " is" : "s are"} still working or verifying. Candidate checkpoints remain frozen until those leases stop or block.`,
      failClosed: false,
      checkpointIds: undelivered.map((checkpoint) => checkpoint.id),
    });
  }
  const newestAt = Math.max(...undelivered.map((checkpoint) => Date.parse(checkpoint.publishedAt)));
  if (Date.parse(now) - newestAt < debounceMs) {
    return decision({ outcome: "defer", reasonCode: "coalesce_window_open", reason: "A verified checkpoint is inside the debounce window; wait briefly for compatible agent checkpoints.", failClosed: false, checkpointIds: undelivered.map((checkpoint) => checkpoint.id) });
  }
  const snapshot = buildPulseSnapshot(undelivered);
  if (undelivered.length > 1) {
    return decision({ outcome: "coalesce", reasonCode: "compatible_checkpoints", reason: `${undelivered.length} compatible verified checkpoints are bound into one dispatch snapshot.`, failClosed: false, checkpointIds: snapshot.checkpointIds, snapshot });
  }
  return decision({ outcome: "send", reasonCode: "material_checkpoint", reason: "A material verified checkpoint is ready for an authorized delivery adapter.", failClosed: false, checkpointIds: snapshot.checkpointIds, snapshot });
}

export type PulseAudience = "stakeholder" | "developer" | "timeline" | "email" | "text" | "json";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function checkpointStory(checkpoint: VerifiedCheckpoint): string {
  const needs = checkpoint.humanDecisionRequest?.requestedAction ?? "No owner decision is required for this checkpoint.";
  return `## ${checkpoint.title}\n\n**What changed**\n${checkpoint.changeSummary}\n\n**Why it matters**\n${checkpoint.whyItMatters}\n\n**Proof**\n${checkpoint.factfiles.map((factfile) => `- Factfile ${factfile.id} — ${factfile.state} — \`${factfile.digest}\``).join("\n")}\n\n**Still unproven**\n${checkpoint.limitations.map((limit) => `- ${limit}`).join("\n")}\n\n**Needs you**\n${needs}`;
}

export function renderPulseStakeholder(snapshot: PulseContentSnapshot): string {
  return `# Keyoku Pulse · ${snapshot.projectId}\n\n${snapshot.checkpoints.map(checkpointStory).join("\n\n---\n\n")}\n\nContent-bound snapshot: \`${snapshot.contentDigest}\``;
}

export function renderPulseDeveloper(snapshot: PulseContentSnapshot): string {
  const checkpoints = snapshot.checkpoints.map((checkpoint) => {
    const methods = checkpoint.verification.methods.map((method) => `- ${method.label}: \`${method.reproduce}\` → ${method.result}`).join("\n");
    const factfiles = checkpoint.factfiles.map((factfile) => `- ${factfile.path} · \`${factfile.digest}\``).join("\n");
    return `## ${checkpoint.id} · ${checkpoint.title}\n\nSource: \`${checkpoint.source.headSha}+${checkpoint.source.worktreeDigest}\`\nSource digest: \`${checkpoint.source.verifiedDigest}\`\n\n### Verification\n${methods}\n\n### Factfiles\n${factfiles}\n\n### Limitations\n${checkpoint.limitations.map((limit) => `- ${limit}`).join("\n")}`;
  }).join("\n\n");
  return `# Keyoku Pulse developer evidence\n\nSnapshot: \`${snapshot.contentDigest}\`\n\n${checkpoints}`;
}

export function renderPulseText(snapshot: PulseContentSnapshot): string {
  return snapshot.checkpoints.map((checkpoint) => [
    checkpoint.title,
    `WHAT CHANGED: ${checkpoint.changeSummary}`,
    `WHY IT MATTERS: ${checkpoint.whyItMatters}`,
    `PROOF: ${checkpoint.factfiles.map((factfile) => `${factfile.id} ${factfile.state}`).join("; ")}`,
    `STILL UNPROVEN: ${checkpoint.limitations.join("; ")}`,
    `NEEDS YOU: ${checkpoint.humanDecisionRequest?.requestedAction ?? "Nothing"}`,
  ].join("\n")).join("\n\n");
}

export function renderPulseEmail(snapshot: PulseContentSnapshot): string {
  const stories = snapshot.checkpoints.map((checkpoint) => `<section><h2>${escapeHtml(checkpoint.title)}</h2><h3>What changed</h3><p>${escapeHtml(checkpoint.changeSummary)}</p><h3>Why it matters</h3><p>${escapeHtml(checkpoint.whyItMatters)}</p><h3>Proof</h3><ul>${checkpoint.factfiles.map((factfile) => `<li>${escapeHtml(factfile.id)} · ${escapeHtml(factfile.state)}</li>`).join("")}</ul><h3>Still unproven</h3><ul>${checkpoint.limitations.map((limit) => `<li>${escapeHtml(limit)}</li>`).join("")}</ul><h3>Needs you</h3><p>${escapeHtml(checkpoint.humanDecisionRequest?.requestedAction ?? "No owner decision is required.")}</p></section>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#f3f3f1;color:#191919;font:15px/1.55 Arial,sans-serif"><main style="max-width:680px;margin:auto;padding:32px"><p style="text-transform:uppercase;letter-spacing:.12em;color:#666">Keyoku Pulse · ${escapeHtml(snapshot.projectId)}</p>${stories}<hr><small>Content-bound snapshot ${snapshot.contentDigest}</small></main></body></html>`;
}

export function renderPulseTimeline(snapshot: PulseContentSnapshot): string {
  const cards = snapshot.checkpoints.map((checkpoint, index) => {
    const assets = checkpoint.assets.map((asset) => {
      if (!asset.digest) {
        return `<div class="asset unresolved" role="note"><b>Evidence asset unresolved</b><span>${escapeHtml(asset.label)} · ${escapeHtml(asset.path)}</span><span>${escapeHtml(asset.caption)}</span><small>A live adapter must resolve and digest this file before delivery.</small></div>`;
      }
      if (asset.kind === "video") {
        return `<a class="asset video" href="${escapeHtml(asset.path)}"><span class="poster">${asset.posterPath ? `<img src="${escapeHtml(asset.posterPath)}" alt="${escapeHtml(asset.label)} poster">` : ""}<b>Play evidence video</b></span><span>${escapeHtml(asset.caption)}</span></a>`;
      }
      return `<a class="asset" href="${escapeHtml(asset.path)}"><b>${escapeHtml(asset.label)}</b><span>${escapeHtml(asset.caption)}</span></a>`;
    }).join("");
    const facts = checkpoint.factfiles.map((factfile) => `<li><code>${escapeHtml(factfile.path)}</code><small>${escapeHtml(factfile.state)} · ${escapeHtml(factfile.digest)}</small></li>`).join("");
    return `<article class="checkpoint"><div class="rail"><span>${index + 1}</span></div><div class="story"><p class="meta">${escapeHtml(checkpoint.materialTrigger.replaceAll("_", " "))} · ${escapeHtml(checkpoint.publishedAt)}</p><h2>${escapeHtml(checkpoint.title)}</h2><div class="story-grid"><section><h3>What changed</h3><p>${escapeHtml(checkpoint.changeSummary)}</p></section><section><h3>Why it matters</h3><p>${escapeHtml(checkpoint.whyItMatters)}</p></section><section><h3>Still unproven</h3><ul>${checkpoint.limitations.map((limit) => `<li>${escapeHtml(limit)}</li>`).join("")}</ul></section><section><h3>Needs you</h3><p>${escapeHtml(checkpoint.humanDecisionRequest?.requestedAction ?? "Nothing right now.")}</p></section></div>${assets ? `<div class="assets">${assets}</div>` : ""}<details><summary>Open Factfile evidence</summary><ul class="facts">${facts}</ul><p><b>Exact source</b><br><code>${escapeHtml(checkpoint.source.headSha)}+${escapeHtml(checkpoint.source.worktreeDigest)}</code></p></details></div></article>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keyoku Pulse · ${escapeHtml(snapshot.projectId)}</title><style>:root{color-scheme:light;--bg:#f1f1ef;--card:#fafaf8;--line:#c8c8c3;--ink:#181818;--muted:#696966}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(1100px,calc(100% - 32px));margin:auto;padding:56px 0 100px}.kicker,.meta{color:var(--muted);font-size:12px;letter-spacing:.1em;text-transform:uppercase}h1{font-size:clamp(42px,8vw,92px);line-height:.93;letter-spacing:-.065em;margin:12px 0 52px;max-width:800px}.checkpoint{display:grid;grid-template-columns:52px 1fr}.rail{position:relative;border-right:1px solid var(--line)}.rail span{position:absolute;right:-17px;display:grid;place-items:center;width:34px;height:34px;border:1px solid var(--line);border-radius:50%;background:var(--bg);font-size:12px}.story{margin:0 0 28px 36px;padding:28px;border:1px solid var(--line);border-radius:18px;background:var(--card)}h2{font-size:clamp(26px,4vw,46px);line-height:1;letter-spacing:-.04em;margin:8px 0 30px}.story-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}.story-grid section{border-top:1px solid var(--line)}h3{font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}ul{padding-left:18px}.assets{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:22px 0}.asset{display:flex;flex-direction:column;gap:6px;padding:14px;color:inherit;text-decoration:none;border:1px solid var(--line);border-radius:12px}.unresolved{border-style:dashed;background:#f1f1ef}.unresolved small{color:var(--muted)}.poster img{width:100%;display:block;border-radius:7px;margin-bottom:10px}.facts li{margin:10px 0}.facts small{display:block;color:var(--muted);overflow-wrap:anywhere}code{font:12px/1.5 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}details{border-top:1px solid var(--line);margin-top:22px;padding-top:18px}summary{cursor:pointer;font-weight:650}@media(max-width:650px){main{width:min(100% - 22px,1100px);padding-top:32px}.checkpoint{grid-template-columns:22px 1fr}.rail span{right:-12px;width:24px;height:24px}.story{margin-left:18px;padding:20px}.story-grid{grid-template-columns:1fr}h1{margin-bottom:36px}}</style></head><body><main><p class="kicker">Keyoku Pulse · trusted progress</p><h1>What changed.<br>What is proven.</h1>${cards}<p class="meta">Content-bound snapshot · ${snapshot.contentDigest}</p></main></body></html>`;
}

export function renderPulseProjection(snapshot: PulseContentSnapshot, audience: PulseAudience): string {
  if (audience === "json") return `${JSON.stringify(snapshot, null, 2)}\n`;
  if (audience === "stakeholder") return renderPulseStakeholder(snapshot);
  if (audience === "developer") return renderPulseDeveloper(snapshot);
  if (audience === "timeline") return renderPulseTimeline(snapshot);
  if (audience === "email") return renderPulseEmail(snapshot);
  return renderPulseText(snapshot);
}

export const PulseDeliveryAdapterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email"), recipient: z.string().email() }).strict(),
  z.object({ kind: z.literal("slack"), channel: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("teams"), conversation: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("webhook"), url: z.string().url() }).strict(),
  z.object({ kind: z.literal("mcp"), server: z.string().min(1), tool: z.string().min(1) }).strict(),
]);
export type PulseDeliveryAdapter = z.infer<typeof PulseDeliveryAdapterSchema>;

export const PulseDeliveryAuthoritySchema = z.object({
  channel: z.enum(["email", "slack", "teams", "webhook", "mcp"]),
  subject: z.string().min(1),
  grantedBy: z.string().min(1),
  grantedAt: TimestampSchema,
  expiresAt: TimestampSchema.optional(),
  projectIds: z.array(IdSchema).min(1).optional(),
}).strict();
export type PulseDeliveryAuthority = z.infer<typeof PulseDeliveryAuthoritySchema>;

export interface PulseDeliveryPlan {
  status: "ready" | "not_authorized" | "no_send";
  reason: string;
  adapter: PulseDeliveryAdapter;
  snapshotDigest?: string;
  payload?: string;
}

export function planPulseDelivery(input: {
  dispatch: PulseDispatchDecision;
  adapter: PulseDeliveryAdapter;
  authority?: PulseDeliveryAuthority;
  now?: string;
}): PulseDeliveryPlan {
  const adapter = PulseDeliveryAdapterSchema.parse(input.adapter);
  const now = input.now ?? input.dispatch.plannedAt;
  if (!input.dispatch.snapshot || !["send", "coalesce"].includes(input.dispatch.outcome)) {
    return { status: "no_send", reason: `Dispatcher outcome '${input.dispatch.outcome}' does not authorize a delivery.`, adapter };
  }
  if (input.dispatch.snapshot.checkpoints.some((checkpoint) => checkpoint.evidenceBinding.mode === "fixture")) {
    return { status: "no_send", reason: "Fixture-bound checkpoints are preview data and cannot be delivered by a live adapter.", adapter, snapshotDigest: input.dispatch.snapshot.contentDigest };
  }
  const authority = input.authority ? PulseDeliveryAuthoritySchema.parse(input.authority) : undefined;
  if (!authority || authority.channel !== adapter.kind || (authority.expiresAt && Date.parse(authority.expiresAt) <= Date.parse(now)) || (authority.projectIds && !authority.projectIds.includes(input.dispatch.snapshot.projectId))) {
    return { status: "not_authorized", reason: "No current, project-scoped authority matches this delivery channel.", adapter, snapshotDigest: input.dispatch.snapshot.contentDigest };
  }
  const audience: PulseAudience = adapter.kind === "email" ? "email" : adapter.kind === "mcp" || adapter.kind === "webhook" ? "json" : "text";
  return { status: "ready", reason: "Adapter payload is planned only; the caller must perform the explicitly authorized send.", adapter, snapshotDigest: input.dispatch.snapshot.contentDigest, payload: renderPulseProjection(input.dispatch.snapshot, audience) };
}

export function writePulseProjection(pathInput: string, snapshot: PulseContentSnapshot, audience: PulseAudience): string {
  const path = resolve(pathInput);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderPulseProjection(snapshot, audience), "utf8");
  return path;
}
