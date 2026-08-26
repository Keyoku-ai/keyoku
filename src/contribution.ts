import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";

import { ArchitectureProjectionSchema, renderArchitectureSvg, scanArchitecture, type ArchitectureProjection } from "./architecture.js";
import { mediaSignatureMatches, mediaTypeForPath, readBoundedArtifact } from "./artifact-safety.js";
import { evaluateAssertion } from "./assert.js";
import { canonicalJson, canonicalJsonDigest, parseJsonBytesRejectDuplicateKeys, parseJsonRejectDuplicateKeys } from "./canonical-json.js";
import { runProbe } from "./probes.js";
import { ProofSessionStateSchema, readProofSession, type ProofSessionState } from "./proof-session.js";
import { readLocalLedger, resolvePrivateDirectory, updateLocalLedger } from "./local-ledger.js";
import { redactSecrets } from "./redaction.js";
import {
  assertOriginalSourceUnchanged,
  captureSourceTreeDigest,
  createSourceCapsule,
  disposeSourceCapsule,
  runCommandInSourceCapsule,
  watchOriginalSource,
  withSourceCapsuleCheckout,
  type MutationMonitor,
  type SourceCapsule,
} from "./source-capsule.js";
import {
  AssertOpSchema,
  CriterionInputSchema,
  type ConvergenceReport,
  type CriterionEvaluation,
  type CriterionInput,
  type Probe,
  type ProbeEnvelope,
} from "./types.js";

export const KEYOKU_DIR = ".keyoku";
export const PROJECT_FILE = "project.yaml";

const SlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must be lowercase letters, numbers, dots, dashes, or underscores");
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a sha256 digest");

export const ActorSchema = z.object({
  kind: z.enum(["human", "agent", "organization"]),
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().optional(),
  ownerId: z.string().optional(),
  harness: z.string().optional(),
  model: z.string().optional(),
}).strict();

