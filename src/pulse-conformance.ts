import { z } from "zod";

import { bytesDigest, canonicalJson, canonicalJsonDigest } from "./canonical-json.js";
import { GateSnapshotSchema, type GateSnapshot } from "./contribution.js";
import { buildGenericPulseFixture, buildProcessyardPulseFixture } from "./pulse-fixtures.js";
import {
  planPulseDispatch,
  replayPulseEvents,
  sealPulseEvent,
  sealPulseSource,
  sealVerifiedCheckpoint,
  type AgentActivityLease,
  type PlanPulseDispatchOptions,
  type PulseDispatchDecision,
  type PulseEvent,
  type PulseSourceIdentity,
  type VerifiedCheckpoint,
} from "./pulse.js";

export const PULSE_CONFORMANCE_VERSION = "keyoku.dev/pulse-conformance/v1alpha1" as const;
export const PULSE_CONFORMANCE_ROOT = "fixtures/conformance/v1" as const;

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const DispatchExpectationSchema = z.object({
  outcome: z.enum(["send", "defer", "deduplicate", "suppress", "coalesce", "stale_no_send"]),
  reasonCode: z.string().min(1),
  failClosed: z.boolean(),
  checkpointIds: z.array(z.string()),
  snapshotContentDigest: DigestSchema.optional(),
  frozenSnapshotContentDigest: DigestSchema.optional(),
}).strict();

export const PulseConformanceManifestSchema = z.object({
  schemaVersion: z.literal(PULSE_CONFORMANCE_VERSION),
  canonicalJson: z.array(z.object({
    id: z.string().min(1),
    input: z.unknown(),
    inputJson: z.string().min(1),
    canonical: z.string(),
    digest: DigestSchema,
  }).strict()).min(1),
  strictJson: z.array(z.object({
    id: z.string().min(1),
    inputBytesBase64: z.string().min(1),
    expectedErrorIncludes: z.string().min(1),
  }).strict()).min(1),
  bytes: z.object({
    factfile: z.object({ path: z.string().min(1), bytesDigest: DigestSchema, byteLength: z.number().int().positive(), factfileDigest: DigestSchema }).strict(),
    asset: z.object({
      kind: z.literal("video"),
      path: z.string().min(1),
      label: z.string().min(1),
      caption: z.string().min(1),
      digest: DigestSchema,
      byteLength: z.number().int().positive(),
      posterPath: z.string().min(1),
      posterDigest: DigestSchema,
    }).strict(),
    poster: z.object({ path: z.string().min(1), posterDigest: DigestSchema, byteLength: z.number().int().positive() }).strict(),
  }).strict(),
  eventSets: z.record(z.string().min(1)),
  ordering: z.array(z.object({
    id: z.string().min(1),
    eventSet: z.string().min(1),
    expectedEventIds: z.array(z.string()).optional(),
    expectedCheckpointIds: z.array(z.string()).optional(),
    expectedErrorIncludes: z.string().min(1).optional(),
  }).strict()).min(1),
  sourceConflict: z.object({ eventSet: z.string().min(1), dispatchVector: z.string().min(1) }).strict(),
  dispatch: z.array(z.object({
    id: z.string().min(1),
    eventSet: z.string().min(1),
    plan: z.object({
      now: z.string().datetime(),
      staleAfterMs: z.number().int().nonnegative(),
      debounceMs: z.number().int().nonnegative(),
      deliveredContentDigests: z.array(DigestSchema),
    }).strict(),
    expected: DispatchExpectationSchema,
  }).strict()).min(1),
}).strict();

export type PulseConformanceManifest = z.infer<typeof PulseConformanceManifestSchema>;

