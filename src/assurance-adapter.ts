import { z } from "zod";

import { canonicalJsonDigest, decodeUtf8Strict } from "./canonical-json.js";
import { readLocalLedger, resolveLocalLedger, updateLocalLedger } from "./local-ledger.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase sha256 digest");
const IdSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

/**
 * These profiles are caller policy, not part of the evidence envelope and not
 * a requirement imposed on an agent runtime or neutral work protocol.
 */
export const AssuranceProfileSchema = z.enum(["none", "basic", "keyoku_high_assurance"]);
export type AssuranceProfile = z.infer<typeof AssuranceProfileSchema>;

const SnapshotSchema = z.object({
  capturedDigest: DigestSchema,
  currentDigest: DigestSchema.optional(),
  label: z.string().min(1).max(1_000).optional(),
}).strict();

const EvidenceEnvelopeFields = z.object({
  schemaVersion: z.literal("evidence-provider/v1"),
  work: z.object({
    id: IdSchema,
    objective: z.string().min(1).max(8_000),
  }).strict(),
  claims: z.array(z.object({
    id: IdSchema,
    statement: z.string().min(1).max(8_000),
    verdict: z.enum(["pass", "fail", "pending"]),
    evidenceRefs: z.array(IdSchema).max(100).default([]),
  }).strict()).min(1).max(500),
  source: SnapshotSchema.optional(),
  deployment: SnapshotSchema.optional(),
  commands: z.array(z.object({
    id: IdSchema,
    command: z.string().min(1).max(16_000),
    exitCode: z.number().int(),
    resultDigest: DigestSchema,
  }).strict()).max(500).default([]),
  artifacts: z.array(z.object({
    id: IdSchema,
    path: z.string().min(1).max(4_000),
    digest: DigestSchema,
  }).strict()).max(500).default([]),
  limitations: z.array(z.string().min(1).max(8_000)).max(500).default([]),
  authority: z.object({
    kind: z.enum(["human", "organization", "automation"]),
    id: IdSchema,
    decision: z.enum(["approved", "pending", "rejected"]),
  }).strict(),
  contentDigest: DigestSchema,
}).strict();

export const EvidenceEnvelopeSchema = EvidenceEnvelopeFields;
export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;

type UnsignedEvidenceEnvelope = Omit<EvidenceEnvelope, "contentDigest">;

export function sealEvidenceEnvelope(input: UnsignedEvidenceEnvelope): EvidenceEnvelope {
  const { contentDigest: _contentDigest, ...candidate } = input as UnsignedEvidenceEnvelope & { contentDigest?: string };
  const unsigned = EvidenceEnvelopeFields.omit({ contentDigest: true }).parse(candidate);
  return EvidenceEnvelopeSchema.parse({ ...unsigned, contentDigest: canonicalJsonDigest(unsigned) });
}

export const EvidenceReasonCodeSchema = z.enum([
  "invalid_envelope",
  "content_digest_mismatch",
  "source_changed",
  "deployment_changed",
  "claim_failed",
  "command_failed",
  "authority_rejected",
  "claim_pending",
  "authority_pending",
  "evidence_accepted",
]);
export type EvidenceReasonCode = z.infer<typeof EvidenceReasonCodeSchema>;

export const EvidenceProviderStatusSchema = z.enum(["accepted", "rejected", "stale", "human_review_required"]);
export type EvidenceProviderStatus = z.infer<typeof EvidenceProviderStatusSchema>;

const EvidenceResultFields = z.object({
  schemaVersion: z.literal("evidence-result/v1"),
  status: EvidenceProviderStatusSchema,
  workId: IdSchema.nullable(),
  inputDigest: DigestSchema.nullable(),
  computedContentDigest: DigestSchema.nullable(),
  reasons: z.array(z.object({
    code: EvidenceReasonCodeSchema,
    message: z.string().min(1).max(8_000),
    path: z.string().max(2_000).optional(),
  }).strict()).min(1),
  resultDigest: DigestSchema,
}).strict();