export const ProjectManifestSchema = z.object({
  schemaVersion: z.literal("keyoku.dev/project/v1alpha1"),
  id: SlugSchema,
  name: z.string().min(1),
  summary: z.string().min(1),
  repository: z.string().optional(),
  defaultBranch: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const EvidencePresentationSchema = z.object({
  summary: z.string().min(1),
  whyItMatters: z.string().min(1),
  code: z.array(z.object({
    path: z.string().min(1),
    purpose: z.string().min(1),
  }).strict()).default([]),
  artifacts: z.array(z.object({
    kind: z.enum(["screenshot", "video", "trace", "report", "log", "code"]),
    path: z.string().min(1),
    label: z.string().min(1),
    caption: z.string().min(1),
    annotations: z.array(z.object({
      label: z.string().min(1),
      detail: z.string().optional(),
      x: z.number().min(0).max(100).optional(),
      y: z.number().min(0).max(100).optional(),
      width: z.number().positive().max(100).optional(),
      height: z.number().positive().max(100).optional(),
      atMs: z.number().int().nonnegative().optional(),
    }).strict()).default([]),
  }).strict()).default([]),
}).strict();

const OutcomeCriterionSchema = CriterionInputSchema.extend({
  evidence: EvidencePresentationSchema.optional(),
});

export const OutcomeSchema = z.object({
  schemaVersion: z.literal("keyoku.dev/outcome/v1alpha1"),
  id: SlugSchema,
  revision: z.number().int().positive(),
  title: z.string().min(1),
  objective: z.string().min(1),
  owner: ActorSchema,
  constraints: z.array(z.string()),
  scope: z.object({
    include: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([]),
    maxChangedFiles: z.number().int().positive().optional(),
  }).strict().optional(),
  criteria: z.array(OutcomeCriterionSchema).min(1),
  humanCriteria: z.array(z.object({
    id: SlugSchema,
    description: z.string().min(1),
    guidance: z.string().optional(),
  }).strict()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const ContributionManifestSchema = z.object({
  schemaVersion: z.literal("keyoku.dev/contribution/v1alpha1"),
  id: SlugSchema,
  title: z.string().min(1),
  summary: z.string().min(1).optional(),
  knownLimits: z.array(z.string().min(1)).optional(),
  outcomeId: SlugSchema,
  outcomeRevision: z.number().int().positive(),
  outcomeDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  baseSha: z.string().min(1),
  actors: z.array(ActorSchema).min(1),
  status: z.enum(["draft", "evaluating", "evidence_gaps", "human_review_required", "review_blocked", "ready_for_review", "accepted"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const ReviewEventSchema = z.object({
  id: SlugSchema,
  decision: z.enum(["note", "accepted"]),
  reviewer: ActorSchema.refine((actor) => actor.kind === "human", "reviewer must be a human"),
  comment: z.string().min(1),
  criterionId: SlugSchema.optional(),
  verdict: z.enum(["pass", "fail"]).optional(),
  reviewedAt: z.string().datetime(),
  factfileId: SlugSchema,
  factfileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  repository: z.object({
    headSha: z.string().min(1),
    worktreeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict().refine((event) => Boolean(event.criterionId) === Boolean(event.verdict), {
  message: "criterionId and verdict must be supplied together",
});

export type Actor = z.infer<typeof ActorSchema>;
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
export type ContributionManifest = z.infer<typeof ContributionManifestSchema>;
export type ReviewEvent = z.infer<typeof ReviewEventSchema>;
export type EvidencePresentation = z.infer<typeof EvidencePresentationSchema>;

export interface OutcomeHistoryEntry {
  sha: string;
  authoredAt: string;
  author: string;
  subject: string;
  revision?: number;
}

export interface ResolvedEvidencePresentation extends Omit<EvidencePresentation, "artifacts"> {
  artifacts: Array<EvidencePresentation["artifacts"][number] & {
    digest?: string;
    mediaType?: string;
    dataUrl?: string;
    unavailable?: string;
  }>;
}

export interface VerificationMethod {
  kind: "command" | "http" | "mcp";
  label: string;
  reproduce: string;
  assertion: ConvergenceReport["criteria"][number]["expected"];
}

export interface RepositorySnapshot {
  repositoryRoot: string;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  remote?: string;
  lastCommit: string;
  baseSha: string;
  headSha: string;
  worktreeDigest: string;
  sourceCapsuleDigest: string;
  dirty: boolean;
  changedFiles: string[];
}

export interface ScopeAssessment {
  declared: boolean;
  passed: boolean;
  includedPaths: string[];
  unexpectedPaths: string[];
  excludedPaths: string[];
  maxChangedFiles?: number;
  topLevelAreas: Array<{ name: string; files: number }>;
  note: string;
}

export interface ReviewAttentionItem {
  priority: "critical" | "high" | "normal";
  title: string;
  why: string;
  paths: string[];
  basis: "deterministic" | "declared";
}

export interface GateSnapshot {
  schemaVersion: "keyoku.dev/factfile/v1alpha1";
  id: string;
  project: Pick<ProjectManifest, "id" | "name" | "summary">;
  outcome: Pick<Outcome, "id" | "revision" | "title" | "objective" | "constraints" | "scope" | "owner" | "humanCriteria">;
  contribution: ContributionManifest;
  repository: RepositorySnapshot;
  scope: ScopeAssessment;
  reviewPlan: ReviewAttentionItem[];
  session: ProofSessionState;
  architecture?: ArchitectureProjection;
  state: "evidence_gaps" | "human_review_required" | "review_blocked" | "ready_for_review" | "accepted";
  generatedAt: string;
  reviews: ReviewEvent[];
  evidence: Array<ConvergenceReport["criteria"][number] & {
    presentation?: ResolvedEvidencePresentation;
    verification: VerificationMethod;
  }>;
  summary: {
    passed: number;
    failed: number;
    total: number;
    verified: boolean;
  };
  humanReview: {
    passed: number;
    failed: number;
    pending: number;
    total: number;
  };
  digest: string;
}

const RepositorySnapshotSchema = z.object({
  repositoryRoot: z.string().min(1),
  branch: z.string().min(1),
  upstream: z.string().optional(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  remote: z.string().optional(),
  lastCommit: z.string(),
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  worktreeDigest: DigestSchema,
  sourceCapsuleDigest: DigestSchema,
  dirty: z.boolean(),
  changedFiles: z.array(z.string()),
}).strict().superRefine((repository, context) => {
  if (repository.sourceCapsuleDigest !== repository.worktreeDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceCapsuleDigest"], message: "must equal worktreeDigest" });
  }
});

const ScopeAssessmentSchema = z.object({
  declared: z.boolean(),
  passed: z.boolean(),
  includedPaths: z.array(z.string()),
  unexpectedPaths: z.array(z.string()),
  excludedPaths: z.array(z.string()),
  maxChangedFiles: z.number().int().positive().optional(),
  topLevelAreas: z.array(z.object({ name: z.string().min(1), files: z.number().int().nonnegative() }).strict()),
  note: z.string().min(1),
}).strict();

const ResolvedPresentationSchema = z.object({
  summary: z.string().min(1),
  whyItMatters: z.string().min(1),
  code: z.array(z.object({ path: z.string().min(1), purpose: z.string().min(1) }).strict()),
  artifacts: z.array(z.object({
    kind: z.enum(["screenshot", "video", "trace", "report", "log", "code"]),
    path: z.string().min(1),
    label: z.string().min(1),
    caption: z.string().min(1),
    annotations: z.array(z.object({
      label: z.string().min(1),
      detail: z.string().optional(),
      x: z.number().min(0).max(100).optional(),
      y: z.number().min(0).max(100).optional(),
      width: z.number().positive().max(100).optional(),
      height: z.number().positive().max(100).optional(),
      atMs: z.number().int().nonnegative().optional(),
    }).strict()),
    digest: DigestSchema.optional(),
    mediaType: z.string().min(1).optional(),
    dataUrl: z.string().min(1).optional(),
    unavailable: z.string().min(1).optional(),
  }).strict()),
}).strict();

const ExpectedObservationSchema = z.object({
  op: AssertOpSchema,
  value: z.unknown().optional(),
  path: z.string(),
}).strict();

const FactfileEvidenceSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  pass: z.boolean(),
  actual: z.unknown(),
  expected: ExpectedObservationSchema,
  error: z.string().optional(),
  note: z.string().optional(),
  durationMs: z.number().nonnegative(),
  presentation: ResolvedPresentationSchema.optional(),
  verification: z.object({
    kind: z.enum(["command", "http", "mcp"]),
    label: z.string().min(1),
    reproduce: z.string().min(1),
    assertion: ExpectedObservationSchema,
  }).strict(),
}).strict().superRefine((evidence, context) => {
  if (!Object.prototype.hasOwnProperty.call(evidence, "actual")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["actual"], message: "is required" });
});

export const GateSnapshotSchema = z.object({
  schemaVersion: z.literal("keyoku.dev/factfile/v1alpha1"),
  id: SlugSchema,
  project: ProjectManifestSchema.pick({ id: true, name: true, summary: true }).strict(),
  outcome: z.object({
    id: SlugSchema,
    revision: z.number().int().positive(),
    title: z.string().min(1),
    objective: z.string().min(1),
    constraints: z.array(z.string()),
    scope: z.object({
      include: z.array(z.string().min(1)),
      exclude: z.array(z.string().min(1)),
      maxChangedFiles: z.number().int().positive().optional(),
    }).strict().optional(),
    owner: ActorSchema,
    humanCriteria: z.array(z.object({ id: SlugSchema, description: z.string().min(1), guidance: z.string().optional() }).strict()),
  }).strict(),
  contribution: ContributionManifestSchema,
  repository: RepositorySnapshotSchema,
  scope: ScopeAssessmentSchema,
  reviewPlan: z.array(z.object({
    priority: z.enum(["critical", "high", "normal"]),
    title: z.string().min(1),
    why: z.string().min(1),
    paths: z.array(z.string()),
    basis: z.enum(["deterministic", "declared"]),
  }).strict()),
  session: ProofSessionStateSchema,
  architecture: ArchitectureProjectionSchema.optional(),
  state: z.enum(["evidence_gaps", "human_review_required", "review_blocked", "ready_for_review", "accepted"]),
  generatedAt: z.string().datetime(),
  reviews: z.array(ReviewEventSchema),
  evidence: z.array(FactfileEvidenceSchema),
  summary: z.object({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    verified: z.boolean(),
  }).strict(),
  humanReview: z.object({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  digest: DigestSchema,
}).strict().superRefine((snapshot, context) => {
  const issue = (path: Array<string | number>, message: string) => context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (snapshot.contribution.outcomeId !== snapshot.outcome.id || snapshot.contribution.outcomeRevision !== snapshot.outcome.revision) {
    issue(["contribution", "outcomeId"], "must match the embedded outcome identity");
  }
  if (snapshot.contribution.status !== snapshot.state) issue(["contribution", "status"], "must match the Factfile state");
  if (snapshot.summary.total !== snapshot.evidence.length) issue(["summary", "total"], "must equal evidence length");
  if (snapshot.summary.passed !== snapshot.evidence.filter((item) => item.pass).length) issue(["summary", "passed"], "must equal passing evidence count");
  if (snapshot.summary.failed !== snapshot.evidence.filter((item) => !item.pass).length) issue(["summary", "failed"], "must equal failed evidence count");
  if (snapshot.summary.passed + snapshot.summary.failed !== snapshot.summary.total) issue(["summary"], "passed plus failed must equal total");
  const expectedVerified = snapshot.summary.failed === 0 && snapshot.summary.total > 0 && snapshot.scope.passed;
  if (snapshot.summary.verified !== expectedVerified) issue(["summary", "verified"], "must equal passing evidence plus scope status");
  snapshot.evidence.forEach((evidence, index) => {
    if (canonicalJson(evidence.expected) !== canonicalJson(evidence.verification.assertion)) {
      issue(["evidence", index, "verification", "assertion"], "must match the recorded expected observation");
    }
  });
  if (snapshot.humanReview.total !== snapshot.outcome.humanCriteria.length) issue(["humanReview", "total"], "must equal declared human criteria");
  if (snapshot.humanReview.passed + snapshot.humanReview.failed + snapshot.humanReview.pending !== snapshot.humanReview.total) issue(["humanReview"], "passed, failed, and pending must equal total");
  const humanCriterionIds = new Set(snapshot.outcome.humanCriteria.map((criterion) => criterion.id));
  const verdicts = new Map<string, "pass" | "fail">();
  snapshot.reviews.forEach((review, index) => {
    if (review.reviewer.kind !== "human") issue(["reviews", index, "reviewer", "kind"], "must be human");
    if (review.repository.headSha !== snapshot.repository.headSha || review.repository.worktreeDigest !== snapshot.repository.worktreeDigest) issue(["reviews", index, "repository"], "must match the Factfile source");
    if (review.criterionId) {
      if (!humanCriterionIds.has(review.criterionId)) issue(["reviews", index, "criterionId"], "must identify a declared human criterion");
      if (review.verdict) verdicts.set(review.criterionId, review.verdict);
    }
  });
  const humanPassed = [...verdicts.values()].filter((verdict) => verdict === "pass").length;
  const humanFailed = [...verdicts.values()].filter((verdict) => verdict === "fail").length;
  if (snapshot.humanReview.passed !== humanPassed) issue(["humanReview", "passed"], "must equal the latest passing human verdict count");
  if (snapshot.humanReview.failed !== humanFailed) issue(["humanReview", "failed"], "must equal the latest failed human verdict count");
  if (snapshot.humanReview.pending !== snapshot.humanReview.total - humanPassed - humanFailed) issue(["humanReview", "pending"], "must equal the remaining human criteria");
  if (snapshot.state === "evidence_gaps" && snapshot.summary.verified) issue(["state"], "evidence_gaps cannot be verified");
  if (snapshot.state !== "evidence_gaps" && !snapshot.summary.verified) issue(["state"], "a reviewable state requires verified automated evidence");
  if (snapshot.state === "human_review_required" && snapshot.humanReview.pending === 0) issue(["state"], "requires a pending human criterion");
  if (snapshot.state === "review_blocked" && snapshot.humanReview.failed === 0) issue(["state"], "requires a failed human criterion");
  if (["ready_for_review", "accepted"].includes(snapshot.state) && (snapshot.humanReview.pending > 0 || snapshot.humanReview.failed > 0)) issue(["state"], "requires all human criteria to pass");
  if (snapshot.state === "accepted" && !snapshot.reviews.some((review) => review.decision === "accepted")) issue(["state"], "accepted requires a human acceptance event");
});

export interface FactfileHistoryItem {
  id: string;
  generatedAt: string;
  state: GateSnapshot["state"];
  digest: string;
  headSha: string;
  worktreeDigest: string;
  passed: number;
  total: number;
  humanPassed: number;
  humanTotal: number;
}

export interface InitProjectInput {
  root?: string;
  id?: string;
  name?: string;
  summary?: string;
}

export interface StartContributionInput {
  root?: string;
  outcomeId: string;
  title?: string;
  summary?: string;
  knownLimits?: string[];
  actor?: Actor;
  baseSha?: string;
  reuseActive?: boolean;
}

export interface ReviewContributionInput {
  root?: string;
  contributionId: string;
  decision: "note" | "accepted";
  comment: string;
  criterionId?: string;
  verdict?: "pass" | "fail";
  reviewer?: Actor;
}

function now(): string {
  return new Date().toISOString();
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return normalized || "project";
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(root: string, args: string[], fallback = "unknown"): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function gitRaw(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function gitRequired(root: string, args: string[], label: string): string {
  try {
    const output = execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!output) throw new Error("empty output");
    return output;
  } catch (error) {
    throw new Error(`Cannot establish ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function gitRawRequired(root: string, args: string[], label: string): string {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { throw new Error(`Cannot establish ${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

export function findProjectRoot(start = process.cwd()): string {
  let cursor = resolve(start);
  for (;;) {
    if (existsSync(join(cursor, KEYOKU_DIR, PROJECT_FILE))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`No ${KEYOKU_DIR}/${PROJECT_FILE} found from ${resolve(start)}. Run 'keyoku project init' first.`);
}

function readYaml<S extends z.ZodType>(path: string, schema: S): z.output<S> {
  let value: unknown;
  try {
    value = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid ${path}: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return result.data;
}

function writeYaml(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(value, { lineWidth: 100 }), "utf8");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseReviews(root: string, path: string, bytes: Buffer): ReviewEvent[] {
  return bytes.toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      let value: unknown;
      try { value = parseJsonRejectDuplicateKeys(line, `Invalid ${relative(root, path)} line ${index + 1}`); } catch (error) {
        throw new Error(`Invalid ${relative(root, path)} line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const result = ReviewEventSchema.safeParse(value);
      if (!result.success) throw new Error(`Invalid review event at line ${index + 1}: ${result.error.message}`);
      return result.data;
    });
}

function readReviews(root: string, contributionId: string): ReviewEvent[] {
  const path = join(resolvePrivateDirectory(root, [KEYOKU_DIR, "contributions", slug(contributionId)], false), "reviews.jsonl");
  return parseReviews(root, path, readLocalLedger(path));
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeExclusive(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeAll(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  fsyncDirectory(dirname(path));
}

function writeAtomic(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export interface VerifiedFactfileExpectations {
  contributionId?: string;
  snapshotId?: string;
}

/**
 * The sole trust boundary for persisted Factfiles. Parsing, the complete
 * schema, semantic counters/bindings, and the canonical content digest are
 * checked before any caller may use snapshot fields.
 */
export function readVerifiedFactfile(path: string, expected: VerifiedFactfileExpectations = {}): GateSnapshot {
  let raw: unknown;
  try {
    raw = parseJsonBytesRejectDuplicateKeys(readFileSync(path), `Invalid Factfile ${path}`);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  const result = GateSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid Factfile ${path}: ${result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}`);
  }
  const rawObject = raw as Record<string, unknown>;
  const { digest: claimedDigest, ...unsigned } = rawObject;
  const computedDigest = canonicalJsonDigest(unsigned);
  if (claimedDigest !== computedDigest) {
    throw new Error(`Invalid Factfile ${path}: digest mismatch (claimed ${String(claimedDigest)}, computed ${computedDigest}).`);
  }
  if (expected.contributionId && result.data.contribution.id !== slug(expected.contributionId)) {
    throw new Error(`Invalid Factfile ${path}: contribution '${result.data.contribution.id}' does not match '${slug(expected.contributionId)}'.`);
  }
  if (expected.snapshotId && result.data.id !== expected.snapshotId) {
    throw new Error(`Invalid Factfile ${path}: snapshot '${result.data.id}' does not match '${expected.snapshotId}'.`);
  }
  return result.data as GateSnapshot;
}

export function listFactfileHistory(rootInput: string, contributionId: string): FactfileHistoryItem[] {
  const root = findProjectRoot(rootInput);
  const dir = join(contributionDir(root, contributionId), "snapshots");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const item = readVerifiedFactfile(join(dir, name), { contributionId, snapshotId: name.slice(0, -5) });
      return {
        id: item.id,
        generatedAt: item.generatedAt,
        state: item.state,
        digest: item.digest,
        headSha: item.repository.headSha,
        worktreeDigest: item.repository.worktreeDigest,
        passed: item.summary.passed,
        total: item.summary.total,
        humanPassed: item.humanReview.passed,
        humanTotal: item.humanReview.total,
      } satisfies FactfileHistoryItem;
    })
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

function persistSnapshot(root: string, contribution: ContributionManifest, snapshot: GateSnapshot): void {
  const dir = resolvePrivateDirectory(root, [KEYOKU_DIR, "contributions", slug(contribution.id)]);
  const snapshots = resolvePrivateDirectory(dir, ["snapshots"]);
  const { digest: _previousDigest, ...unsignedSnapshot } = snapshot;
  snapshot.digest = canonicalJsonDigest(unsignedSnapshot);
  const snapshotJson = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  writeExclusive(join(snapshots, `${snapshot.id}.json`), snapshotJson);
  const history = listFactfileHistory(root, contribution.id);
  writeExclusive(join(snapshots, `${snapshot.id}.html`), Buffer.from(renderFactfileHtml(snapshot, { history, historical: true }), "utf8"));
  writeAtomic(join(dir, "manifest.yaml"), Buffer.from(stringify(contribution, { lineWidth: 100 }), "utf8"));
  writeAtomic(join(dir, "factfile.json"), snapshotJson);
  writeAtomic(join(dir, "factfile.md"), Buffer.from(renderFactfileMarkdown(snapshot), "utf8"));
  writeAtomic(join(dir, "factfile.github.md"), Buffer.from(renderFactfileGithubMarkdown(snapshot), "utf8"));
  writeAtomic(join(dir, "factfile.html"), Buffer.from(renderFactfileHtml(snapshot, { history }), "utf8"));
}

function remoteUrl(root: string): string | undefined {
  const value = git(root, ["config", "--get", "remote.origin.url"], "");
  return value || undefined;
}

export function initProject(input: InitProjectInput = {}): ProjectManifest {
  const root = resolve(input.root ?? process.cwd());
  const path = join(root, KEYOKU_DIR, PROJECT_FILE);
  if (existsSync(path)) throw new Error(`${relative(root, path)} already exists; Keyoku will not overwrite it.`);
  const timestamp = now();
  const name = input.name?.trim() || basename(root);
  const manifest: ProjectManifest = {
    schemaVersion: "keyoku.dev/project/v1alpha1",
    id: slug(input.id ?? name),
    name,
    summary: input.summary?.trim() || `Outcomes and contribution evidence for ${name}.`,
    ...(remoteUrl(root) ? { repository: remoteUrl(root) } : {}),
    defaultBranch: git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], "").replace(/^origin\//, "") || "main",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  writeYaml(path, manifest);
  mkdirSync(join(root, KEYOKU_DIR, "outcomes"), { recursive: true });
  mkdirSync(join(root, KEYOKU_DIR, "contributions"), { recursive: true });
  return manifest;
}

export function loadProject(root = findProjectRoot()): ProjectManifest {
  return readYaml(join(root, KEYOKU_DIR, PROJECT_FILE), ProjectManifestSchema);
}

export function loadOutcome(root: string, id: string): Outcome {
  return readYaml(join(root, KEYOKU_DIR, "outcomes", `${slug(id)}.yaml`), OutcomeSchema);
}

export function listOutcomes(root = findProjectRoot()): Outcome[] {
  const dir = join(root, KEYOKU_DIR, "outcomes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => readYaml(join(dir, name), OutcomeSchema));
}

/** Outcome contracts are normal repository files. Their canonical version
 * history is Git, so reviewers do not need a second opaque database. */
export function listOutcomeHistory(rootInput: string | undefined, id: string): OutcomeHistoryEntry[] {
  const root = findProjectRoot(rootInput);
  const path = `${KEYOKU_DIR}/outcomes/${slug(id)}.yaml`;
  const output = gitRaw(root, ["log", "--follow", "--format=%H%x1f%aI%x1f%an%x1f%s", "--", path]);
  return output.split("\n").filter(Boolean).map((line) => {
    const [sha = "unknown", authoredAt = "unknown", author = "unknown", subject = ""] = line.split("\x1f");
    let revision: number | undefined;
    try {
      const contents = execFileSync("git", ["show", `${sha}:${path}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      revision = OutcomeSchema.parse(parse(contents)).revision;
    } catch { /* a historical revision may predate the current schema */ }
    return { sha, authoredAt, author, subject, ...(revision ? { revision } : {}) };
  });
}

function defaultActor(root: string): Actor {
  const email = git(root, ["config", "user.email"], "local-human");
  const name = git(root, ["config", "user.name"], "Local human");
  return { kind: "human", id: email, name, role: "accountable owner" };
}

function contributionDir(root: string, id: string): string {
  return join(root, KEYOKU_DIR, "contributions", slug(id));
}

interface ActiveContributionIndex { schemaVersion: "keyoku.dev/active-contributions/v1alpha1"; active: Record<string, string>; }

function activeContributionKey(root: string, outcomeId: string): string {
  return `${git(root, ["branch", "--show-current"], "detached")}:${slug(outcomeId)}`;
}

function activeContributionPath(root: string): string { return join(root, KEYOKU_DIR, "runtime", "active-contributions.json"); }

function readActiveIndex(root: string): ActiveContributionIndex {
  const path = activeContributionPath(root);
  if (!existsSync(path)) return { schemaVersion: "keyoku.dev/active-contributions/v1alpha1", active: {} };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ActiveContributionIndex;
    return value.schemaVersion === "keyoku.dev/active-contributions/v1alpha1" && value.active ? value : { schemaVersion: "keyoku.dev/active-contributions/v1alpha1", active: {} };
  } catch { return { schemaVersion: "keyoku.dev/active-contributions/v1alpha1", active: {} }; }
}

export function getActiveContribution(rootInput: string | undefined, outcomeId: string): ContributionManifest | undefined {
  const root = findProjectRoot(rootInput);
  const id = readActiveIndex(root).active[activeContributionKey(root, outcomeId)];
  if (!id) return undefined;
  try {
    const contribution = loadContribution(root, id);
    const outcome = loadOutcome(root, outcomeId);
    const digest = canonicalJsonDigest(outcome);
    return contribution.outcomeRevision === outcome.revision && (!contribution.outcomeDigest || contribution.outcomeDigest === digest) && contribution.status !== "accepted" ? contribution : undefined;
  } catch { return undefined; }
}

function setActiveContribution(root: string, outcomeId: string, contributionId: string): void {
  const index = readActiveIndex(root);
  index.active[activeContributionKey(root, outcomeId)] = contributionId;
  writeJson(activeContributionPath(root), index);
}

export function loadContribution(root: string, id: string): ContributionManifest {
  return readYaml(join(contributionDir(root, id), "manifest.yaml"), ContributionManifestSchema);
}

export function startContribution(input: StartContributionInput): ContributionManifest {
  const root = findProjectRoot(input.root);
  const outcome = loadOutcome(root, input.outcomeId);
  if (input.reuseActive) {
    const active = getActiveContribution(root, outcome.id);
    if (active) return active;
  }
  const timestamp = now();
  const id = slug(`${outcome.id}-${timestamp.slice(0, 10)}-${randomUUID().slice(0, 8)}`);
  const primaryActor = input.actor ?? defaultActor(root);
  const actors = primaryActor.kind === "human"
    ? [primaryActor]
    : [outcome.owner, primaryActor];
  const manifest: ContributionManifest = {
    schemaVersion: "keyoku.dev/contribution/v1alpha1",
    id,
    title: input.title?.trim() || outcome.title,
    summary: input.summary?.trim() || input.title?.trim() || outcome.title,
    ...(input.knownLimits?.length ? { knownLimits: input.knownLimits } : {}),
    outcomeId: outcome.id,
    outcomeRevision: outcome.revision,
    outcomeDigest: canonicalJsonDigest(outcome),
    baseSha: gitRequired(root, ["rev-parse", "--verify", input.baseSha ?? "HEAD"], "the contribution base revision"),
    actors,
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  writeYaml(join(contributionDir(root, id), "manifest.yaml"), manifest);
  setActiveContribution(root, outcome.id, id);
  return manifest;
}

function ignoredEvidencePath(path: string): boolean {
  // Evidence artifacts describe the source snapshot; they are not themselves
  // part of that snapshot. Excluding them prevents generating a Factfile from
  // making its own proof stale. Outcome and project contracts remain included.
  return path.startsWith(".keyoku/contributions/") || path.startsWith(".keyoku/pulse/") || path.startsWith(".keyoku/runtime/");
}

export function captureRepository(root: string, baseSha: string): RepositorySnapshot {
  const verifiedBaseSha = gitRequired(root, ["rev-parse", "--verify", baseSha], "the repository base revision");
  const headSha = gitRequired(root, ["rev-parse", "--verify", "HEAD"], "the repository head revision");
  const branch = git(root, ["branch", "--show-current"], "detached");
  const upstream = git(root, ["rev-parse", "--abbrev-ref", "@{upstream}"], "");
  const [behind = 0, ahead = 0] = upstream
    ? git(root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`], "0\t0").split(/\s+/).map((value) => Number(value) || 0)
    : [0, 0];
  // Porcelain's first column may intentionally be a space. Do not pass this
  // through git(), which trims output and would corrupt the first path.
  const porcelain = gitRawRequired(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "the NUL-delimited worktree status");
  const porcelainEntries = porcelain.split("\0").filter(Boolean);
  const worktreeFiles: string[] = [];
  for (let index = 0; index < porcelainEntries.length; index += 1) {
    const entry = porcelainEntries[index]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const destination = porcelainEntries[index + 1];
      if (destination) { worktreeFiles.push(destination); index += 1; }
      else worktreeFiles.push(path);
    } else worktreeFiles.push(path);
  }
  const sourceFiles = worktreeFiles
    .filter((path) => !ignoredEvidencePath(path))
    .sort();
  const committedFiles = gitRawRequired(root, ["diff", "--name-only", "-z", `${verifiedBaseSha}...${headSha}`], "the NUL-delimited committed path set")
    .split("\0")
    .filter(Boolean)
    .filter((path) => !ignoredEvidencePath(path));
  const changedFiles = [...new Set([...committedFiles, ...sourceFiles])].sort();
  const sourceCapsuleDigest = captureSourceTreeDigest(root);
  return {
    repositoryRoot: root,
    branch,
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    ...(remoteUrl(root) ? { remote: remoteUrl(root) } : {}),
    lastCommit: git(root, ["log", "-1", "--pretty=%s"], "unknown"),
    baseSha: verifiedBaseSha,
    headSha,
    worktreeDigest: sourceCapsuleDigest,
    sourceCapsuleDigest,
    // A committed base-to-head diff is the contribution under review, not a
    // dirty worktree. Keep these concepts separate so a clean revision-bound
    // Factfile cannot be mislabeled merely because it contains real changes.
    dirty: sourceFiles.length > 0,
    changedFiles,
  };
}

function pathMatches(path: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\.\//, "");
  if (normalized === "**" || normalized === "**/*") return true;
  if (normalized.endsWith("/**")) return path === normalized.slice(0, -3) || path.startsWith(normalized.slice(0, -2));
  if (normalized.endsWith("/")) return path.startsWith(normalized);
  if (!normalized.includes("*")) return path === normalized;
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(path);
}

function assessScope(outcome: Outcome, changedFiles: string[]): ScopeAssessment {
  const declared = Boolean(outcome.scope);
  const include = outcome.scope?.include ?? [];
  const exclude = outcome.scope?.exclude ?? [];
  const excludedPaths = changedFiles.filter((path) => exclude.some((pattern) => pathMatches(path, pattern)));
  const considered = changedFiles.filter((path) => !excludedPaths.includes(path));
  const unexpectedPaths = include.length
    ? considered.filter((path) => !include.some((pattern) => pathMatches(path, pattern)))
    : [];
  const sizePassed = !outcome.scope?.maxChangedFiles || considered.length <= outcome.scope.maxChangedFiles;
  const passed = unexpectedPaths.length === 0 && sizePassed;
  const areas = new Map<string, number>();
  for (const path of considered) {
    const name = path.includes("/") ? path.split("/")[0]! : "repository root";
    areas.set(name, (areas.get(name) ?? 0) + 1);
  }
  return {
    declared,
    passed,
    includedPaths: considered.filter((path) => !unexpectedPaths.includes(path)),
    unexpectedPaths,
    excludedPaths,
    ...(outcome.scope?.maxChangedFiles ? { maxChangedFiles: outcome.scope.maxChangedFiles } : {}),
    topLevelAreas: [...areas].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
    note: !declared
      ? "No machine scope boundary was declared; a human must judge whether this is one coherent review unit."
      : passed
        ? "All changed paths fit the declared contribution boundary. Semantic coherence still requires human review."
        : "Changed paths exceed the declared contribution boundary.",
  };
}

function buildReviewPlan(
  outcome: Outcome,
  repository: RepositorySnapshot,
  scope: ScopeAssessment,
  report: { criteria: CriterionEvaluation[] },
  reviews: ReviewEvent[],
): ReviewAttentionItem[] {
  const items: ReviewAttentionItem[] = [];
  if (scope.unexpectedPaths.length) items.push({
    priority: "critical",
    title: "Resolve work outside the declared outcome boundary",
    why: "These paths were changed but do not match the repository-owned scope contract.",
    paths: scope.unexpectedPaths.slice(0, 8),
    basis: "deterministic",
  });
  const failed = report.criteria.filter((criterion) => !criterion.pass);
  if (failed.length) items.push({
    priority: "critical",
    title: `Investigate ${failed.length} unsupported ${failed.length === 1 ? "claim" : "claims"}`,
    why: failed.map((criterion) => criterion.description).join(" · "),
    paths: [],
    basis: "deterministic",
  });
  const sensitive = repository.changedFiles.filter((path) => /(^|\/)(auth|security|permission|policy|migration|migrations|schema|secrets?|\.github\/workflows)(\/|\.|$)|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum)$/i.test(path));
  if (sensitive.length) items.push({
    priority: "high",
    title: "Inspect security-, data-, workflow-, or dependency-sensitive changes",
    why: "These paths can alter trust boundaries, persisted data, automation privileges, or the resolved dependency graph.",
    paths: sensitive.slice(0, 8),
    basis: "deterministic",
  });
  if (repository.changedFiles.length > 30 || scope.topLevelAreas.length > 6) items.push({
    priority: "high",
    title: "Confirm this is still one reviewable outcome",
    why: `${repository.changedFiles.length} files across ${scope.topLevelAreas.length} top-level areas increases reconstruction cost; split or stack unrelated work.`,
    paths: [],
    basis: "deterministic",
  });
  const latest = new Map(reviews.filter((review) => review.criterionId && review.verdict).map((review) => [review.criterionId!, review.verdict!]));
  const pending = outcome.humanCriteria.filter((criterion) => !latest.has(criterion.id));
  if (pending.length) items.push({
    priority: "normal",
    title: `Make ${pending.length} explicit human ${pending.length === 1 ? "decision" : "decisions"}`,
    why: pending.map((criterion) => criterion.description).join(" · "),
    paths: [],
    basis: "declared",
  });
  if (!items.length) items.push({
    priority: "normal",
    title: "Review the outcome evidence, then inspect the changed implementation",
    why: "No deterministic scope, failure, or sensitive-path signal requires earlier attention.",
    paths: repository.changedFiles.slice(0, 8),
    basis: "deterministic",
  });
  const weight = { critical: 0, high: 1, normal: 2 } as const;
  return items.sort((a, b) => weight[a.priority] - weight[b.priority]);
}

const MAX_FACTFILE_ACTUAL_CHARS = 2_000;

function capFactfileActual(value: unknown): unknown {
  let serialized: string;
  try { serialized = JSON.stringify(value) ?? "undefined"; }
  catch { serialized = String(value); }
  if (serialized.length <= MAX_FACTFILE_ACTUAL_CHARS) return value;
  return `${serialized.slice(0, MAX_FACTFILE_ACTUAL_CHARS)}… (truncated ${serialized.length - MAX_FACTFILE_ACTUAL_CHARS} chars)`;
}

function probeDidNotComplete(probe: Probe, envelope: ProbeEnvelope): boolean {
  if (envelope.error === undefined) return false;
  if (probe.kind === "command") return envelope.exitCode === -1 || envelope.output === null;
  if (probe.kind === "http") return envelope.status === undefined || envelope.output === null;
  return true;
}

/**
 * Factfile verification is deliberately independent of the v2 goal/workflow
 * engine. It executes only the repository-owned criteria and returns the
 * observations needed by the exact-source snapshot.
 */
async function evaluateFactfileCriteria(
  capsule: SourceCapsule,
  originalMonitor: MutationMonitor,
  criteria: CriterionInput[],
  presentations: Array<EvidencePresentation | undefined>,
): Promise<{
  converged: boolean;
  criteria: CriterionEvaluation[];
  presentations: Array<ResolvedEvidencePresentation | undefined>;
  architecture?: ArchitectureProjection;
}> {
  const evaluations: CriterionEvaluation[] = [];
  for (let index = 0; index < criteria.length; index += 1) {
    const criterion = criteria[index]!;
    const started = Date.now();
    const envelope = criterion.probe.kind === "command"
      ? await runCommandInSourceCapsule(capsule, criterion.probe)
      : await runProbe(criterion.probe);
    const result = evaluateAssertion(envelope, criterion.assert);
    const incomplete = probeDidNotComplete(criterion.probe, envelope);
    const path = (criterion.assert.path ?? "").trim();
    const value = criterion.assert.value;
    const meaningfulFailureAssertion =
      (path === "exitCode" || path === "status") &&
      criterion.assert.op === "eq" &&
      (typeof value === "string" ? value.length > 0 : value != null);
    const pass = result.pass && !incomplete && (!envelope.error || meaningfulFailureAssertion);
    const error = [
      envelope.error,
      result.error,
      result.pass && !pass ? "assertion passed but the probe itself failed — failing the criterion" : undefined,
    ].filter(Boolean).join("; ");
    evaluations.push({
      id: `c${index + 1}`,
      description: criterion.description,
      pass,
      actual: capFactfileActual(result.actual),
      expected: {
        op: criterion.assert.op,
        value: criterion.assert.value,
        path: criterion.assert.path ?? "output",
      },
      ...(error ? { error } : {}),
      ...(result.note ? { note: result.note } : {}),
      durationMs: Date.now() - started,
    });
    await assertOriginalSourceUnchanged(capsule, originalMonitor);
  }
  const capsuleProjection = await withSourceCapsuleCheckout(capsule, (checkout) => {
    let architecture: ArchitectureProjection | undefined;
    try { architecture = scanArchitecture(checkout); } catch { /* architecture is optional for adopted repositories */ }
    return {
      presentations: presentations.map((presentation) => resolveEvidencePresentation(checkout, presentation)),
      architecture,
    };
  });
  return {
    converged: evaluations.every((item) => item.pass),
    criteria: evaluations,
    presentations: capsuleProjection.presentations,
    ...(capsuleProjection.architecture ? { architecture: capsuleProjection.architecture } : {}),
  };
}

function resolveCriteria(root: string, criteria: CriterionInput[]): CriterionInput[] {
  void root;
  return criteria;
}

function summarizeHumanReview(outcome: Pick<Outcome, "humanCriteria">, reviews: ReviewEvent[]): GateSnapshot["humanReview"] {
  const latest = new Map<string, "pass" | "fail">();
  for (const review of reviews) {
    if (review.criterionId && review.verdict) latest.set(review.criterionId, review.verdict);
  }
  let passed = 0;
  let failed = 0;
  for (const criterion of outcome.humanCriteria) {
    const verdict = latest.get(criterion.id);
    if (verdict === "pass") passed += 1;
    if (verdict === "fail") failed += 1;
  }
  return {
    passed,
    failed,
    pending: outcome.humanCriteria.length - passed - failed,
    total: outcome.humanCriteria.length,
  };
}

function reviewsForRepository(reviews: ReviewEvent[], repository: Pick<RepositorySnapshot, "headSha" | "worktreeDigest">): ReviewEvent[] {
  return reviews.filter((review) => review.repository.headSha === repository.headSha && review.repository.worktreeDigest === repository.worktreeDigest);
}

function gateState(machineVerified: boolean, human: GateSnapshot["humanReview"]): GateSnapshot["state"] {
  if (!machineVerified) return "evidence_gaps";
  if (human.failed > 0) return "review_blocked";
  if (human.pending > 0) return "human_review_required";
  return "ready_for_review";
}

function resolveEvidencePresentation(root: string, presentation?: EvidencePresentation): ResolvedEvidencePresentation | undefined {
  if (!presentation) return undefined;
  return {
    summary: presentation.summary,
    whyItMatters: presentation.whyItMatters,
    code: presentation.code,
    artifacts: presentation.artifacts.map((artifact) => {
      let bounded: ReturnType<typeof readBoundedArtifact>;
      try { bounded = readBoundedArtifact(root, artifact.path); }
      catch (error) { return { ...artifact, unavailable: error instanceof Error ? error.message : String(error) }; }
      const bytes = bounded.bytes;
      const digest = hash(bytes);
      if (artifact.kind !== "screenshot" && artifact.kind !== "video") return { ...artifact, digest };
      const limit = artifact.kind === "screenshot" ? 2_000_000 : 12_000_000;
      if (bytes.length > limit) return { ...artifact, digest, unavailable: `${artifact.kind === "screenshot" ? "Screenshot" : "Video"} exceeds the ${limit / 1_000_000} MB portable-report limit.` };
      const mediaType = mediaTypeForPath(artifact.path);
      if (!mediaType) return { ...artifact, digest, unavailable: artifact.kind === "screenshot" ? "Screenshot must be PNG, WebP, or JPEG." : "Video must be MP4 or WebM." };
      if ((artifact.kind === "screenshot") !== mediaType.startsWith("image/")) return { ...artifact, digest, unavailable: `Artifact extension does not match kind '${artifact.kind}'.` };
      if (!mediaSignatureMatches(bytes, mediaType)) return { ...artifact, digest, unavailable: `Artifact bytes do not match the declared ${mediaType} media signature.` };
      return {
        ...artifact,
        digest,
        mediaType,
        dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
      };
    }),
  };
}

function verificationMethod(criterion: CriterionInput): VerificationMethod {
  const assertion = {
    path: criterion.assert.path ?? "output",
    op: criterion.assert.op,
    ...(criterion.assert.value !== undefined ? { value: redactEvidence(criterion.assert.value) } : {}),
  };
  if (criterion.probe.kind === "command") return {
    kind: "command",
    label: "Repository command",
    reproduce: redactSecrets(criterion.probe.run),
    assertion,
  };
  if (criterion.probe.kind === "http") return {
    kind: "http",
    label: "HTTP observation",
    reproduce: `${criterion.probe.method ?? "GET"} ${redactSecrets(criterion.probe.url)}`,
    assertion,
  };
  return {
    kind: "mcp",
    label: "MCP observation",
    reproduce: `${criterion.probe.connector}.${criterion.probe.tool}`,
    assertion,
  };
}

export async function runGate(rootInput: string | undefined, contributionId: string): Promise<GateSnapshot> {
  const root = findProjectRoot(rootInput);
  const project = loadProject(root);
  const contribution = loadContribution(root, contributionId);
  const outcome = loadOutcome(root, contribution.outcomeId);
  if (outcome.revision !== contribution.outcomeRevision) {
    throw new Error(
      `Contribution ${contribution.id} targets outcome revision ${contribution.outcomeRevision}, but revision ${outcome.revision} is current. Start a new contribution or restore the referenced outcome.`,
    );
  }
  const currentOutcomeDigest = canonicalJsonDigest(outcome);
  if (contribution.outcomeDigest && contribution.outcomeDigest !== currentOutcomeDigest) {
    throw new Error(`Outcome '${outcome.id}' changed without a revision increment. Increment its revision and start a new contribution so the proof contract is explicit.`);
  }

  // Acceptance is terminal for the exact source snapshot. An explicit gate
  // rerun on unchanged source returns the same accepted Factfile rather than
  // silently downgrading the contribution to evaluating/ready-for-review.
  if (contribution.status === "accepted") {
    const acceptedPath = join(contributionDir(root, contribution.id), "factfile.json");
    if (!existsSync(acceptedPath)) throw new Error(`Accepted contribution '${contribution.id}' is missing its Factfile.`);
    const accepted = readVerifiedFactfile(acceptedPath, { contributionId: contribution.id });
    if (accepted.state !== "accepted") throw new Error(`Accepted contribution '${contribution.id}' does not contain an accepted Factfile.`);
    const current = captureRepository(root, contribution.baseSha);
    if (accepted.repository.headSha === current.headSha && accepted.repository.worktreeDigest === current.worktreeDigest) return accepted;
  }

  const criteria = resolveCriteria(root, outcome.criteria);
  contribution.status = "evaluating";
  contribution.updatedAt = now();
  writeYaml(join(contributionDir(root, contribution.id), "manifest.yaml"), contribution);
  const sourceBeforeProbes = captureRepository(root, contribution.baseSha);
  const capsule = createSourceCapsule(root);
  if (sourceBeforeProbes.worktreeDigest !== capsule.contentDigest) {
    disposeSourceCapsule(capsule);
    throw new Error("Proof refused: the source changed between repository inspection and immutable capsule capture. Rerun from a stable source tree.");
  }
  let originalMonitor: MutationMonitor;
  try { originalMonitor = watchOriginalSource(capsule); }
  catch (error) {
    disposeSourceCapsule(capsule);
    throw error;
  }
  try {
    await assertOriginalSourceUnchanged(capsule, originalMonitor);
    originalMonitor.clear();
    const report = await evaluateFactfileCriteria(capsule, originalMonitor, criteria, outcome.criteria.map((criterion) => criterion.evidence));
    await assertOriginalSourceUnchanged(capsule, originalMonitor);
    const repository = captureRepository(root, contribution.baseSha);
    if (repository.headSha !== sourceBeforeProbes.headSha || repository.worktreeDigest !== capsule.contentDigest) {
      throw new Error("Proof refused: the source no longer matches the immutable verification capsule. Restore or retain the intended changes, then rerun proof.");
    }
    const scope = assessScope(outcome, repository.changedFiles);
    const architecture = report.architecture;
    const generatedAt = now();
    // A human verdict is evidence for one exact source identity. Keep the
    // append-only review ledger intact, but never project a verdict from an old
    // head/worktree into a newly generated Factfile.
    const reviews = reviewsForRepository(readReviews(root, contribution.id), repository);
    const humanReview = summarizeHumanReview(outcome, reviews);
    const reviewPlan = buildReviewPlan(outcome, repository, scope, report, reviews);
    const snapshotBase = {
      schemaVersion: "keyoku.dev/factfile/v1alpha1" as const,
      id: `fact_${generatedAt.replace(/[-:.TZ]/g, "")}_${randomUUID().slice(0, 8)}`,
      project: { id: project.id, name: project.name, summary: project.summary },
      outcome: {
        id: outcome.id,
        revision: outcome.revision,
        title: outcome.title,
        objective: outcome.objective,
        constraints: outcome.constraints,
        ...(outcome.scope ? { scope: outcome.scope } : {}),
        owner: outcome.owner,
        humanCriteria: outcome.humanCriteria,
      },
      contribution: { ...contribution },
      repository,
      scope,
      reviewPlan,
      session: readProofSession(root, contribution.id),
      ...(architecture ? { architecture } : {}),
      state: gateState(report.converged && scope.passed, humanReview),
      generatedAt,
      reviews,
      evidence: report.criteria.map((item, index) => ({
        ...item,
        actual: redactEvidence(item.actual),
        verification: verificationMethod(outcome.criteria[index]!),
        ...(item.error ? { error: redactSecrets(item.error) } : {}),
        ...(item.note ? { note: redactSecrets(item.note) } : {}),
        ...(report.presentations[index] ? { presentation: report.presentations[index] } : {}),
      })),
      summary: {
        passed: report.criteria.filter((item) => item.pass).length,
        failed: report.criteria.filter((item) => !item.pass).length,
        total: report.criteria.length,
        verified: report.converged && scope.passed,
      },
      humanReview,
    };
    const snapshot: GateSnapshot = { ...snapshotBase, digest: canonicalJsonDigest(snapshotBase) };
    await assertOriginalSourceUnchanged(capsule, originalMonitor);
    contribution.status = snapshot.state;
    contribution.updatedAt = generatedAt;
    snapshot.contribution.status = contribution.status;
    snapshot.contribution.updatedAt = contribution.updatedAt;
    persistSnapshot(root, contribution, snapshot);
    await assertOriginalSourceUnchanged(capsule, originalMonitor);
    const sourceAfterPersist = captureRepository(root, contribution.baseSha);
    if (sourceAfterPersist.headSha !== repository.headSha || sourceAfterPersist.worktreeDigest !== capsule.contentDigest) {
      throw new Error("Proof refused: the source checkout changed before Factfile persistence completed. The generated files are stale and must not be reported; rerun proof.");
    }
    return snapshot;
  } finally {
    originalMonitor.close();
    disposeSourceCapsule(capsule);
  }
}

export function reviewContribution(input: ReviewContributionInput): GateSnapshot {
  const root = findProjectRoot(input.root);
  const contribution = loadContribution(root, input.contributionId);
  const path = join(contributionDir(root, contribution.id), "factfile.json");
  if (!existsSync(path)) throw new Error(`No Factfile for '${contribution.id}'. Run 'keyoku gate ${contribution.id}' first.`);
  const reviewer = input.reviewer ?? defaultActor(root);
  const reviewerResult = ActorSchema.safeParse(reviewer);
  if (!reviewerResult.success || reviewer.kind !== "human") {
    throw new Error("Only an identified human can record review or acceptance.");
  }
  const comment = input.comment.trim();
  if (!comment) throw new Error("A review comment is required.");
  if (Boolean(input.criterionId) !== Boolean(input.verdict)) {
    throw new Error("A human criterion review requires both criterionId and verdict.");
  }
  const reviewsPath = join(resolvePrivateDirectory(root, [KEYOKU_DIR, "contributions", slug(contribution.id)]), "reviews.jsonl");
  let snapshot!: GateSnapshot;
  let event!: ReviewEvent;
  let reviewedAt!: string;
  updateLocalLedger(reviewsPath, (ledger) => {
    snapshot = readVerifiedFactfile(path, { contributionId: contribution.id });
    const current = captureRepository(root, contribution.baseSha);
    if (snapshot.repository.headSha !== current.headSha || snapshot.repository.worktreeDigest !== current.worktreeDigest) {
      throw new Error("The repository changed after this Factfile was generated. Run the gate again before reviewing or accepting it.");
    }
    const projected = reviewsForRepository(parseReviews(root, reviewsPath, ledger), current);
    if (canonicalJsonDigest(projected) !== canonicalJsonDigest(snapshot.reviews ?? [])) {
      throw new Error("The review ledger is ahead of the Factfile projection. Rerun the gate to rebuild the projection before adding another review.");
    }
    if (input.criterionId && !snapshot.outcome.humanCriteria.some((criterion) => criterion.id === input.criterionId)) {
      throw new Error(`Unknown human criterion '${input.criterionId}'.`);
    }
    if (snapshot.state === "accepted" && input.decision === "accepted") {
      throw new Error("This exact Factfile is already accepted.");
    }
    if (snapshot.state === "accepted" && input.criterionId) {
      throw new Error("Accepted is terminal for this exact Factfile. Create new source evidence before changing a criterion verdict.");
    }
    if (input.decision === "accepted" && snapshot.state !== "ready_for_review") {
      throw new Error("Only a ready-for-review Factfile can be accepted. Resolve evidence gaps and run the gate again.");
    }
    reviewedAt = now();
    event = ReviewEventSchema.parse({
      id: slug(`review-${reviewedAt.replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`),
      decision: input.decision,
      reviewer,
      comment,
      ...(input.criterionId ? { criterionId: input.criterionId, verdict: input.verdict } : {}),
      reviewedAt,
      factfileId: snapshot.id,
      factfileDigest: snapshot.digest,
      repository: { headSha: current.headSha, worktreeDigest: current.worktreeDigest },
    });
    return Buffer.concat([ledger, Buffer.from(`${JSON.stringify(event)}\n`, "utf8")]);
  });
  snapshot.id = `fact_${reviewedAt.replace(/[-:.TZ]/g, "")}_${randomUUID().slice(0, 8)}`;
  snapshot.generatedAt = reviewedAt;
  snapshot.reviews = [...(snapshot.reviews ?? []), event];
  snapshot.session = readProofSession(root, contribution.id);
  snapshot.humanReview = summarizeHumanReview(snapshot.outcome, snapshot.reviews);
  if (input.decision === "accepted" || snapshot.state === "accepted") {
    snapshot.state = "accepted";
    contribution.status = "accepted";
  } else {
    snapshot.state = gateState(snapshot.summary.verified, snapshot.humanReview);
    contribution.status = snapshot.state;
  }
  contribution.updatedAt = reviewedAt;
  snapshot.contribution = { ...contribution };
  persistSnapshot(root, contribution, snapshot);
  return snapshot;
}

export async function publishFactfile(
  rootInput: string | undefined,
  contributionId: string,
  engineUrl: string,
  token?: string,
): Promise<unknown> {
  const root = findProjectRoot(rootInput);
  const base = new URL(engineUrl);
  if (base.username || base.password) {
    throw new Error("Engine URLs must not embed credentials; use KEYOKU_ENGINE_TOKEN.");
  }
  const loopback = base.hostname === "127.0.0.1" || base.hostname === "localhost" || base.hostname === "::1";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    throw new Error("Factfiles may be published only over HTTPS or loopback HTTP.");
  }
  const path = join(contributionDir(root, contributionId), "factfile.json");
  if (!existsSync(path)) throw new Error(`No Factfile for '${contributionId}'. Run 'keyoku gate ${contributionId}' first.`);
  const snapshot = readVerifiedFactfile(path, { contributionId });
  const current = captureRepository(root, snapshot.repository.baseSha);
  if (snapshot.repository.headSha !== current.headSha || snapshot.repository.worktreeDigest !== current.worktreeDigest) {
    throw new Error("The repository changed after this Factfile was generated. Run the gate again before publishing it.");
  }
  const endpoint = new URL("/api/v1/factfiles", base);
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: readFileSync(path),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* preserve non-JSON server detail */ }
  if (!response.ok) {
    throw new Error(`Engine rejected Factfile (${response.status}): ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

const SECRET_KEY = /token|secret|passwd|password|api[_-]?key|access[_-]?key|credential|authorization|cookie/i;

/** Factfiles are designed to be shared. Redact both credential-shaped strings
 * and values stored under credential-shaped object keys before evidence ever
 * reaches JSON, Markdown, HTML, or the optional shared engine. */
function redactEvidence(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? "«redacted»" : redactEvidence(item),
      ]),
    );
  }
  return value;
}

export function renderFactfileMarkdown(snapshot: GateSnapshot): string {
  const mark = snapshot.state.replaceAll("_", " ").toUpperCase();
  const evidence = snapshot.evidence
    .map((item) => {
      const story = item.presentation
        ? `\n  - What it shows: ${item.presentation.summary}\n  - Why it matters: ${item.presentation.whyItMatters}${item.presentation.code.map((ref) => `\n  - Code: \`${ref.path}\` — ${ref.purpose}`).join("")}${item.presentation.artifacts.map((artifact) => `\n  - Artifact: ${artifact.label} (\`${artifact.path}\`) — ${artifact.caption}`).join("")}`
        : "\n  - No human-facing evidence explanation was supplied.";
      return `- **${item.pass ? "PASS" : "FAIL"} — ${item.description}**${story}\n  - Audit observation: \`${printable(item.actual).replace(/`/g, "\\`")}\`${item.error ? `\n  - error: ${item.error}` : ""}`;
    })
    .join("\n");
  const reviews = snapshot.reviews.length
    ? snapshot.reviews.map((review) => `- **${review.decision === "accepted" ? "Accepted" : "Review note"}** by ${review.reviewer.name} at ${review.reviewedAt}: ${review.comment}`).join("\n")
    : "No human review recorded yet.";
  const latestHuman = new Map(snapshot.reviews.filter((review) => review.criterionId && review.verdict).map((review) => [review.criterionId!, review]));
  const humanCriteria = snapshot.outcome.humanCriteria.length
    ? snapshot.outcome.humanCriteria.map((criterion) => {
        const review = latestHuman.get(criterion.id);
        return `- **${review?.verdict?.toUpperCase() ?? "PENDING"} — ${criterion.description}**${review ? `\n  - ${review.comment} — ${review.reviewer.name}` : criterion.guidance ? `\n  - ${criterion.guidance}` : ""}`;
      }).join("\n")
    : "No additional human judgment criteria declared.";
  const reviewPlan = snapshot.reviewPlan.map((item) => `- **${item.priority.toUpperCase()} — ${item.title}**\n  - ${item.why}${item.paths.length ? `\n  - Paths: ${item.paths.map((path) => `\`${path}\``).join(", ")}` : ""}`).join("\n");
  return `# ${snapshot.outcome.title}\n\n**Gate: ${mark}** · automated ${snapshot.summary.passed}/${snapshot.summary.total} · human ${snapshot.humanReview.passed}/${snapshot.humanReview.total} · exact snapshot \`${snapshot.repository.headSha.slice(0, 12)}+${snapshot.repository.worktreeDigest.slice(0, 12)}\`\n\n## Outcome\n\n${snapshot.outcome.objective}\n\n## Review this first\n\n${reviewPlan}\n\n## Accountable people and agents\n\n${snapshot.contribution.actors.map((actor) => `- ${actor.name} (${actor.kind}${actor.role ? `, ${actor.role}` : ""}${actor.harness ? `; harness: ${actor.harness}` : ""}${actor.model ? `; model: ${actor.model}` : ""})`).join("\n")}\n\n## Automated evidence\n\n${evidence}\n\n## Required human judgments\n\n${humanCriteria}\n\n## Human review history\n\n${reviews}\n\n## Scope\n\n- Base: \`${snapshot.repository.baseSha}\`\n- Head: \`${snapshot.repository.headSha}\`\n- Worktree digest: \`${snapshot.repository.worktreeDigest}\`\n- Changed files: ${snapshot.repository.changedFiles.length}\n- Factfile digest: \`${snapshot.digest}\`\n\nGenerated by Keyoku at ${snapshot.generatedAt}. Automated verification and human judgment are reported separately; neither is a universal safety claim. “Accepted” additionally means the named human accepted this exact snapshot.\n`;
}

function githubState(snapshot: GateSnapshot): { icon: string; label: string; message: string } {
  if (snapshot.state === "accepted") return { icon: "✅", label: "Accepted", message: "A named human accepted this exact snapshot." };
  if (snapshot.state === "ready_for_review") return { icon: "✅", label: "Ready for review", message: "Declared automated and human criteria pass; acceptance remains explicit." };
  if (snapshot.state === "human_review_required") return { icon: "🟡", label: "Human review needed", message: "Repository checks pass. The acceptance questions below still require maintainer judgment." };
  if (snapshot.state === "review_blocked") return { icon: "🔴", label: "Review blocked", message: "A required human judgment currently blocks acceptance." };
  return { icon: "🔴", label: "Evidence gaps", message: "One or more declared claims are not supported at this revision." };
}

/** A deliberately short GitHub surface. It gives a reviewer the result and
 * remaining attention first; the portable HTML/JSON artifacts hold the full
 * teaching and audit views. */
export function renderFactfileGithubMarkdown(snapshot: GateSnapshot): string {
  const status = githubState(snapshot);
  const latestHuman = new Map(snapshot.reviews.filter((review) => review.criterionId && review.verdict).map((review) => [review.criterionId!, review]));
  const supported = snapshot.evidence.filter((item) => item.pass).map((item) => {
    const explanation = item.presentation?.summary ?? "The declared observation matched its rule; no reviewer-facing artifact was supplied.";
    const artifactCount = item.presentation?.artifacts.filter((artifact) => artifact.digest && !artifact.unavailable).length ?? 0;
    return `- ✅ **${item.description}** — ${explanation}${artifactCount ? ` _(${artifactCount} content-bound ${artifactCount === 1 ? "artifact" : "artifacts"})_` : ""}`;
  }).join("\n") || "- No automated claim is currently supported.";
  const gaps = snapshot.evidence.filter((item) => !item.pass).map((item) => `- ❌ **${item.description}** — ${item.error ?? "The observed result did not match the declared rule."}`).join("\n");
  const claimDetails = snapshot.evidence.map((item) => {
    const presentation = item.presentation;
    const artifacts = presentation?.artifacts.length
      ? presentation.artifacts.map((artifact) => `- ${artifact.unavailable ? "⚠️" : "📎"} **${artifact.label}** — ${artifact.caption} (\`${artifact.path}\`${artifact.digest ? ` · SHA-256 \`${artifact.digest}\`` : ""}${artifact.unavailable ? ` · ${artifact.unavailable}` : ""})`).join("\n")
      : "- No visual or report artifact was attached.";
    const code = presentation?.code.length
      ? presentation.code.map((ref) => `- \`${ref.path}\` — ${ref.purpose}`).join("\n")
      : "- No code-tour paths were declared.";
    return `<details>\n<summary><strong>${item.pass ? "✅ Supported" : "❌ Evidence gap"} · ${item.description}</strong></summary>\n\n${presentation?.summary ?? "No reviewer-facing explanation was supplied."}\n\n**Why this matters:** ${presentation?.whyItMatters ?? "The outcome author did not explain the relevance of this check."}\n\n**Inspectable artifacts**\n\n${artifacts}\n\n**Relevant code**\n\n${code}\n\n**Reproduce**\n\n\`${item.verification.reproduce.replace(/`/g, "\\`")}\`\n\n<sub>${item.verification.label} · completed in ${item.durationMs}ms · rule: \`${printable(item.verification.assertion).replace(/`/g, "\\`")}\`</sub>\n\n</details>`;
  }).join("\n\n");
  const decisions = snapshot.outcome.humanCriteria.length
    ? snapshot.outcome.humanCriteria.map((criterion) => {
        const review = latestHuman.get(criterion.id);
        const verdict = review?.verdict === "pass" ? "✅ Passed" : review?.verdict === "fail" ? "❌ Blocked" : "🟡 Needs reviewer";
        return `- **${verdict}:** ${criterion.description}${review ? ` — ${review.comment} _(${review.reviewer.name})_` : criterion.guidance ? `\n  <br><sub>${criterion.guidance}</sub>` : ""}`;
      }).join("\n")
    : "- No additional human judgment criteria were declared.";
  const areas = snapshot.scope.topLevelAreas.length
    ? snapshot.scope.topLevelAreas.map((area) => `\`${area.name}/\` ${area.files}`).join(" · ")
    : "No changed files detected";
  const people = snapshot.contribution.actors.map((actor) => {
    const provenance = [actor.role, actor.harness && `via ${actor.harness}`, actor.model].filter(Boolean).join(" · ");
    return `- **${actor.name}** — ${actor.kind}${provenance ? ` · ${provenance}` : ""}${actor.ownerId ? ` · accountable to ${actor.ownerId}` : ""}`;
  }).join("\n");
  const limits = snapshot.contribution.knownLimits?.length
    ? snapshot.contribution.knownLimits.map((limit) => `- ${limit}`).join("\n")
    : "- Only the claims listed here were evaluated.\n- Passing commands are not a judgment of product fit, maintainability, or universal safety.\n- Any source change requires a new Factfile.";
  const unexpected = snapshot.scope.unexpectedPaths.length
    ? `\n\n> [!CAUTION]\n> **Outside declared scope:** ${snapshot.scope.unexpectedPaths.map((path) => `\`${path}\``).join(", ")}`
    : "";
  const attention = snapshot.reviewPlan.map((item, index) => `${index + 1}. **${item.priority === "critical" ? "🔴" : item.priority === "high" ? "🟠" : "🔵"} ${item.title}** — ${item.why}${item.paths.length ? `\n   <br><sub>${item.paths.map((path) => `\`${path}\``).join(" · ")}</sub>` : ""}`).join("\n");
  const decisionLine = snapshot.state === "human_review_required"
    ? `**Decision: do not accept yet.** ${snapshot.humanReview.pending} named human ${snapshot.humanReview.pending === 1 ? "decision remains" : "decisions remain"}.`
    : snapshot.state === "evidence_gaps" ? `**Decision: evidence is incomplete.** ${snapshot.summary.failed} declared ${snapshot.summary.failed === 1 ? "claim is" : "claims are"} unsupported.`
      : snapshot.state === "review_blocked" ? `**Decision: blocked by human review.** ${snapshot.humanReview.failed} required ${snapshot.humanReview.failed === 1 ? "judgment failed" : "judgments failed"}.`
        : snapshot.state === "accepted" ? "**Decision: accepted.** A named human accepted this exact source snapshot."
          : "**Decision: ready for explicit acceptance.** Every declared automated and human criterion currently passes.";
  return `## ${status.icon} Keyoku · ${status.label}\n\n### ${snapshot.outcome.title}\n\n${decisionLine}\n\n> **Requested outcome:** ${snapshot.outcome.objective}\n>\n> **Delivered change:** ${snapshot.contribution.summary ?? snapshot.contribution.title}\n\n**At a glance:** ${snapshot.summary.passed}/${snapshot.summary.total} automated claims supported · ${snapshot.humanReview.pending} human decisions pending · ${snapshot.repository.changedFiles.length} changed files · exact revision \`${snapshot.repository.headSha.slice(0, 12)}+${snapshot.repository.worktreeDigest.slice(0, 12)}\`\n\n> [!NOTE]\n> **What “proof” means here:** bounded evidence for the declared claims at this exact source snapshot—not proof that the whole project is correct, secure, or ready.\n\n### What is established\n\n${supported}${gaps ? `\n\n### What is not established\n\n${gaps}` : ""}${unexpected}\n\n### What only a human can decide\n\n${decisions}\n\n> [!IMPORTANT]\n> **Make the decision with GitHub's native PR review:** Approve when the outcome is satisfied, or Request changes with the next concrete instruction. The next push produces a new SHA-bound Factfile automatically.\n\n### Review path\n\n${attention}\n\n<details>\n<summary><strong>Open the evidence chain for every claim</strong></summary>\n\n${claimDetails}\n\n</details>\n\n<details>\n<summary><strong>Change boundary · ${snapshot.repository.changedFiles.length} files</strong></summary>\n\n${areas}\n\n${snapshot.scope.note}\n\n</details>\n\n<details>\n<summary><strong>People and agent provenance</strong></summary>\n\n${people}\n\n</details>\n\n<details>\n<summary><strong>Limits and exact audit identity</strong></summary>\n\n${limits}\n\n- Base: \`${snapshot.repository.baseSha}\`\n- Head: \`${snapshot.repository.headSha}\`\n- Worktree: \`${snapshot.repository.worktreeDigest}\`\n- Factfile: \`${snapshot.digest}\`\n\n</details>\n\n---\n<sub>Generated by free, provider-neutral Keyoku. The attached HTML Factfile contains the evidence gallery, code tour, architecture, and reproduction details.</sub>\n`;
}

const FACTFILE_CSS = `
:root{
  --bg:#fafafa;--bg-raised:#ffffff;--surface:#f2f2f3;--surface-strong:#ececee;
  --ink:#18181b;--ink-muted:#52525b;--ink-soft:#84848c;
  --line:rgba(24,24,27,.12);--line-strong:rgba(24,24,27,.24);
  --good:#1a7f37;--good-bg:rgba(26,127,55,.09);--good-line:rgba(26,127,55,.28);
  --bad:#b42318;--bad-bg:rgba(180,35,24,.08);--bad-line:rgba(180,35,24,.28);
  --wait:#8a6d1a;--wait-bg:rgba(138,109,26,.09);
  --focus:#18181b;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Helvetica,Arial,sans-serif;
  --radius:10px;--radius-lg:14px;
}
@media(prefers-color-scheme:dark){
  :root{
    --bg:#0a0a0b;--bg-raised:#141416;--surface:#19191c;--surface-strong:#1f1f23;
    --ink:#f4f4f5;--ink-muted:#a1a1aa;--ink-soft:#77777f;
    --line:rgba(255,255,255,.11);--line-strong:rgba(255,255,255,.2);
    --good:#4ade80;--good-bg:rgba(74,222,128,.1);--good-line:rgba(74,222,128,.28);
    --bad:#f87171;--bad-bg:rgba(248,113,113,.1);--bad-line:rgba(248,113,113,.28);
    --wait:#f2c94c;--wait-bg:rgba(242,201,76,.1);
  }
}
[data-theme="dark"]{--bg:#0a0a0b;--bg-raised:#141416;--surface:#19191c;--surface-strong:#1f1f23;--ink:#f4f4f5;--ink-muted:#a1a1aa;--ink-soft:#77777f;--line:rgba(255,255,255,.11);--line-strong:rgba(255,255,255,.2);--good:#4ade80;--good-bg:rgba(74,222,128,.1);--good-line:rgba(74,222,128,.28);--bad:#f87171;--bad-bg:rgba(248,113,113,.1);--bad-line:rgba(248,113,113,.28);--wait:#f2c94c;--wait-bg:rgba(242,201,76,.1)}
[data-theme="light"]{--bg:#fafafa;--bg-raised:#fff;--surface:#f2f2f3;--surface-strong:#ececee;--ink:#18181b;--ink-muted:#52525b;--ink-soft:#84848c;--line:rgba(24,24,27,.12);--line-strong:rgba(24,24,27,.24);--good:#1a7f37;--good-bg:rgba(26,127,55,.09);--good-line:rgba(26,127,55,.28);--bad:#b42318;--bad-bg:rgba(180,35,24,.08);--bad-line:rgba(180,35,24,.28);--wait:#8a6d1a;--wait-bg:rgba(138,109,26,.09)}

*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;line-height:1.5}
a{color:inherit}
code,pre,kbd{font-family:var(--mono)}
button{font-family:inherit}
h1,h2,h3{font-weight:650;letter-spacing:-.01em}

/* Header ------------------------------------------------------------- */
.ff-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:color-mix(in srgb, var(--bg) 88%, transparent);backdrop-filter:blur(10px);z-index:10}
.ff-brand{display:flex;align-items:center;gap:8px;color:var(--ink)}
.ff-mark{display:grid;place-items:center;width:20px;height:20px;flex:none}
.ff-mark svg{display:block;width:18px;height:18px}
.ff-word{font-family:var(--mono);font-size:14px;font-weight:600;letter-spacing:-.02em}
.ff-meta{display:flex;align-items:center;gap:10px;min-width:0;color:var(--ink-soft);font-size:12px}
.ff-project{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:32vw}
.ff-source{font-family:var(--mono);white-space:nowrap;border:1px solid var(--line);border-radius:999px;padding:4px 9px;color:var(--ink-muted)}
.theme-toggle{appearance:none;border:1px solid var(--line);border-radius:8px;background:var(--bg-raised);color:var(--ink-muted);width:30px;height:30px;display:grid;place-items:center;cursor:pointer;font-size:13px}
.theme-toggle:hover{color:var(--ink);border-color:var(--line-strong)}
.live-banner{display:flex;align-items:center;gap:8px;margin:0 0 18px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink-muted);font-size:12px}
.live-banner i{width:6px;height:6px;border-radius:50%;background:var(--ink-soft);flex:none}
.live-banner.live i{background:var(--good);box-shadow:0 0 0 3px var(--good-bg)}

/* Layout --------------------------------------------------------------- */
.ff-main{max-width:860px;margin:0 auto;padding:28px 20px 64px}
.ff-eyebrow{display:block;color:var(--ink-soft);font:11px var(--mono);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.ff-title{font-size:clamp(22px,3.4vw,30px);line-height:1.16;letter-spacing:-.02em;margin:0 0 10px}
.ff-objective{color:var(--ink-muted);font-size:14px;line-height:1.6;margin:0 0 24px;max-width:70ch}

/* Hero: shared ----------------------------------------------------------- */
.hero{border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--bg-raised);overflow:hidden;margin-bottom:28px}

/* Hero: filmstrip -------------------------------------------------------- */
.film-stage{position:relative;background:#000;aspect-ratio:16/10;max-height:480px}
.film-frame{position:absolute;inset:0;display:none;align-items:center;justify-content:center;cursor:zoom-in}
.film-frame.active{display:flex}
.film-frame img,.film-frame video{display:block;width:100%;height:100%;object-fit:contain;background:#000}
.film-expand{position:absolute;right:10px;top:10px;z-index:2;appearance:none;border:1px solid rgba(255,255,255,.28);background:rgba(0,0,0,.5);color:#fff;border-radius:7px;width:30px;height:30px;cursor:pointer;font-size:14px}
.film-expand:hover{background:rgba(0,0,0,.7)}
.film-caption{display:flex;flex-direction:column;gap:2px;padding:12px 16px;border-top:1px solid var(--line)}
.film-caption strong{font-size:13px}
.film-caption span{color:var(--ink-muted);font-size:12px;line-height:1.5}
.film-dots{display:flex;gap:6px;flex-wrap:wrap;padding:0 16px 14px}
.film-dot{appearance:none;border:1px solid var(--line-strong);background:transparent;width:7px;height:7px;border-radius:50%;padding:0;cursor:pointer}
.film-dot.active{background:var(--ink);border-color:var(--ink)}
.lightbox{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center;padding:32px}
.lightbox[hidden]{display:none}
.lightbox-stage{max-width:100%;max-height:100%}
.lightbox-stage img,.lightbox-stage video{max-width:100%;max-height:88vh;display:block;margin:0 auto}
.lightbox-close{position:absolute;top:18px;right:22px;appearance:none;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.08);color:#fff;width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:15px}

/* Hero: CLI replay --------------------------------------------------------- */
.cli-window{background:#0b0b0c;color:#e4e4e7}
.cli-titlebar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.12)}
.cli-dot{width:9px;height:9px;border-radius:50%;background:rgba(255,255,255,.22)}
.cli-path{margin-left:8px;font:11px var(--mono);color:rgba(255,255,255,.5)}
.cli-body{padding:16px 18px 20px;font:12.5px/1.9 var(--mono);max-height:420px;overflow:auto}
.cli-line{opacity:0;transform:translateY(3px);animation:cli-reveal .35s ease forwards;animation-delay:calc(var(--i) * .28s);display:flex;flex-wrap:wrap;gap:0 8px;align-items:baseline;color:rgba(255,255,255,.9)}
.cli-prompt{color:rgba(255,255,255,.4)}
.cli-cmd{word-break:break-word}
.cli-result{margin-left:auto;padding-left:14px;white-space:nowrap;font-size:11.5px}
.cli-result.pass{color:var(--good)}
.cli-result.fail{color:var(--bad)}
@keyframes cli-reveal{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}

/* Summary ------------------------------------------------------------------ */
.summary{border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--bg-raised);padding:18px 20px;margin-bottom:22px}
.summary-verdict{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid var(--line)}
.summary-verdict .dot{width:8px;height:8px;border-radius:50%;background:var(--wait);flex:none;align-self:center}
.summary-verdict.tone-good .dot{background:var(--good)}
.summary-verdict.tone-bad .dot{background:var(--bad)}
.summary-verdict strong{font-size:14px}
.verdict-detail{color:var(--ink-muted);font-size:12.5px}
.summary-counts{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:12px;font-size:12.5px;color:var(--ink-muted)}
.summary-counts b{font-family:var(--mono);color:var(--ink)}
.summary-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.summary-list li{display:flex;gap:9px;align-items:flex-start;font-size:13px;color:var(--ink-muted);line-height:1.5}
.summary-list .mark{flex:none;width:15px;font-family:var(--mono);font-weight:700}
.summary-list li.pass .mark{color:var(--good)}
.summary-list li.fail .mark{color:var(--bad)}
.summary-list li.pass{color:var(--ink)}

/* Insight -------------------------------------------------------------------- */
.insight{margin-bottom:26px}
.insight>h2{font-size:16px;margin:0 0 12px}
.insight-group{margin-bottom:16px}
.insight-group>h3{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-soft);margin:0 0 8px;font-weight:650}
.insight-item{border:1px solid var(--line);border-radius:var(--radius);background:var(--bg-raised);margin-bottom:8px;overflow:hidden}
.insight-item>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;padding:12px 14px}
.insight-item>summary::-webkit-details-marker{display:none}
.insight-item .mark{flex:none;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:10px;font-weight:800;background:var(--wait-bg);color:var(--wait)}
.insight-item .mark.pass{background:var(--good-bg);color:var(--good)}
.insight-item .mark.fail{background:var(--bad-bg);color:var(--bad)}
.insight-title{flex:1;min-width:0;font-size:13.5px;font-weight:560}
.insight-state{color:var(--ink-soft);font:10px var(--mono);text-transform:uppercase;letter-spacing:.04em}
.insight-chevron{color:var(--ink-soft);transition:transform .15s}
.insight-item[open] .insight-chevron{transform:rotate(90deg)}
.insight-body{padding:0 14px 16px 42px;color:var(--ink-muted);font-size:13px;line-height:1.6}
.insight-body p{margin:0 0 8px}
.insight-body .meta{color:var(--ink-soft);font-size:11.5px}
.decision-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:6px 0 14px}
.decision-facts div{padding:10px;border-radius:8px;background:var(--surface)}
.decision-facts b{display:block;color:var(--ink-soft);font:9.5px var(--mono);text-transform:uppercase;margin-bottom:4px}
.decision-facts span{font-size:12.5px;color:var(--ink)}
.option-list{display:grid;gap:7px;margin-bottom:10px}
.option{display:grid;grid-template-columns:16px minmax(0,1fr);gap:9px;padding:10px;border:1px solid var(--line);border-radius:8px;cursor:pointer}
.option:has(input:checked){border-color:var(--line-strong);background:var(--surface)}
.option input{margin-top:3px}
.option strong{font-size:12.5px}
.option span{display:block;color:var(--ink-muted);font-size:12px;margin-top:2px}
.outcome-effect{margin:10px 0;padding:9px 11px;border-radius:8px;background:var(--surface);font-size:12px;line-height:1.55;color:var(--ink-muted)}
.outcome-effect b{display:block;color:var(--ink-soft);font:9.5px var(--mono);text-transform:uppercase;margin-bottom:4px}
.direction-deep p,.direction-deep li{color:var(--ink-muted);font-size:12px;line-height:1.55}
.direction-deep ul{padding-left:16px;margin:6px 0 0}
.action-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.action{appearance:none;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--ink);padding:8px 12px;font:600 12px var(--sans);cursor:pointer}
.action.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.action:hover{filter:brightness(1.05)}
.action-result{min-height:14px;margin:8px 0 0;color:var(--ink-soft);font-size:11.5px}
.instruction-box{display:grid;gap:8px;margin-top:6px}
.instruction-box textarea{min-height:70px;resize:vertical;border:1px solid var(--line);border-radius:8px;background:var(--bg-raised);color:var(--ink);padding:10px;font:12.5px/1.5 var(--sans)}
.custom-direction{margin-top:8px;border:1px solid var(--line);border-radius:8px}
.custom-direction>summary{padding:10px 12px;cursor:pointer;font-size:12px;color:var(--ink-muted);list-style:none}
.custom-direction>summary::-webkit-details-marker{display:none}
.custom-body{padding:0 12px 12px}
.empty-state,.clear-state{padding:14px 16px;border:1px dashed var(--line-strong);border-radius:8px;color:var(--ink-muted);font-size:12.5px;line-height:1.55}
.clear-state{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--good-line);background:var(--good-bg)}
.clear-state i{color:var(--good);font-style:normal;font-weight:800}
.clear-state strong{display:block;color:var(--ink);font-size:13px}

/* Folds (everything else) ----------------------------------------------------- */
.fold{border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--bg-raised);margin-bottom:10px;overflow:hidden}
.fold>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;padding:15px 18px}
.fold>summary::-webkit-details-marker{display:none}
.fold[open]>summary{border-bottom:1px solid var(--line)}
.fold-title{flex:1;font-size:13.5px;font-weight:600}
.fold-meta{color:var(--ink-soft);font:10.5px var(--mono)}
.chevron{color:var(--ink-soft);transition:transform .15s}
.fold[open] .chevron{transform:rotate(90deg)}
.fold-body{padding:18px}

.subhead{font:10px var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--ink-soft);margin:16px 0 8px}
.subhead:first-child{margin-top:0}

.evidence-list{display:grid;gap:8px}
.evidence-row{border:1px solid var(--line);border-radius:8px}
.evidence-row>summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:22px minmax(0,1fr) auto 16px;gap:10px;align-items:center;padding:12px 14px}
.evidence-row>summary::-webkit-details-marker{display:none}
.evidence-mark{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:var(--good-bg);color:var(--good);font-size:10px;font-weight:900}
.evidence-row.fail .evidence-mark{background:var(--bad-bg);color:var(--bad)}
.evidence-copy strong{display:block;font-size:13px}
.evidence-copy span{display:block;color:var(--ink-muted);font-size:12px;margin-top:2px}
.evidence-meta{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.meta-pill{border:1px solid var(--line);border-radius:999px;padding:3px 8px;color:var(--ink-muted);font:10px var(--mono)}
.evidence-body{padding:0 14px 16px 46px}
.story-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:12px 0;border-top:1px solid var(--line)}
.story-block b{display:block;font-size:11.5px;margin-bottom:5px}
.story-block p{font-size:12.5px;line-height:1.55;color:var(--ink-muted);margin:0}
.artifact-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.artifact{border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--surface)}
.artifact.warning{background:var(--wait-bg)}
.artifact b{display:block;font-size:11.5px}
.artifact span{display:block;color:var(--ink-muted);font-size:11.5px;line-height:1.4;margin-top:3px}
.artifact code{display:block;font-size:10px;color:var(--ink-soft);margin-top:6px;word-break:break-all}
.artifact-role{display:block!important;margin:0 0 6px!important;color:var(--ink-soft)!important;font:9px var(--mono)!important;text-transform:uppercase}
.screenshot{margin:8px 0 0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#000}
.screenshot img,.screenshot video{display:block;width:100%;max-height:520px;object-fit:contain}
.screenshot figcaption{padding:9px 11px;color:var(--ink-muted);font-size:11px;line-height:1.45;border-top:1px solid var(--line);background:var(--bg-raised)}
.media-frame{position:relative}
.annotation-pin{position:absolute;left:var(--x);top:var(--y);transform:translate(-50%,-50%);width:22px;height:22px;border:2px solid #fff;border-radius:50%;background:var(--ink);color:var(--bg);display:grid;place-items:center;font:750 10px var(--mono)}
.annotation-list{display:grid;gap:4px;margin-top:8px}
.annotation-note{color:var(--ink-muted);font-size:11px;line-height:1.45}
.annotation-note b{color:var(--ink)}
.video-time{font:10px var(--mono);color:var(--ink-soft);margin-right:5px}
.code-list{border:1px solid var(--line);border-radius:8px;overflow:hidden}
.code-row{display:grid;grid-template-columns:minmax(160px,.7fr) minmax(0,1.3fr);gap:12px;padding:9px 11px;border-top:1px solid var(--line)}
.code-row:first-child{border-top:0}
.code-row code{font-size:10.5px;color:var(--ink-soft);word-break:break-word}
.code-row span{font-size:11.5px;color:var(--ink-muted)}
.reproduce{margin-top:8px;padding:11px;border-radius:8px;background:var(--surface)}
.reproduce b{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-soft);margin-bottom:5px}
.reproduce code{font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.raw{margin-top:8px}
.raw>summary{cursor:pointer;font-size:11.5px;color:var(--ink-muted);padding:6px 0;list-style:none}
.raw-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
pre{white-space:pre-wrap;word-break:break-word;margin:0;border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:10px;color:var(--ink-muted);font:10.5px/1.55 var(--mono);max-height:220px;overflow:auto}
.raw p{color:var(--ink-soft);font:9.5px var(--mono)}

.work-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.work-card{border:1px solid var(--line);border-radius:8px;padding:12px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}
.work-card strong{font-size:12.5px}
.work-card p{grid-column:1/-1;margin:0;color:var(--ink-muted);font-size:11.5px;line-height:1.5}
.work-status{font:9.5px var(--mono);text-transform:uppercase;color:var(--ink-soft)}
.agent-line{display:flex;align-items:center;gap:7px;color:var(--ink-muted);font-size:11px;margin-top:10px}
.agent-line i{width:6px;height:6px;border-radius:50%;background:var(--ink-soft)}
.agent-line.connected i{background:var(--good)}
.local-time{white-space:nowrap;font-variant-numeric:tabular-nums}

.queue{display:grid}
.queue-row{display:grid;grid-template-columns:22px minmax(0,1fr) 90px;gap:10px;align-items:start;padding:10px 0;border-top:1px solid var(--line)}
.queue-row:first-child{border-top:0}
.queue-mark{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;background:var(--surface);color:var(--ink-muted);font-size:11px;font-weight:800}
.queue-row.human .queue-mark{background:var(--wait-bg);color:var(--wait)}
.queue-row.pass .queue-mark{background:var(--good-bg);color:var(--good)}
.queue-row.fail .queue-mark{background:var(--bad-bg);color:var(--bad)}
.queue-copy strong{display:block;font-size:12.5px;line-height:1.4}
.queue-copy p{color:var(--ink-muted);font-size:11.5px;line-height:1.5;margin:3px 0 0}
.queue-copy code{display:block;color:var(--ink-soft);font-size:10.5px;line-height:1.5;margin-top:6px;word-break:break-word}
.queue-state{text-align:right;font:9.5px var(--mono);text-transform:uppercase;letter-spacing:.04em;color:var(--ink-soft);padding-top:3px}
.queue-row.human .queue-state{color:var(--wait)}
.queue-row.pass .queue-state{color:var(--good)}
.queue-row.fail .queue-state{color:var(--bad)}

.history-list{display:grid;gap:6px}
.history-row{display:grid;grid-template-columns:12px minmax(0,1fr) auto;gap:8px;align-items:center;padding:9px 10px;border:1px solid var(--line);border-radius:8px;text-decoration:none;color:inherit}
.history-row.current{border-color:var(--line-strong);background:var(--surface)}
.history-node{color:var(--ink-soft);font-size:9px}
.history-row.current .history-node{color:var(--ink)}
.history-copy strong{display:block;font-size:11.5px}
.history-copy span{display:block;margin-top:2px;color:var(--ink-soft);font:10px var(--mono)}
.history-row code{color:var(--ink-soft);font:9.5px var(--mono)}
.history-empty{color:var(--ink-soft);font-size:12px;line-height:1.55}

.identity{border:1px solid var(--line);border-radius:8px;overflow:hidden}
.identity-row{display:grid;grid-template-columns:110px minmax(0,1fr);padding:8px 10px;border-top:1px solid var(--line);gap:10px}
.identity-row:first-child{border-top:0}
.identity-row span{font-size:11px;color:var(--ink-soft)}
.identity-row code{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink-muted)}
.plain-list{list-style:none;padding:0;margin:0}
.plain-list li{font-size:11.5px;line-height:1.5;color:var(--ink-muted);padding:7px 0;border-top:1px solid var(--line)}
.plain-list li:first-child{border-top:0}
.file-list li{font-family:var(--mono);font-size:10px;word-break:break-word}
.area-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:12px}
.area{padding:10px;border-left:1px solid var(--line);border-top:1px solid var(--line);margin:-1px 0 0 -1px}
.area b{display:block;font-size:11.5px}
.area span{font-size:10.5px;color:var(--ink-muted)}
.architecture-frame{border:1px solid var(--line);border-radius:8px;overflow:auto;background:var(--surface)}
.architecture-frame svg{display:block;width:100%;min-width:700px;height:auto}
.audit-columns{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.audit-columns h3{font-size:12.5px;margin:18px 0 7px}
.audit-columns h3:first-child{margin-top:0}
.people{display:grid;gap:7px}
.person{display:grid;grid-template-columns:26px minmax(0,1fr);gap:9px;align-items:center}
.person i{width:26px;height:26px;border-radius:7px;background:var(--surface);border:1px solid var(--line);color:var(--ink-muted);display:grid;place-items:center;font-style:normal;font-size:10px;font-weight:800}
.person b{display:block;font-size:11.5px}
.person span{display:block;font-size:11px;color:var(--ink-muted)}

.ff-footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;padding:18px 4px;color:var(--ink-soft);font-size:11px}
.ff-footer code{font-size:10px;word-break:break-all;text-align:right}

@media(prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  .cli-line{animation:none!important;opacity:1!important;transform:none!important}
}
@media(max-width:720px){
  .ff-header{padding:12px 14px}
  .ff-project{display:none}
  .ff-main{padding:20px 14px 48px}
  .story-grid,.artifact-list,.raw-grid,.audit-columns,.work-grid,.decision-facts{grid-template-columns:1fr}
  .code-row{grid-template-columns:1fr}
  .queue-row{grid-template-columns:22px minmax(0,1fr)}
  .queue-state{grid-column:2;text-align:left}
  .evidence-row>summary{grid-template-columns:22px minmax(0,1fr) 16px}
  .evidence-meta{grid-column:2;justify-content:flex-start}
  .evidence-body{padding-left:14px}
  .area-grid{grid-template-columns:1fr 1fr}
}
`;

interface DirectionSuggestion {
  id: string;
  eyebrow: string;
  label: string;
  summary: string;
  outcomeEffect: string;
  deepDive: string;
  basis: string;
  evidenceRefs: string[];
  tradeoffs: string[];
  instruction: string;
  recommended?: boolean;
  source: "agent" | "deterministic";
}

function buildDirectionSuggestions(snapshot: GateSnapshot): DirectionSuggestion[] {
  const suggestions: DirectionSuggestion[] = [];
  const firstAttention = snapshot.reviewPlan.find((item) => item.basis === "deterministic");
  if (firstAttention) suggestions.push({
    id: "resolve-review-attention",
    eyebrow: "Reduce review risk",
    label: firstAttention.title,
    summary: firstAttention.why,
    outcomeEffect: "The next Factfile can remove or narrow this attention signal and reduce the amount a reviewer must reconstruct.",
    deepDive: firstAttention.paths.length
      ? `Start with ${firstAttention.paths.join(", ")}. Explain whether each change is necessary for this outcome, then update implementation or scope evidence.`
      : "Re-evaluate whether this contribution is one coherent outcome. Split unrelated work or explain why the breadth is necessary.",
    basis: `Keyoku raised a ${firstAttention.priority} deterministic attention signal from the exact changed-source snapshot.`,
    evidenceRefs: firstAttention.paths,
    tradeoffs: ["May add an implementation iteration", "Does not replace the declared outcome checks"],
    instruction: `${firstAttention.title}. ${firstAttention.why}${firstAttention.paths.length ? ` Start with: ${firstAttention.paths.join(", ")}.` : ""} Re-run the Keyoku gate and report exactly what changed.`,
    recommended: firstAttention.priority === "critical" || firstAttention.priority === "high",
    source: "deterministic",
  });
  if (snapshot.humanReview.pending > 0) suggestions.push({
    id: "prepare-acceptance",
    eyebrow: "Make review decisive",
    label: "Prepare the human acceptance pass",
    summary: `${snapshot.humanReview.pending} outcome-specific acceptance ${snapshot.humanReview.pending === 1 ? "question remains" : "questions remain"}. Assemble the shortest useful walkthrough for them.`,
    outcomeEffect: "The evidence state will not be falsely upgraded, but the accountable reviewer gets a concrete path to make each remaining judgment.",
    deepDive: snapshot.outcome.humanCriteria.map((criterion) => `${criterion.description}${criterion.guidance ? ` — ${criterion.guidance}` : ""}`).join(" "),
    basis: "The current Factfile has supported automated observations but outcome-specific human acceptance criteria remain pending.",
    evidenceRefs: snapshot.outcome.humanCriteria.map((criterion) => `human:${criterion.id}`),
    tradeoffs: ["Requires real human judgment", "May reveal another implementation iteration"],
    instruction: `Prepare an acceptance walkthrough for these human criteria: ${snapshot.outcome.humanCriteria.map((criterion) => criterion.description).join("; ")}. Point to the most relevant evidence for each criterion, call out what is still unknown, and do not mark any human verdict yourself.`,
    source: "deterministic",
  });
  if (snapshot.architecture?.components.length) suggestions.push({
    id: "trace-system-impact",
    eyebrow: "Understand the system",
    label: "Deep-dive the architecture impact",
    summary: `Trace this contribution across ${snapshot.architecture.components.length} detected components and explain the changed data or control flow.`,
    outcomeEffect: "The next Factfile will make ownership and downstream effects easier to understand; code changes occur only if the analysis exposes a real gap.",
    deepDive: "Follow the changed areas through the architecture projection, verify component responsibilities against source, and annotate any boundary that the generated map cannot infer safely.",
    basis: `The generated architecture projection contains ${snapshot.architecture.components.length} components and the contribution changes ${snapshot.repository.changedFiles.length} files.`,
    evidenceRefs: snapshot.repository.changedFiles.slice(0, 6),
    tradeoffs: ["Mostly improves understanding rather than test coverage", "Generated architecture still needs source verification"],
    instruction: "Trace the contribution through the current architecture projection. Verify every affected component and relationship against source, update the architecture evidence where it is incomplete, and report any newly discovered risk without inventing dependencies.",
    source: "deterministic",
  });
  return suggestions.slice(0, 3);
}

function renderLocalTime(value: string, relative = true): string {
  const date = new Date(value);
  const fallback = Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(date);
  return `<time class="local-time" datetime="${esc(value)}" data-relative="${relative ? "true" : "false"}">${esc(fallback)}</time>`;
}

export function renderFactfileHtml(snapshot: GateSnapshot, options: { live?: boolean; sessionToken?: string; history?: FactfileHistoryItem[]; historical?: boolean } = {}): string {
  const session = snapshot.session ?? { work: [], decisions: [], instructions: [], agents: [], directions: [], eventCount: 0 };
  const latestHuman = new Map(snapshot.reviews.filter((review) => review.criterionId && review.verdict).map((review) => [review.criterionId!, review]));
  const state = snapshot.state === "accepted"
    ? { tone: "good", label: "Accepted exact snapshot", result: "Accepted", detail: "A named human accepted this exact source identity." }
    : snapshot.state === "ready_for_review"
      ? { tone: "good", label: "Ready for acceptance", result: "Acceptance remains explicit", detail: "Every declared criterion passes; an accountable person still owns final acceptance." }
      : snapshot.state === "human_review_required"
        ? { tone: "wait", label: "Human review remains", result: "Evidence supported", detail: `${snapshot.humanReview.pending} required acceptance ${snapshot.humanReview.pending === 1 ? "judgment remains" : "judgments remain"}. No agent work is necessarily blocked.` }
        : snapshot.state === "review_blocked"
          ? { tone: "bad", label: "Human review blocked", result: "Blocked", detail: "A named reviewer determined that a required condition is not met." }
          : { tone: "bad", label: "Evidence gap", result: "Not ready to accept", detail: `${snapshot.summary.failed} declared ${snapshot.summary.failed === 1 ? "claim is" : "claims are"} unsupported at this snapshot.` };
  const summary = snapshot.contribution.summary ?? snapshot.contribution.title;
  const allArtifacts = snapshot.evidence.flatMap((item) => item.presentation?.artifacts ?? []);
  const artifactCount = allArtifacts.filter((artifact) => artifact.digest && !artifact.unavailable).length;
  const deterministicAttention = snapshot.reviewPlan.filter((item) => item.basis === "deterministic");
  const attentionRows = deterministicAttention.length
    ? deterministicAttention.map((item) => `<div class="queue-row"><span class="queue-mark">→</span><div class="queue-copy"><strong>${esc(item.title)}</strong><p>${esc(item.why)}</p>${item.paths.length ? `<code>${item.paths.map(esc).join(" · ")}</code>` : ""}</div><span class="queue-state">${esc(item.priority)}</span></div>`).join("")
    : `<div class="queue-row pass"><span class="queue-mark">✓</span><div class="queue-copy"><strong>No deterministic attention signal was raised</strong><p>Review still requires judgment; this only means the declared scope and repository heuristics found no additional hotspot.</p></div><span class="queue-state">baseline</span></div>`;
  const workRows = session.work.length
    ? session.work.map((item) => `<article class="work-card"><strong>${esc(item.title)}</strong><span class="work-status">${esc(item.status)}</span><p>${esc(item.detail ?? "No additional detail reported.")}</p><span class="agent-line ${session.agents.find((agent) => agent.actorId === item.actorId)?.connected ? "connected" : ""}"><i></i>${esc(item.actorId)} · ${renderLocalTime(item.updatedAt)}</span></article>`).join("")
    : `<div class="empty-state">No agent has reported work yet. Connected agents use <code>contribution_report_work</code>; this is execution status, not proof.</div>`;
  const pendingDecisions = session.decisions.filter((decision) => decision.status === "pending");
  const resolvedDecisions = session.decisions.filter((decision) => decision.status === "resolved");
  const resolvedDecisionRows = resolvedDecisions.map((decision) => { const option = decision.options.find((candidate) => candidate.id === decision.selectedOptionId); return `<div class="queue-row pass"><span class="queue-mark">✓</span><div class="queue-copy"><strong>${esc(decision.title)}</strong><p>${esc(option?.label ?? decision.resolutionNote ?? "Resolved with a custom instruction")}${decision.resolvedBy ? ` · ${esc(decision.resolvedBy)}` : ""}${decision.resolvedAt ? ` · ${renderLocalTime(decision.resolvedAt)}` : ""}</p></div><span class="queue-state">resolved</span></div>`; }).join("");
  const instructionRows = session.instructions.map((instruction) => `<li><strong>${esc(instruction.status)} instruction</strong><br>${esc(instruction.text)}<br><code>${esc(instruction.id)}</code> · ${renderLocalTime(instruction.createdAt)}${instruction.acknowledgedBy ? ` · acknowledged by ${esc(instruction.acknowledgedBy)}` : ""}</li>`).join("") || "<li>No human instruction has been queued in this session.</li>";
  const connectedAgents = session.agents.filter((agent) => agent.connected);
  const agentSummary = session.agents.length ? session.agents.map((agent) => `<span class="agent-line ${agent.connected ? "connected" : ""}"><i></i>${esc(agent.name)} · ${agent.connected ? "connected" : `last seen ${renderLocalTime(agent.lastSeenAt)}`}</span>`).join("") : `<span class="agent-line"><i></i>No agent heartbeat yet · instructions will queue durably</span>`;
  const proposedDirections = session.directions ?? [];
  const directionSuggestions: DirectionSuggestion[] = proposedDirections.length
    ? proposedDirections.map((direction, index) => ({ ...direction, source: "agent" as const, recommended: index === 0 }))
    : buildDirectionSuggestions(snapshot);
  const history = options.history ?? [];
  const historyHref = (id: string): string => {
    if (options.sessionToken) return `/snapshots/${encodeURIComponent(id)}.html?token=${encodeURIComponent(options.sessionToken)}`;
    return options.historical ? `${encodeURIComponent(id)}.html` : `snapshots/${encodeURIComponent(id)}.html`;
  };
  const historyRows = history.slice(0, 6).map((item, index) => `<a class="history-row ${item.id === snapshot.id ? "current" : ""}" href="${historyHref(item.id)}"><span class="history-node">${index === 0 ? "●" : "○"}</span><span class="history-copy"><strong>${item.id === snapshot.id ? "Current snapshot" : item.state.replaceAll("_", " ")}</strong><span>${renderLocalTime(item.generatedAt)} · ${item.passed}/${item.total} checks · ${item.humanPassed}/${item.humanTotal} human</span></span><code>${esc(item.worktreeDigest.slice(0, 8))}</code></a>`).join("") || `<div class="history-empty">The first snapshot will appear here after the gate runs.</div>`;

  // Evidence, claim by claim (kept as the collapsed deep-dive) ------------------------------
  const claims = snapshot.evidence.map((item) => {
    const presentation = item.presentation;
    const boundArtifacts = presentation?.artifacts.filter((artifact) => artifact.digest && !artifact.unavailable).length ?? 0;
    const codeCount = presentation?.code.length ?? 0;
    const media = presentation?.artifacts.filter((artifact) => (artifact.kind === "screenshot" || artifact.kind === "video") && artifact.dataUrl).map((artifact) => { const annotations = artifact.annotations ?? []; const pins = artifact.kind === "screenshot" ? annotations.filter((annotation) => annotation.x !== undefined && annotation.y !== undefined).map((annotation, index) => `<span class="annotation-pin" style="--x:${annotation.x}%;--y:${annotation.y}%" title="${esc(annotation.label)}">${index + 1}</span>`).join("") : ""; const notes = annotations.length ? `<div class="annotation-list">${annotations.map((annotation, index) => `<div class="annotation-note">${artifact.kind === "video" && annotation.atMs !== undefined ? `<span class="video-time">${Math.floor(annotation.atMs / 60000)}:${String(Math.floor((annotation.atMs % 60000) / 1000)).padStart(2, "0")}</span>` : `<b>${index + 1}.</b> `}<b>${esc(annotation.label)}</b>${annotation.detail ? ` — ${esc(annotation.detail)}` : ""}</div>`).join("")}</div>` : ""; return `<figure class="screenshot"><div class="media-frame">${artifact.kind === "video" ? `<video controls preload="metadata" src="${artifact.dataUrl}" aria-label="${esc(artifact.label)}"></video>` : `<img src="${artifact.dataUrl}" alt="${esc(artifact.label)}">`}${pins}</div><figcaption><strong>${esc(artifact.label)}</strong> · ${esc(artifact.caption)}${artifact.digest ? ` · SHA-256 ${esc(artifact.digest.slice(0, 16))}…` : ""}<br>This ${artifact.kind === "video" ? "recording" : "image"} demonstrates observed behavior; it does not independently establish usability or correctness.${notes}</figcaption></figure>`; }).join("") ?? "";
    const artifacts = presentation?.artifacts.filter((artifact) => !((artifact.kind === "screenshot" || artifact.kind === "video") && artifact.dataUrl)).map((artifact) => `<div class="artifact ${artifact.unavailable ? "warning" : ""}"><span class="artifact-role">${artifact.kind === "screenshot" || artifact.kind === "video" ? "Demonstration" : "Supporting artifact"}</span><b>${artifact.unavailable ? "Unavailable · " : ""}${esc(artifact.label)}</b><span>${esc(artifact.caption)}${artifact.unavailable ? ` ${esc(artifact.unavailable)}` : ""}</span><code>${esc(artifact.path)}${artifact.digest ? ` · sha256:${esc(artifact.digest)}` : ""}</code></div>`).join("") ?? "";
    const code = presentation?.code.map((ref) => `<div class="code-row"><code>${esc(ref.path)}</code><span>${esc(ref.purpose)}</span></div>`).join("") ?? "";
    const resultLabel = item.pass ? "Supported" : "Gap";
    return `<details class="evidence-row ${item.pass ? "pass" : "fail"}" ${!item.pass ? "open" : ""}><summary><span class="evidence-mark">${item.pass ? "✓" : "!"}</span><span class="evidence-copy"><strong>${esc(item.description)}</strong><span>${esc(presentation?.summary ?? (item.pass ? "The observation matched its declared rule." : "The observation did not match its declared rule."))}</span></span><span class="evidence-meta"><span class="meta-pill">${esc(item.verification.kind)}</span>${boundArtifacts ? `<span class="meta-pill">${boundArtifacts} ${boundArtifacts === 1 ? "artifact" : "artifacts"}</span>` : ""}${codeCount ? `<span class="meta-pill">${codeCount} code ${codeCount === 1 ? "path" : "paths"}</span>` : ""}<span class="meta-pill">${item.durationMs}ms</span><span class="meta-pill">${resultLabel}</span></span><span class="chevron">›</span></summary><div class="evidence-body"><div class="story-grid"><div class="story-block"><b>What this establishes</b><p>${esc(presentation?.summary ?? "Only that the observation matched its declared rule at this exact snapshot.")}</p></div><div class="story-block"><b>Why it matters</b><p>${esc(presentation?.whyItMatters ?? "No outcome-specific relevance was supplied. Treat this explanation as incomplete.")}</p></div></div>${media}${artifacts ? `<div class="subhead">Inspectable artifacts</div><div class="artifact-list">${artifacts}</div>` : ""}${code ? `<div class="subhead">Relevant implementation</div><div class="code-list">${code}</div>` : ""}<div class="reproduce"><b>Reproduce this observation</b><code>${esc(item.verification.reproduce)}</code></div><details class="raw"><summary>Open verifier internals · observation, rule, runtime</summary><div class="raw-grid"><pre>Observed\n${esc(printable(item.actual))}</pre><pre>Rule\n${esc(printable(item.verification.assertion))}</pre></div><p>${esc(item.verification.label)} · ${item.durationMs}ms${item.error ? ` · ${esc(item.error)}` : ""}</p></details></div></details>`;
  }).join("");
  const areaNames = new Map<string, number>();
  for (const file of snapshot.repository.changedFiles) {
    const area = file.startsWith("archive/") ? "Archived legacy code"
      : file.startsWith("src/") ? "Product code"
        : file.startsWith("tests/") ? "Tests"
          : file.startsWith("docs/") || file === "README.md" ? "Documentation"
            : file.startsWith(".github/") ? "GitHub workflow"
              : file.startsWith(".keyoku/") ? "Proof contracts"
                : "Project configuration";
    areaNames.set(area, (areaNames.get(area) ?? 0) + 1);
  }
  const areas = [...areaNames].map(([name, count]) => `<div class="area"><b>${esc(name)}</b><span>${count} changed ${count === 1 ? "file" : "files"}</span></div>`).join("") || `<div class="area"><b>No changed files</b><span>The worktree matches Git head.</span></div>`;
  const architecture = snapshot.architecture ? `<div class="architecture-frame">${renderArchitectureSvg(snapshot.architecture)}</div>` : `<p>No architecture projection was captured. This is explicitly unknown, not silently treated as unchanged.</p>`;
  const people = snapshot.contribution.actors.map((actor) => `<div class="person"><i>${actor.kind === "human" ? "H" : actor.kind === "agent" ? "A" : "O"}</i><div><b>${esc(actor.name)}</b><span>${esc(actor.role ?? actor.kind)}${actor.harness ? ` · ${esc(actor.harness)}` : ""}${actor.model ? ` · ${esc(actor.model)}` : ""}</span></div></div>`).join("");
  const files = snapshot.repository.changedFiles.map((file) => `<li>${esc(file)}</li>`).join("") || "<li>Clean Git worktree</li>";
  const constraints = snapshot.outcome.constraints.map((constraint) => `<li>${esc(constraint)}</li>`).join("") || "<li>No explicit constraints were declared.</li>";
  const limits = (snapshot.contribution.knownLimits?.length ? snapshot.contribution.knownLimits : ["Only the claims shown here were evaluated.", "Passing checks do not establish product fit, maintainability, or universal security.", "Any source change requires a new Factfile."]).map((limit) => `<li>${esc(limit)}</li>`).join("");
  const reviews = snapshot.reviews.length ? snapshot.reviews.map((review) => `<li><strong>${esc(review.decision === "accepted" ? "Accepted" : review.criterionId ? `${review.verdict} · ${review.criterionId}` : "Review note")}</strong><br>${esc(review.reviewer.name)} · ${renderLocalTime(review.reviewedAt)}<br>${esc(review.comment)}</li>`).join("") : `<li>No human review has been recorded for this snapshot.</li>`;

  // Hero: visual-proof-first — a filmstrip of bound screenshots/video, or a CLI replay of every probe ----
  const heroFrames = snapshot.evidence.flatMap((item) => (item.presentation?.artifacts ?? []).filter((artifact) => (artifact.kind === "screenshot" || artifact.kind === "video") && artifact.dataUrl && !artifact.unavailable));
  const heroHtml = heroFrames.length
    ? `<div class="hero hero-film" data-hero="film">
        <div class="film-stage">${heroFrames.map((frame, index) => `<div class="film-frame${index === 0 ? " active" : ""}" data-frame="${index}" data-label="${esc(frame.label)}" data-caption="${esc(frame.caption)}">${frame.kind === "video" ? `<video ${index === 0 ? "preload=\"metadata\"" : "preload=\"none\""} controls playsinline src="${frame.dataUrl}" aria-label="${esc(frame.label)}"></video>` : `<img src="${frame.dataUrl}" alt="${esc(frame.label)}" loading="${index === 0 ? "eager" : "lazy"}">`}</div>`).join("")}<button type="button" class="film-expand" data-action="film-expand" aria-label="View full size">⤢</button></div>
        <div class="film-caption"><strong id="film-label">${esc(heroFrames[0].label)}</strong><span id="film-cap">${esc(heroFrames[0].caption)}</span></div>
        ${heroFrames.length > 1 ? `<div class="film-dots">${heroFrames.map((frame, index) => `<button type="button" class="film-dot${index === 0 ? " active" : ""}" data-goto="${index}" aria-label="${esc(frame.label)}"></button>`).join("")}</div>` : ""}
      </div>
      <div class="lightbox" id="lightbox" hidden aria-hidden="true"><button type="button" class="lightbox-close" data-action="lightbox-close" aria-label="Close full-size view">✕</button><div class="lightbox-stage" id="lightbox-stage"></div></div>`
    : `<div class="hero hero-cli" data-hero="cli"><div class="cli-window"><div class="cli-titlebar"><span class="cli-dot"></span><span class="cli-dot"></span><span class="cli-dot"></span><span class="cli-path">${esc(snapshot.repository.headSha.slice(0, 8))}+${esc(snapshot.repository.worktreeDigest.slice(0, 8))}</span></div><div class="cli-body">${snapshot.evidence.map((item, index) => `<div class="cli-line" style="--i:${index}"><span class="cli-prompt">$</span><span class="cli-cmd">${esc(item.verification.reproduce)}</span><span class="cli-result ${item.pass ? "pass" : "fail"}">${item.pass ? "✓" : "✗"} ${item.durationMs}ms</span></div>`).join("")}</div></div></div>`;

  // Short written summary ------------------------------------------------------------------------
  const summaryBlockHtml = `<section class="summary" aria-label="Verdict summary">
    <div class="summary-verdict tone-${state.tone}"><span class="dot"></span><strong>${esc(state.label)}</strong><span class="verdict-detail">${esc(state.detail)}</span></div>
    <div class="summary-counts"><span><b>${snapshot.summary.passed}/${snapshot.summary.total}</b> automated checks</span><span><b>${snapshot.humanReview.passed}/${snapshot.humanReview.total}</b> human decisions</span></div>
    <ul class="summary-list">${snapshot.evidence.map((item) => `<li class="${item.pass ? "pass" : "fail"}"><span class="mark">${item.pass ? "✓" : "✗"}</span>${esc(item.description)}</li>`).join("")}</ul>
  </section>`;

  // Human decision — keep judgment distinct from optional agent coordination ----------------------
  const humanInsightItems = snapshot.outcome.humanCriteria.length
    ? snapshot.outcome.humanCriteria.map((criterion) => {
        const review = latestHuman.get(criterion.id);
        const verdict = review?.verdict ?? "pending";
        return `<details class="insight-item"><summary><span class="mark ${verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : ""}">${verdict === "pass" ? "✓" : verdict === "fail" ? "✗" : "?"}</span><span class="insight-title">${esc(criterion.description)}</span><span class="insight-state">${esc(verdict)}</span><span class="insight-chevron">›</span></summary><div class="insight-body"><p>${esc(review?.comment ?? criterion.guidance ?? "A named human must decide this against the evidence below.")}</p>${review ? `<p class="meta">${esc(review.reviewer.name)} · ${renderLocalTime(review.reviewedAt)}</p>` : ""}</div></details>`;
      }).join("")
    : `<div class="empty-state">No outcome-specific judgment questions were declared. A passing command does not silently accept a contribution.</div>`;
  const blockedInsightItems = pendingDecisions.length
    ? pendingDecisions.map((decision) => `<details class="insight-item" open><summary><span class="mark fail">!</span><span class="insight-title">${esc(decision.title)}</span><span class="insight-state">blocked</span><span class="insight-chevron">›</span></summary><div class="insight-body" data-decision="${esc(decision.id)}"><div class="decision-facts"><div><b>What the agent wants</b><span>${esc(decision.agentIntent)}</span></div><div><b>What blocks it</b><span>${esc(decision.blocker)}</span></div><div><b>Why you</b><span>${esc(decision.whyHuman)}</span></div><div><b>If you do nothing</b><span>${esc(decision.noResponse)}</span></div></div><div class="option-list">${decision.options.map((option) => `<article class="option"><label style="display:grid;grid-template-columns:16px minmax(0,1fr);gap:9px;cursor:pointer"><input type="radio" name="${esc(decision.id)}" value="${esc(option.id)}" data-instruction="${esc(option.instruction)}" ${option.id === decision.recommendedOptionId ? "checked" : ""}><span><strong>${esc(option.label)}${option.id === decision.recommendedOptionId ? " · Recommended" : ""}</strong><span>${esc(option.description)}</span></span></label>${option.outcomeEffect ? `<div class="outcome-effect"><b>How the outcome changes</b>${esc(option.outcomeEffect)}</div>` : ""}${option.deepDive || option.tradeoffs?.length ? `<details class="direction-deep"><summary>Context and tradeoffs</summary>${option.deepDive ? `<p>${esc(option.deepDive)}</p>` : ""}${option.tradeoffs?.length ? `<ul>${option.tradeoffs.map((tradeoff) => `<li>${esc(tradeoff)}</li>`).join("")}</ul>` : ""}</details>` : ""}</article>`).join("")}</div><div class="action-row"><button class="action primary" data-action="decide">Choose and send</button><button class="action" data-action="copy-decision">Copy instruction</button></div><p class="action-result" aria-live="polite"></p></div></details>`).join("")
    : `<div class="clear-state"><i>✓</i><div><strong>No agent work is waiting on you</strong><p>Keyoku will put only a material, blocked decision here. Optional steering has its own section below.</p></div></div>`;
  const directionInsightItems = directionSuggestions.length
    ? directionSuggestions.map((suggestion, index) => `<details class="insight-item"${index === 0 ? " open" : ""}><summary><span class="mark">→</span><span class="insight-title">${esc(suggestion.label)}</span><span class="insight-state">${esc(suggestion.eyebrow)}</span><span class="insight-chevron">›</span></summary><div class="insight-body"><p>${esc(suggestion.summary)}</p><div class="outcome-effect"><b>How the outcome changes</b>${esc(suggestion.outcomeEffect)}</div><details class="direction-deep"><summary>Deep-dive context</summary><p>${esc(suggestion.deepDive)}</p><p><strong>Why this is suggested:</strong> ${esc(suggestion.basis)}</p>${suggestion.evidenceRefs.length ? `<p><strong>Evidence basis:</strong> ${suggestion.evidenceRefs.map((reference) => `<code>${esc(reference)}</code>`).join(" · ")}</p>` : ""}${suggestion.tradeoffs.length ? `<ul>${suggestion.tradeoffs.map((tradeoff) => `<li>${esc(tradeoff)}</li>`).join("")}</ul>` : ""}</details><label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:12.5px;color:var(--ink-muted)"><input type="radio" name="next-direction" value="${esc(suggestion.id)}" data-instruction="${esc(suggestion.instruction)}"${index === 0 ? " checked" : ""}> Select this direction</label></div></details>`).join("")
    : `<div class="empty-state">No contextual direction has been prepared yet.</div>`;
  const directionActionsHtml = directionSuggestions.length
    ? `<div class="action-row"><button class="action primary" data-action="${options.live ? "send-direction" : "copy-direction"}">${options.live ? (connectedAgents.length ? "Send selected direction" : "Queue selected direction") : "Copy selected direction"}</button><button class="action" data-action="copy-direction">Copy</button></div><p class="action-result" id="direction-result" aria-live="polite"></p><details class="custom-direction"><summary>Write a custom direction <span>— when prepared paths miss your intent</span></summary><div class="custom-body"><p>State what should change, the constraint to preserve, and which evidence should look different afterward.</p><div class="instruction-box"><textarea id="custom-instruction" placeholder="Keep the current API, simplify the reviewer flow, and prove mobile behavior with an annotated screenshot."></textarea><button class="action primary" data-action="${options.live ? "send-custom" : "copy-custom"}">${options.live ? (connectedAgents.length ? "Send direction" : "Queue direction") : "Copy direction"}</button></div><p class="action-result" id="custom-result" aria-live="polite"></p></div></details>`
    : "";
  const humanDecisionHtml = `<section class="insight" aria-label="Human decision">
    <h2>Human decision</h2>
    <div class="insight-group"><h3>Required judgment</h3>${blockedInsightItems}${humanInsightItems}</div>
  </section>`;

  // Evidence is the product: keep a small claim set visible, with coordination subordinate. ------
  const evidenceFold = `<details class="fold" id="evidence"${snapshot.evidence.length <= 3 ? " open" : ""}><summary><span class="fold-title">Evidence &amp; reproduction</span><span class="fold-meta">${snapshot.summary.passed}/${snapshot.summary.total} supported · ${artifactCount} artifacts</span><span class="chevron">›</span></summary><div class="fold-body"><p style="margin:0 0 14px;color:var(--ink-muted);font-size:12.5px;line-height:1.6">Claim → observation → meaning → limits → reproduction → code.</p><div class="evidence-list">${claims}</div><div class="subhead">Review attention (deterministic signal, not a verdict)</div><div class="queue">${attentionRows}</div></div></details>`;
  const coordinationFold = directionSuggestions.length
    ? `<details class="fold" id="coordination"><summary><span class="fold-title">Optional agent coordination</span><span class="fold-meta">${directionSuggestions.length} proposed direction${directionSuggestions.length === 1 ? "" : "s"}</span><span class="chevron">›</span></summary><div class="fold-body"><p style="margin:0 0 14px;color:var(--ink-muted);font-size:12.5px;line-height:1.6">Suggestions are coordination aids, not evidence or verdicts.</p>${directionInsightItems}${directionActionsHtml}</div></details>`
    : "";

  // Everything else — reachable, collapsed by default ------------------------------------------
  const workFold = `<details class="fold" id="work"><summary><span class="fold-title">Work log</span><span class="fold-meta">${session.work.length} items · ${connectedAgents.length} connected</span><span class="chevron">›</span></summary><div class="fold-body"><div class="work-grid">${workRows}</div>${agentSummary}</div></details>`;
  const sessionFold = `<details class="fold" id="session"><summary><span class="fold-title">Session &amp; proof history</span><span class="fold-meta">${history.length} snapshot${history.length === 1 ? "" : "s"} · ${session.eventCount} events</span><span class="chevron">›</span></summary><div class="fold-body">${resolvedDecisionRows ? `<div class="subhead">Resolved this session</div><div class="queue">${resolvedDecisionRows}</div>` : ""}<div class="subhead">Session instructions</div><ul class="plain-list">${instructionRows}</ul><div class="subhead">Proof history</div><div class="history-list">${historyRows}</div></div></details>`;
  const repositoryFold = `<details class="fold" id="repository"><summary><span class="fold-title">Repository, scope &amp; provenance</span><span class="fold-meta">${snapshot.repository.changedFiles.length} changed files</span><span class="chevron">›</span></summary><div class="fold-body"><div class="area-grid">${areas}</div>${architecture}<div class="audit-columns"><div><h3>Exact source identity</h3><div class="identity"><div class="identity-row"><span>Base</span><code title="${esc(snapshot.repository.baseSha)}">${esc(snapshot.repository.baseSha)}</code></div><div class="identity-row"><span>Head</span><code title="${esc(snapshot.repository.headSha)}">${esc(snapshot.repository.headSha)}</code></div><div class="identity-row"><span>Worktree digest</span><code title="${esc(snapshot.repository.worktreeDigest)}">${esc(snapshot.repository.worktreeDigest)}</code></div><div class="identity-row"><span>Generated</span><span>${renderLocalTime(snapshot.generatedAt, false)}</span></div></div><h3>Responsibility</h3><div class="people">${people}</div><h3>Human review history</h3><ul class="plain-list">${reviews}</ul></div><div><h3>Changed files (${snapshot.repository.changedFiles.length})</h3><ul class="plain-list file-list">${files}</ul><h3>Outcome constraints</h3><ul class="plain-list">${constraints}</ul><h3>Known limits</h3><ul class="plain-list">${limits}</ul></div></div></div></details>`;

  const logoMark = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3"/><path d="M16 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>`;

  const liveScript = `<script>(()=>{
    const live=${options.live ? "true" : "false"};
    const token=${JSON.stringify(options.sessionToken ?? "")};
    const headers={"content-type":"application/json","x-keyoku-session":token};
    let suppressRefreshUntil=0;
    const media=matchMedia("(prefers-color-scheme: dark)");
    const reduceMotion=matchMedia("(prefers-reduced-motion: reduce)").matches;
    const storedTheme=()=>{try{return localStorage.getItem("keyoku-theme")}catch{return null}};
    const effectiveTheme=()=>document.documentElement.dataset.theme||(media.matches?"dark":"light");
    const paintThemeIcon=()=>{const icon=document.querySelector(".theme-icon");if(icon)icon.textContent=effectiveTheme()==="dark"?"☀":"☾"};
    const setTheme=(theme)=>{document.documentElement.dataset.theme=theme;try{localStorage.setItem("keyoku-theme",theme)}catch{}paintThemeIcon()};
    const hydrateTimes=()=>{const now=Date.now();const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;const full=new Intl.DateTimeFormat(undefined,{year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit",second:"2-digit",timeZoneName:"short"});const clock=new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit",timeZoneName:"short"});const relative=new Intl.RelativeTimeFormat(undefined,{numeric:"auto"});document.querySelectorAll("time.local-time").forEach((node)=>{const at=Date.parse(node.dateTime);if(Number.isNaN(at))return;const exact=full.format(at);node.title=exact+" · "+zone;if(node.dataset.relative!=="true"){node.textContent=exact;return}const seconds=(at-now)/1000;const abs=Math.abs(seconds);let value;let unit;if(abs<60){value=Math.round(seconds);unit="second"}else if(abs<3600){value=Math.round(seconds/60);unit="minute"}else if(abs<86400){value=Math.round(seconds/3600);unit="hour"}else if(abs<604800){value=Math.round(seconds/86400);unit="day"}else{node.textContent=exact;return}node.textContent=relative.format(value,unit)+" · "+clock.format(at)})};
    const copy=async(text)=>{if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(text);const area=document.createElement("textarea");area.value=text;document.body.append(area);area.select();document.execCommand("copy");area.remove()};
    const post=async(path,data)=>{if(!live)throw new Error("This is a saved snapshot. Copy the instruction into your agent or open a live session.");suppressRefreshUntil=Date.now()+2200;const response=await fetch(path,{method:"POST",headers,body:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw new Error(value.error||"Request failed");return value};

    const film=document.querySelector('[data-hero="film"]');
    if(film){
      const frames=[...film.querySelectorAll(".film-frame")];
      const dots=[...film.querySelectorAll(".film-dot")];
      const labelEl=document.getElementById("film-label");
      const capEl=document.getElementById("film-cap");
      const meta=frames.map((frame)=>({label:frame.dataset.label||"",caption:frame.dataset.caption||""}));
      const lightbox=document.getElementById("lightbox");
      const stage=document.getElementById("lightbox-stage");
      let index=0;let paused=false;
      const show=(next)=>{frames[index].classList.remove("active");dots[index]?.classList.remove("active");index=(next+frames.length)%frames.length;frames[index].classList.add("active");dots[index]?.classList.add("active");if(labelEl)labelEl.textContent=meta[index].label;if(capEl)capEl.textContent=meta[index].caption};
      const tick=()=>{if(paused)return;if(lightbox&&!lightbox.hidden)return;const current=frames[index].querySelector("video");if(current&&!current.paused&&!current.ended)return;show(index+1)};
      if(!reduceMotion&&frames.length>1)setInterval(tick,2500);
      film.addEventListener("mouseenter",()=>{paused=true});
      film.addEventListener("mouseleave",()=>{paused=false});
      dots.forEach((dot,i)=>dot.addEventListener("click",()=>show(i)));
      const openLightbox=()=>{if(!lightbox||!stage)return;const active=frames[index].querySelector("img,video");if(!active)return;stage.innerHTML="";const clone=active.cloneNode(true);if(clone.tagName==="VIDEO")clone.setAttribute("controls","");stage.append(clone);lightbox.hidden=false;lightbox.setAttribute("aria-hidden","false");paused=true};
      const closeLightbox=()=>{if(!lightbox)return;lightbox.hidden=true;lightbox.setAttribute("aria-hidden","true");if(stage)stage.innerHTML="";paused=false};
      frames.forEach((frame)=>{const img=frame.querySelector("img");if(img)img.addEventListener("click",openLightbox)});
      film.querySelector('[data-action="film-expand"]')?.addEventListener("click",openLightbox);
      lightbox?.querySelector('[data-action="lightbox-close"]')?.addEventListener("click",closeLightbox);
      lightbox?.addEventListener("click",(event)=>{if(event.target===lightbox)closeLightbox()});
      document.addEventListener("keydown",(event)=>{if(event.key==="Escape")closeLightbox()});
    }

    document.addEventListener("click",async(event)=>{
      const button=event.target.closest("[data-action]");if(!button)return;
      const action=button.dataset.action;
      if(action==="theme"){setTheme(effectiveTheme()==="dark"?"light":"dark");return}
      if(action==="film-expand"||action==="lightbox-close")return;
      const decisionWrap=button.closest("[data-decision]");
      const result=decisionWrap?decisionWrap.querySelector(".action-result"):document.querySelector(action.includes("custom")?"#custom-result":"#direction-result");
      try{
        if(action==="decide"){const selected=decisionWrap.querySelector("input:checked");if(!selected)throw new Error("Choose an option first.");await post("/api/decisions/"+decisionWrap.dataset.decision,{selectedOptionId:selected.value,resolvedBy:"local-human"});if(result)result.textContent="Decision recorded and queued for the agent.";setTimeout(()=>location.reload(),1000)}
        if(action==="copy-decision"){const selected=decisionWrap.querySelector("input:checked");if(!selected)throw new Error("Choose an option first.");await copy(selected.dataset.instruction);if(result)result.textContent="Exact instruction copied."}
        if(action==="send-direction"||action==="copy-direction"){const selected=document.querySelector('input[name="next-direction"]:checked');if(!selected)throw new Error("Choose a direction first.");if(action==="send-direction"&&live){await post("/api/instructions",{text:selected.dataset.instruction,createdBy:"local-human"});if(result)result.textContent=${JSON.stringify(connectedAgents.length ? "Direction sent. A connected agent can receive it now." : "Direction queued. The next connected agent will receive it.")};setTimeout(()=>location.reload(),1800)}else{await copy(selected.dataset.instruction);if(result)result.textContent="Direction copied for any coding agent."}}
        if(action==="send-custom"||action==="copy-custom"){const area=document.querySelector("#custom-instruction");const text=area.value.trim();if(!text)throw new Error("Write a direction first.");if(action==="send-custom"&&live){await post("/api/instructions",{text,createdBy:"local-human"});area.value="";if(result)result.textContent=${JSON.stringify(connectedAgents.length ? "Custom direction sent." : "Custom direction queued for the next agent.")};setTimeout(()=>location.reload(),1800)}else{await copy(text);if(result)result.textContent="Custom direction copied."}}
      }catch(error){if(result)result.textContent=error.message}
    });

    const stored=storedTheme();
    if(stored==="light"||stored==="dark")document.documentElement.dataset.theme=stored;
    paintThemeIcon();
    media.addEventListener?.("change",()=>{if(!document.documentElement.dataset.theme)paintThemeIcon()});
    hydrateTimes();setInterval(hydrateTimes,60000);
    if(live){const stream=new EventSource("/api/events?token="+encodeURIComponent(token));stream.addEventListener("update",()=>{if(Date.now()>suppressRefreshUntil&&!document.activeElement?.matches("textarea,input"))location.reload()})}
  })();</script>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; media-src data:; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(snapshot.outcome.title)} · Keyoku</title><style>${FACTFILE_CSS}</style></head><body>
  <header class="ff-header"><div class="ff-brand"><span class="ff-mark" aria-hidden="true">${logoMark}</span><span class="ff-word">keyoku</span></div><div class="ff-meta"><span class="ff-project">${esc(snapshot.project.name)} · outcome r${snapshot.outcome.revision}</span><span class="ff-source" title="Exact source revision this Factfile is bound to">${esc(snapshot.repository.headSha.slice(0, 8))}+${esc(snapshot.repository.worktreeDigest.slice(0, 8))}</span><button type="button" class="theme-toggle" data-action="theme" aria-label="Toggle light and dark appearance"><span class="theme-icon">◐</span></button></div></header>
  <main class="ff-main">
    ${options.live || options.historical ? `<div class="live-banner ${options.live ? "live" : ""}"><i></i><span>${options.live ? `Live proof session · ${connectedAgents.length} agent${connectedAgents.length === 1 ? "" : "s"} connected` : "Historical snapshot"}</span></div>` : ""}
    <span class="ff-eyebrow">${esc(summary)}</span>
    <h1 class="ff-title">${esc(snapshot.outcome.title)}</h1>
    <p class="ff-objective">${esc(snapshot.outcome.objective)}</p>
    ${heroHtml}
    ${summaryBlockHtml}
    ${evidenceFold}
    ${humanDecisionHtml}
    ${coordinationFold}
    ${workFold}
    ${sessionFold}
    ${repositoryFold}
    <footer class="ff-footer"><span>Free, provider-neutral Keyoku · evidence and judgment remain separate</span><code>${esc(snapshot.id)} · sha256:${esc(snapshot.digest)}</code></footer>
  </main>${liveScript}</body></html>`;
}