export const CONFORMANCE_ASSET_BYTES = "KEYOKU PULSE CONFORMANCE ASSET BYTES v1\n";
export const CONFORMANCE_POSTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" role="img" aria-labelledby="title desc"><title id="title">Keyoku Pulse conformance poster</title><desc id="desc">Deterministic fixture bytes; not live product evidence.</desc><rect width="640" height="360" fill="#e5e7eb"/><rect x="28" y="28" width="584" height="304" rx="18" fill="#f9fafb" stroke="#9ca3af"/><text x="52" y="96" fill="#111827" font-family="system-ui,sans-serif" font-size="18">KEYOKU PULSE</text><text x="52" y="154" fill="#111827" font-family="system-ui,sans-serif" font-size="34">Conformance fixture</text><text x="52" y="202" fill="#4b5563" font-family="system-ui,sans-serif" font-size="18">Exact poster bytes · v1</text><text x="52" y="292" fill="#6b7280" font-family="ui-monospace,monospace" font-size="13">fixture only · not live evidence</text></svg>\n`;

function conformanceFactfile(): GateSnapshot {
  const generatedAt = "2026-08-25T12:00:00.000Z";
  const base = {
    schemaVersion: "keyoku.dev/factfile/v1alpha1" as const,
    id: "fact_conformance_v1",
    project: { id: "conformance-project", name: "Conformance Project", summary: "Stable cross-language trust vectors." },
    outcome: {
      id: "conformance-outcome",
      revision: 1,
      title: "The conformance record is portable",
      objective: "Bind exact source, verification, and presentation bytes across implementations.",
      constraints: ["Treat these bytes as fixtures, never live evidence."],
      owner: { kind: "human" as const, id: "owner@example.com", name: "Fixture Owner" },
      humanCriteria: [],
    },
    contribution: {
      schemaVersion: "keyoku.dev/contribution/v1alpha1" as const,
      id: "conformance-contribution",
      title: "Portable conformance record",
      summary: "One complete deterministic Factfile.",
      knownLimits: ["Fixture-only evidence."],
      outcomeId: "conformance-outcome",
      outcomeRevision: 1,
      baseSha: "1".repeat(40),
      actors: [{ kind: "human" as const, id: "owner@example.com", name: "Fixture Owner" }],
      status: "ready_for_review" as const,
      createdAt: generatedAt,
      updatedAt: generatedAt,
    },
    repository: {
      repositoryRoot: "/conformance/keyoku",
      branch: "main",
      ahead: 0,
      behind: 0,
      lastCommit: "Conformance fixture",
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
      worktreeDigest: "3".repeat(64),
      sourceCapsuleDigest: "3".repeat(64),
      dirty: false,
      changedFiles: [],
    },
    scope: {
      declared: false,
      passed: true,
      includedPaths: [],
      unexpectedPaths: [],
      excludedPaths: [],
      topLevelAreas: [],
      note: "No repository path scope was declared for this fixture.",
    },
    reviewPlan: [],
    session: { work: [], decisions: [], instructions: [], agents: [], directions: [], eventCount: 0 },
    state: "ready_for_review" as const,
    generatedAt,
    reviews: [],
    evidence: [{
      id: "criterion-0",
      description: "The structured fixture observation matches.",
      pass: true,
      actual: { "😀": 6, "ä": 4, a: 2, "あ": 5, "Á": 3, Z: 1 },
      expected: { path: "output.a", op: "eq" as const, value: 2 },
      durationMs: 1,
      verification: {
        kind: "command" as const,
        label: "Fixture observation",
        reproduce: "keyoku conformance verify",
        assertion: { path: "output.a", op: "eq" as const, value: 2 },
      },
    }],
    summary: { passed: 1, failed: 0, total: 1, verified: true },
    humanReview: { passed: 0, failed: 0, pending: 0, total: 0 },
  };
  return GateSnapshotSchema.parse({ ...base, digest: canonicalJsonDigest(base) }) as GateSnapshot;
}

export function renderConformanceFactfile(): string {
  return `${JSON.stringify(conformanceFactfile(), null, 2)}\n`;
}

function conflictSource(root: string, digit: string): PulseSourceIdentity {
  return sealPulseSource({
    canonicalRoot: root,
    branch: "main",
    headSha: digit.repeat(40),
    worktreeDigest: digit.repeat(64),
    ancestryShas: [],
  });
}