export const EvidenceProviderResultSchema = EvidenceResultFields.superRefine((result, context) => {
  const { resultDigest: _resultDigest, ...unsigned } = result;
  const expected = canonicalJsonDigest(unsigned);
  if (result.resultDigest !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["resultDigest"], message: `does not match result content (expected ${expected})` });
  }
});
export type EvidenceProviderResult = z.infer<typeof EvidenceProviderResultSchema>;

export interface EvidenceProvider {
  evaluate(input: unknown): EvidenceProviderResult;
}

function sealEvidenceResult(input: Omit<EvidenceProviderResult, "resultDigest">): EvidenceProviderResult {
  return EvidenceProviderResultSchema.parse({ ...input, resultDigest: canonicalJsonDigest(input) });
}

function invalidEnvelope(input: unknown, error: z.ZodError): EvidenceProviderResult {
  let computedContentDigest: string | null = null;
  try {
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const { contentDigest: _contentDigest, ...unsigned } = input as Record<string, unknown>;
      computedContentDigest = canonicalJsonDigest(unsigned);
    }
  } catch {
    computedContentDigest = null;
  }
  const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  const work = record?.work && typeof record.work === "object" && !Array.isArray(record.work) ? record.work as Record<string, unknown> : undefined;
  return sealEvidenceResult({
    schemaVersion: "evidence-result/v1",
    status: "rejected",
    workId: typeof work?.id === "string" && IdSchema.safeParse(work.id).success ? work.id : null,
    inputDigest: typeof record?.contentDigest === "string" && DigestSchema.safeParse(record.contentDigest).success ? record.contentDigest : null,
    computedContentDigest,
    reasons: error.issues.map((issue) => ({
      code: "invalid_envelope" as const,
      message: issue.message,
      ...(issue.path.length ? { path: issue.path.join(".") } : {}),
    })),
  });
}

/** Deterministic, side-effect-free evaluation of a caller-owned evidence envelope. */
export function evaluateEvidence(input: unknown): EvidenceProviderResult {
  const parsed = EvidenceEnvelopeSchema.safeParse(input);
  if (!parsed.success) return invalidEnvelope(input, parsed.error);
  const envelope = parsed.data;
  const { contentDigest, ...unsigned } = envelope;
  const computedContentDigest = canonicalJsonDigest(unsigned);
  const base = {
    schemaVersion: "evidence-result/v1" as const,
    workId: envelope.work.id,
    inputDigest: contentDigest,
    computedContentDigest,
  };
  if (contentDigest !== computedContentDigest) {
    return sealEvidenceResult({ ...base, status: "rejected", reasons: [{ code: "content_digest_mismatch", message: "The canonical content digest does not match the submitted evidence envelope.", path: "contentDigest" }] });
  }
  const staleReasons = [
    ...(envelope.source?.currentDigest && envelope.source.currentDigest !== envelope.source.capturedDigest
      ? [{ code: "source_changed" as const, message: "The current source snapshot differs from the captured source snapshot.", path: "source.currentDigest" }]
      : []),
    ...(envelope.deployment?.currentDigest && envelope.deployment.currentDigest !== envelope.deployment.capturedDigest
      ? [{ code: "deployment_changed" as const, message: "The current deployment snapshot differs from the captured deployment snapshot.", path: "deployment.currentDigest" }]
      : []),
  ];
  if (staleReasons.length) return sealEvidenceResult({ ...base, status: "stale", reasons: staleReasons });

  const rejectionReasons = [
    ...envelope.claims.filter((claim) => claim.verdict === "fail").map((claim) => ({ code: "claim_failed" as const, message: `Claim '${claim.id}' failed.`, path: `claims.${claim.id}` })),
    ...envelope.commands.filter((command) => command.exitCode !== 0).map((command) => ({ code: "command_failed" as const, message: `Command '${command.id}' exited with code ${command.exitCode}.`, path: `commands.${command.id}` })),
    ...(envelope.authority.decision === "rejected" ? [{ code: "authority_rejected" as const, message: `Authority '${envelope.authority.id}' rejected the evidence.`, path: "authority.decision" }] : []),
  ];
  if (rejectionReasons.length) return sealEvidenceResult({ ...base, status: "rejected", reasons: rejectionReasons });

  const reviewReasons = [
    ...envelope.claims.filter((claim) => claim.verdict === "pending").map((claim) => ({ code: "claim_pending" as const, message: `Claim '${claim.id}' still needs a decision.`, path: `claims.${claim.id}` })),
    ...(envelope.authority.decision === "pending" ? [{ code: "authority_pending" as const, message: `Authority '${envelope.authority.id}' has not approved the evidence.`, path: "authority.decision" }] : []),
  ];
  if (reviewReasons.length) return sealEvidenceResult({ ...base, status: "human_review_required", reasons: reviewReasons });
  return sealEvidenceResult({ ...base, status: "accepted", reasons: [{ code: "evidence_accepted", message: "All submitted claims and commands passed for the current snapshots, and the declared authority approved the evidence." }] });
}