function conflictLease(id: string, source: PulseSourceIdentity): AgentActivityLease {
  return {
    schemaVersion: "keyoku.dev/pulse-lease/v1alpha1",
    id,
    harness: "conformance-jsonl",
    project: { id: "source-conflict-project", name: "Source Conflict Project" },
    runId: "source-conflict-run",
    agent: { id: `${id}-agent`, name: `${id} agent` },
    canonicalSourceRoot: source.canonicalRoot,
    task: { id: `${id}-task`, title: "Produce a source-bound checkpoint", outcome: "Conflicting roots fail closed." },
    startedAt: "2026-08-25T16:00:00.000Z",
    heartbeatAt: "2026-08-25T16:00:00.000Z",
    state: "working",
    currentSource: source,
  };
}

function conflictCheckpoint(id: string, lease: AgentActivityLease): VerifiedCheckpoint {
  return sealVerifiedCheckpoint({
    schemaVersion: "keyoku.dev/pulse-checkpoint/v1alpha1",
    id,
    projectId: lease.project.id,
    outcomeId: lease.task.id,
    runId: lease.runId,
    leaseIds: [lease.id],
    title: `${id} attested fixture`,
    changeSummary: "A synthetic checkpoint was attested on one declared canonical root.",
    whyItMatters: "Incompatible roots must never be combined into one report.",
    publishedAt: "2026-08-25T16:01:00.000Z",
    source: lease.currentSource,
    verification: { status: "attested", verifiedAt: "2026-08-25T16:01:00.000Z", methods: [{ kind: "command", label: "Conformance check", reproduce: "keyoku conformance verify", result: "passed in a synthetic fixture" }] },
    evidenceBinding: { mode: "fixture", label: "Synthetic source-conflict conformance vector" },
    factfiles: [{ id: `${id}-factfile`, projectId: lease.project.id, outcomeId: lease.task.id, path: `.keyoku/${id}.json`, digest: canonicalJsonDigest({ id }), sourceDigest: lease.currentSource.verifiedDigest, state: "ready_for_review" }],
    assets: [],
    limitations: ["Fixture-only evidence."],
    materialTrigger: "verified_checkpoint",
  });
}

export function buildSourceConflictEvents(): PulseEvent[] {
  const leftLease = conflictLease("conflict-left", conflictSource("repo://conformance/left", "a"));
  const rightLease = conflictLease("conflict-right", conflictSource("repo://conformance/right", "b"));
  const leftCheckpoint = conflictCheckpoint("conflict-left-checkpoint", leftLease);
  const rightCheckpoint = conflictCheckpoint("conflict-right-checkpoint", rightLease);
  return [
    sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "conflict-left-started", type: "started", at: "2026-08-25T16:00:00.000Z", leaseId: leftLease.id, lease: leftLease }),
    sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "conflict-right-started", type: "started", at: "2026-08-25T16:00:00.000Z", leaseId: rightLease.id, lease: rightLease }),
    sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "conflict-left-published", type: "checkpoint_published", at: leftCheckpoint.publishedAt, leaseId: leftLease.id, checkpoint: leftCheckpoint }),
    sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "conflict-right-published", type: "checkpoint_published", at: rightCheckpoint.publishedAt, leaseId: rightLease.id, checkpoint: rightCheckpoint }),
    sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "conflict-left-completed", type: "completed", at: "2026-08-25T16:02:00.000Z", leaseId: leftLease.id, source: leftLease.currentSource, checkpointId: leftCheckpoint.id }),
    sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "conflict-right-completed", type: "completed", at: "2026-08-25T16:02:00.000Z", leaseId: rightLease.id, source: rightLease.currentSource, checkpointId: rightCheckpoint.id }),
  ];
}

type ConformancePlan = Omit<PlanPulseDispatchOptions, "events"> & {
  now: string;
  staleAfterMs: number;
  debounceMs: number;
  deliveredContentDigests: string[];
};

function expectedDecision(decision: PulseDispatchDecision): z.infer<typeof DispatchExpectationSchema> {
  return DispatchExpectationSchema.parse({
    outcome: decision.outcome,
    reasonCode: decision.reasonCode,
    failClosed: decision.failClosed,
    checkpointIds: decision.checkpointIds,
    ...(decision.snapshot ? { snapshotContentDigest: decision.snapshot.contentDigest } : {}),
    ...(decision.frozenSnapshot ? { frozenSnapshotContentDigest: decision.frozenSnapshot.contentDigest } : {}),
  });
}

export interface PulseConformanceVectors {
  manifest: PulseConformanceManifest;
  eventSets: Record<string, PulseEvent[]>;
  factfileBytes: string;
  assetBytes: string;
  posterBytes: string;
}

export function buildPulseConformanceVectors(): PulseConformanceVectors {
  const generic = buildGenericPulseFixture();
  const processyard = buildProcessyardPulseFixture();
  const verification = generic.events.find((event) => event.type === "verification_started");
  if (!verification || verification.type !== "verification_started") throw new Error("Generic conformance fixture is missing verification_started.");
  const sameTimeHeartbeat = sealPulseEvent({
    schemaVersion: "keyoku.dev/pulse-event/v1alpha1",
    id: "generic-same-time-heartbeat",
    type: "heartbeat",
    at: verification.at,
    leaseId: verification.leaseId,
    state: "working",
    source: verification.source,
  });
  const eventSets: Record<string, PulseEvent[]> = {
    generic: generic.events,
    "generic-through-verification": generic.events.slice(0, 2),
    "generic-through-checkpoint": generic.events.slice(0, 3),
    "generic-reversed": [...generic.events].reverse(),
    "generic-same-time-ambiguous": [...generic.events, sameTimeHeartbeat],
    processyard: processyard.events,
    "source-conflict": buildSourceConflictEvents(),
  };
  const eventSetPaths = Object.fromEntries(Object.keys(eventSets).map((id) => [id, `events/${id}.jsonl`]));
  const attestedPlan: ConformancePlan = { ...generic.recommendedPlan };
  const plans: Array<{ id: string; eventSet: string; plan: ConformancePlan }> = [
    { id: "suppress-attested-checkpoint", eventSet: "generic", plan: attestedPlan },
    { id: "defer-uncheckpointed-work", eventSet: "generic-through-verification", plan: { now: "2026-08-24T16:02:10.000Z", staleAfterMs: 300_000, debounceMs: 0, deliveredContentDigests: [] } },
    { id: "defer-fresh-agent-with-candidate", eventSet: "generic-through-checkpoint", plan: { now: "2026-08-24T16:03:10.000Z", staleAfterMs: 300_000, debounceMs: 0, deliveredContentDigests: [] } },
    { id: "coalesce-compatible-checkpoints", eventSet: "processyard", plan: { ...processyard.coalescingPlan! } },
    { id: "stale-no-send", eventSet: "processyard", plan: { ...processyard.recommendedPlan } },
    { id: "suppress-source-conflict", eventSet: "source-conflict", plan: { now: "2026-08-25T16:03:00.000Z", staleAfterMs: 300_000, debounceMs: 0, deliveredContentDigests: [] } },
  ];
  const dispatch = plans.map((vector) => ({
    ...vector,
    expected: expectedDecision(planPulseDispatch({ events: eventSets[vector.eventSet]!, ...vector.plan })),
  }));
  const normalReplay = replayPulseEvents(eventSets.generic!);
  const factfileBytes = renderConformanceFactfile();
  const factfile = conformanceFactfile();
  const canonicalInput = { "😀": 6, "ä": 4, a: 2, "あ": 5, "Á": 3, Z: 1 };
  const canonicalCases = [
    { id: "mixed-case-unicode", input: canonicalInput, inputJson: JSON.stringify(canonicalInput) },
    { id: "negative-zero", input: { value: 0 }, inputJson: "{\"value\":-0}" },
    { id: "one-million", input: { value: 1e6 }, inputJson: "{\"value\":1000000}" },
    { id: "one-millionth", input: { value: 1e-6 }, inputJson: "{\"value\":0.000001}" },
    { id: "one-ten-millionth", input: { value: 1e-7 }, inputJson: "{\"value\":1e-7}" },
    { id: "one-sextillion", input: { value: 1e21 }, inputJson: "{\"value\":1e+21}" },
    { id: "literal-line-separators", input: { value: "line\u2028paragraph\u2029end" }, inputJson: "{\"value\":\"line\u2028paragraph\u2029end\"}" },
    { id: "redacted-marker", input: { value: "«redacted»" }, inputJson: "{\"value\":\"«redacted»\"}" },
  ].map((vector) => ({ ...vector, canonical: canonicalJson(vector.input), digest: canonicalJsonDigest(vector.input) }));
  const strictJson = [
    { id: "invalid-utf8", bytes: Buffer.from([0x7b, 0x22, 0x76, 0x61, 0x6c, 0x75, 0x65, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), expectedErrorIncludes: "invalid UTF-8" },
    { id: "escaped-high-surrogate", bytes: Buffer.from('{"value":"\\ud800"}', "utf8"), expectedErrorIncludes: "surrogate forms" },
    { id: "escaped-surrogate-pair", bytes: Buffer.from('{"value":"\\ud83d\\ude00"}', "utf8"), expectedErrorIncludes: "surrogate forms" },
  ].map(({ id, bytes, expectedErrorIncludes }) => ({ id, inputBytesBase64: bytes.toString("base64"), expectedErrorIncludes }));
  const manifest = PulseConformanceManifestSchema.parse({
    schemaVersion: PULSE_CONFORMANCE_VERSION,
    canonicalJson: canonicalCases,
    strictJson,
    bytes: {
      factfile: { path: "factfiles/verified.json", bytesDigest: bytesDigest(Buffer.from(factfileBytes, "utf8")), byteLength: Buffer.byteLength(factfileBytes), factfileDigest: factfile.digest },
      asset: {
        kind: "video",
        path: "assets/demo-bytes.bin",
        label: "Deterministic conformance asset bytes",
        caption: "Digest fixture only; these bytes are intentionally not playable media or live evidence.",
        digest: bytesDigest(Buffer.from(CONFORMANCE_ASSET_BYTES, "utf8")),
        byteLength: Buffer.byteLength(CONFORMANCE_ASSET_BYTES),
        posterPath: "assets/poster.svg",
        posterDigest: bytesDigest(Buffer.from(CONFORMANCE_POSTER_SVG, "utf8")),
      },
      poster: { path: "assets/poster.svg", posterDigest: bytesDigest(Buffer.from(CONFORMANCE_POSTER_SVG, "utf8")), byteLength: Buffer.byteLength(CONFORMANCE_POSTER_SVG) },
    },
    eventSets: eventSetPaths,
    ordering: [
      { id: "canonical-order", eventSet: "generic", expectedEventIds: normalReplay.events.map((event) => event.id), expectedCheckpointIds: normalReplay.checkpoints.map((checkpoint) => checkpoint.id) },
      { id: "reversed-input-same-replay", eventSet: "generic-reversed", expectedEventIds: normalReplay.events.map((event) => event.id), expectedCheckpointIds: normalReplay.checkpoints.map((checkpoint) => checkpoint.id) },
      { id: "same-time-rank-ambiguity", eventSet: "generic-same-time-ambiguous", expectedErrorIncludes: "ambiguous ordering" },
    ],
    sourceConflict: { eventSet: "source-conflict", dispatchVector: "suppress-source-conflict" },
    dispatch,
  });
  return { manifest, eventSets, factfileBytes, assetBytes: CONFORMANCE_ASSET_BYTES, posterBytes: CONFORMANCE_POSTER_SVG };
}