export const defaultEvidenceProvider: EvidenceProvider = Object.freeze({ evaluate: evaluateEvidence });

export const WorkEventKindSchema = z.enum(["dispatch", "checkpoint", "milestone", "decision", "regression", "recovery", "stale", "terminal"]);
export type WorkEventKind = z.infer<typeof WorkEventKindSchema>;

const WorkEventFields = z.object({
  schemaVersion: z.literal("work-event/v1"),
  id: IdSchema,
  kind: WorkEventKindSchema,
  at: z.string().datetime(),
  workId: IdSchema,
  summary: z.string().min(1).max(8_000),
  outcome: z.string().min(1).max(4_000).optional(),
  checkpointId: IdSchema.optional(),
  decisionId: IdSchema.optional(),
  sourceDigest: DigestSchema.optional(),
  evidenceResultDigest: DigestSchema.optional(),
  limitations: z.array(z.string().min(1).max(8_000)).max(100).default([]),
  eventDigest: DigestSchema,
}).strict();

export const WorkEventSchema = WorkEventFields.superRefine((event, context) => {
  const { eventDigest: _eventDigest, ...unsigned } = event;
  const expected = canonicalJsonDigest(unsigned);
  if (event.eventDigest !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["eventDigest"], message: `does not match event content (expected ${expected})` });
  }
});
export type WorkEvent = z.infer<typeof WorkEventSchema>;

export function sealWorkEvent(input: Omit<WorkEvent, "eventDigest">): WorkEvent {
  const { eventDigest: _eventDigest, ...candidate } = input as Omit<WorkEvent, "eventDigest"> & { eventDigest?: string };
  const unsigned = WorkEventFields.omit({ eventDigest: true }).parse(candidate);
  return WorkEventSchema.parse({ ...unsigned, eventDigest: canonicalJsonDigest(unsigned) });
}

function workEventsPath(rootInput: string, create = false): string {
  return resolveLocalLedger(rootInput, "work-events.jsonl", create);
}

export function readWorkEvents(rootInput: string): WorkEvent[] {
  const path = workEventsPath(rootInput);
  return decodeUtf8Strict(readLocalLedger(path), `WorkEvent ledger ${path}`).split("\n").filter(Boolean).map((line, index) => {
    try { return WorkEventSchema.parse(JSON.parse(line)); }
    catch (error) { throw new Error(`Invalid WorkEvent at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

export interface WorkEventAppendResult {
  status: "appended" | "deduplicated";
  event: WorkEvent;
  path: string;
}

export function appendWorkEvent(rootInput: string, input: WorkEvent | Record<string, unknown>): WorkEventAppendResult {
  const event = WorkEventSchema.parse(input);
  const path = workEventsPath(rootInput, true);
  let result: WorkEventAppendResult | undefined;
  updateLocalLedger(path, (current) => {
    const events = decodeUtf8Strict(current, `WorkEvent ledger ${path}`).split("\n").filter(Boolean).map((line, index) => {
      try { return WorkEventSchema.parse(JSON.parse(line)); }
      catch (error) { throw new Error(`Invalid WorkEvent at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    });
    const existing = events.find((candidate) => candidate.id === event.id);
    if (existing) {
      if (existing.eventDigest !== event.eventDigest) throw new Error(`WorkEvent id '${event.id}' already exists with different content.`);
      result = { status: "deduplicated", event: existing, path };
      return current;
    }
    result = { status: "appended", event, path };
    return Buffer.concat([current, Buffer.from(`${JSON.stringify(event)}\n`, "utf8")]);
  });
  return result!;
}
