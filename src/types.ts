import { z } from "zod";

// ---------------------------------------------------------------------------
// Probes — how the harness observes external state. A probe is read-only by
// convention: it should inspect the world, never mutate it.
// ---------------------------------------------------------------------------

export const ParseModeSchema = z
  .enum(["auto", "json", "text", "number"])
  .describe(
    "How probe output is parsed into the `output` field: 'auto' tries JSON and falls back to text (default); 'json' requires JSON; 'text' keeps the raw string; 'number' parses a number.",
  );

export const CommandProbeSchema = z.object({
  kind: z.literal("command"),
  run: z
    .string()
    .min(1)
    .describe("Shell command to execute. Its stdout becomes the probe output."),
  cwd: z.string().optional().describe("Working directory for the command."),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  parse: ParseModeSchema.optional(),
});

export const HttpProbeSchema = z.object({
  kind: z.literal("http"),
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  parse: ParseModeSchema.optional(),
});

export const McpProbeSchema = z.object({
  kind: z.literal("mcp"),
  connector: z
    .string()
    .describe("Name of a registered connector (see connector_add)."),
  tool: z.string().describe("Tool to call on the connector's MCP server."),
  args: z.record(z.unknown()).optional(),
  parse: ParseModeSchema.optional(),
});

export const ProbeSchema = z.discriminatedUnion("kind", [
  CommandProbeSchema,
  HttpProbeSchema,
  McpProbeSchema,
]);

export type Probe = z.infer<typeof ProbeSchema>;
export type ParseMode = z.infer<typeof ParseModeSchema>;

/**
 * What a probe run produces. Assertions evaluate JMESPath expressions against
 * this envelope; a path of `output` (the default) targets the parsed output.
 */
export interface ProbeEnvelope {
  /** Parsed probe output (per the probe's `parse` mode). */
  output: unknown;
  /** Command probes: process exit code (0 = success). */
  exitCode?: number;
  /** Command probes: captured stderr (truncated). */
  stderr?: string;
  /** HTTP probes: response status code. */
  status?: number;
  /** Transport-level failure (timeout, parse error, connection refused...). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Assertions — machine-checkable success criteria over probe envelopes.
// ---------------------------------------------------------------------------

export const AssertOpSchema = z.enum([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "matches",
  "exists",
  "not_exists",
  "truthy",
  "falsy",
  "len_eq",
  "len_gte",
  "len_lte",
  "all_eq",
  "all_gte",
  "all_lte",
  "any_eq",
  "any_gte",
  "any_lte",
]);

export const AssertionSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      "JMESPath into the probe envelope {output, exitCode?, stderr?, status?, error?}. Defaults to 'output'. Example: 'output[*].minInstances'.",
    ),
  op: AssertOpSchema,
  value: z
    .unknown()
    .optional()
    .describe("Expected value (unused for exists/truthy-style ops)."),
});

export type AssertOp = z.infer<typeof AssertOpSchema>;
export type Assertion = z.infer<typeof AssertionSchema>;

export interface AssertionResult {
  pass: boolean;
  /** The value the path resolved to. */
  actual: unknown;
  /** Why evaluation failed mechanically (bad path, non-numeric compare...). */
  error?: string;
  /** A caveat on a passing result, e.g. all_* matched an empty array. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Goals — the convergence target.
// ---------------------------------------------------------------------------

export const AutonomySchema = z
  .enum(["observe", "suggest", "approve", "autonomous"])
  .describe(
    "Trust level: observe = report only, never act; suggest = propose actions for the user to run; approve = act only after explicit user approval per action; autonomous = act without asking (within constraints).",
  );

export type Autonomy = z.infer<typeof AutonomySchema>;

export const CriterionInputSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe("Human-readable meaning of this criterion."),
  probe: ProbeSchema,
  assert: AssertionSchema,
});

export type CriterionInput = z.infer<typeof CriterionInputSchema>;

export interface Criterion extends CriterionInput {
  id: string;
}

export type GoalStatus = "active" | "converged" | "blocked" | "abandoned";

export interface Goal {
  id: string;
  /** Short stable handle, usable anywhere a goal id is accepted. */
  slug: string;
  objective: string;
  criteria: Criterion[];
  constraints: string[];
  autonomy: Autonomy;
  maxIterations: number;
  usedIterations: number;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  convergedAt: string | null;
  lastAssessedAt: string | null;
}

export interface CriterionEvaluation {
  id: string;
  description: string;
  pass: boolean;
  actual: unknown;
  expected: { op: AssertOp; value?: unknown; path: string };
  /** Transport/evaluation problem, when the probe itself failed. */
  error?: string;
  /** A caveat on a passing result, e.g. all_* matched an empty array. */
  note?: string;
  durationMs: number;
}

export interface ConvergenceReport {
  goal: {
    id: string;
    slug: string;
    objective: string;
    status: GoalStatus;
    autonomy: Autonomy;
    constraints: string[];
    iterationsUsed: number;
    iterationsRemaining: number;
  };
  converged: boolean;
  /** True when a previously converged goal regressed on this assessment. */
  driftDetected: boolean;
  criteria: CriterionEvaluation[];
  unmetCount: number;
  /** Learned workflows whose objectives resemble this goal's. */
  suggestedWorkflows: WorkflowSuggestion[];
  /** Mined patterns (M2 learning loop) relevant to this goal. */
  relevantPatterns: {
    name: string;
    description: string;
    steps: string[];
    stability: number;
  }[];
  /** Protocol instructions for the driving agent. */
  guidance: string;
}

// ---------------------------------------------------------------------------
// Action records — the episodic trace of what was done toward a goal.
// ---------------------------------------------------------------------------

export const ActionResultSchema = z.enum(["success", "failure", "partial"]);
export type ActionResult = z.infer<typeof ActionResultSchema>;

export interface ActionRecord {
  id: string;
  goalId: string;
  iteration: number;
  summary: string;
  detail?: string;
  tool?: string;
  result: ActionResult;
  at: string;
}

// ---------------------------------------------------------------------------
// Workflow artifacts — the learning slice. When a goal converges, its action
// trace is promoted into a reusable workflow keyed by the goal's slug.
// ---------------------------------------------------------------------------

export interface WorkflowStep {
  summary: string;
  tool?: string;
  result: ActionResult;
  /** Provenance: "recorded" = an explicit goal_record corrective action;
   *  "activity" = inferred from the activity log because the goal converged
   *  build-then-verify with nothing recorded. Absent means recorded
   *  (back-compat with workflows persisted before this field existed). */
  source?: "recorded" | "activity";
}

export interface WorkflowArtifact {
  id: string;
  slug: string;
  objective: string;
  steps: WorkflowStep[];
  /** Descriptions of the criteria this workflow satisfied. */
  criteria: string[];
  /** Approaches that FAILED on the way to convergence — negative muscle memory,
   *  so a similar goal doesn't repeat the dead ends. Optional for back-compat with
   *  workflows persisted before this field existed. */
  pitfalls?: string[];
  stats: {
    /** Times a goal with this slug converged. Acts as the stability score. */
    convergences: number;
    totalActions: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowSuggestion {
  slug: string;
  objective: string;
  similarity: number;
  convergences: number;
  steps: WorkflowStep[];
  pitfalls?: string[];
}

// ---------------------------------------------------------------------------
// Connectors — the context layer. M1: MCP-native (stdio/http). M3 adds
// 'openapi': connectors synthesized on the fly from an OpenAPI/Swagger spec.
// ---------------------------------------------------------------------------

export const SynthAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("bearer"), token: z.string().min(1) }),
  z.object({
    kind: z.literal("header"),
    name: z.string().min(1),
    value: z.string().min(1),
  }),
  z.object({
    kind: z.literal("query"),
    name: z.string().min(1),
    value: z.string().min(1),
  }),
]);

export type SynthAuth = z.infer<typeof SynthAuthSchema>;

export const ConnectorTransportSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().url(),
    headers: z
      .record(z.string())
      .optional()
      .describe("Extra headers, e.g. {\"Authorization\": \"Bearer ...\"}."),
  }),
  z.object({
    type: z.literal("openapi"),
    specUrl: z
      .string()
      .min(1)
      .describe("URL (or local file path) of an OpenAPI 3.x / Swagger 2 spec, JSON or YAML."),
    baseUrl: z
      .string()
      .url()
      .optional()
      .describe("Override the spec's server URL."),
    auth: SynthAuthSchema.optional(),
    allowMutating: z
      .boolean()
      .optional()
      .describe("Expose non-GET operations as tools (default false: read-only)."),
  }),
]);

export type ConnectorTransport = z.infer<typeof ConnectorTransportSchema>;

export interface Connector {
  name: string;
  description?: string;
  transport: ConnectorTransport;
  /**
   * Trust ladder for connector_call: observe = probes only, refuse calls;
   * suggest = refuse calls but describe what would run; approve = enqueue an
   * ApprovalRequest instead of executing; autonomous = execute directly.
   * Defaults: mcp-native = autonomous (M1 behavior), openapi = approve.
   */
  autonomy?: Autonomy;
  addedAt: string;
}

// ---------------------------------------------------------------------------
// M2 — Observations: episodic memory of goal state over time (perception).
// ---------------------------------------------------------------------------

export type ObservationKind = "assessment" | "convergence" | "drift" | "blocked";

export interface Observation {
  id: string;
  goalId: string;
  goalSlug: string;
  kind: ObservationKind;
  /** Compact state summary, e.g. "2/3 criteria unmet: c1, c3". */
  summary: string;
  unmet: string[];
  at: string;
}

// ---------------------------------------------------------------------------
// M2 — Patterns: workflows mined from traces + observations by the learning
// loop. Stability grows on re-observation and decays with disuse (the v1
// memory semantics, applied to behavior).
// ---------------------------------------------------------------------------

export interface Pattern {
  id: string;
  name: string;
  description: string;
  steps: string[];
  evidence: {
    goalSlugs: string[];
    occurrences: number;
  };
  /** Miner's confidence 0-1. */
  confidence: number;
  /** Grows each time the pattern is re-observed; decays over time at read. */
  stability: number;
  source: "heuristic" | "slm";
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

/** Half-life decay applied at read time; patterns unseen for months fade. */
export function effectiveStability(pattern: Pattern, now: Date): number {
  const days = Math.max(0, (now.getTime() - new Date(pattern.lastSeenAt).getTime()) / 86_400_000);
  return pattern.stability * Math.exp(-days / 45);
}

// ---------------------------------------------------------------------------
// M4 — Approvals: queued actions awaiting a human decision.
// ---------------------------------------------------------------------------

export type ApprovalStatus = "pending" | "denied" | "executed" | "failed";

export interface ApprovalRequest {
  id: string;
  connector: string;
  tool: string;
  args: Record<string, unknown>;
  /** Why this was queued, e.g. "connector 'gh' autonomy is 'approve'". */
  reason: string;
  requestedAt: string;
  status: ApprovalStatus;
  decidedAt?: string;
  /** Result text (executed) or denial reason / error. */
  result?: string;
}

// ---------------------------------------------------------------------------
// M4 — Audit: append-only trail of every harness operation.
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  at: string;
  actor: "agent" | "cli";
  /** Operation, e.g. tool name or CLI command. */
  op: string;
  /** Primary target: goal slug, connector name, approval id... */
  target?: string;
  summary: string;
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Activity events — the observation layer. Every tool call, shell command,
// or file change becomes an event that the pattern miner can learn from.
// ---------------------------------------------------------------------------

export type ActivityEventType = "tool_use" | "shell" | "file_change" | "git" | "manual";

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  /** Human-readable one-liner: "Bash: git push origin main" */
  summary: string;
  /** Full command / diff / args (truncated to 500 chars). */
  detail?: string;
  /** Claude Code tool name: Bash, Edit, Write, Read, … */
  tool?: string;
  /** Files, endpoints, services involved — extracted by the recorder. */
  entities?: string[];
  sessionId?: string;
  /** Working directory of the session when the event fired — project signal. */
  cwd?: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Workflow templates — approved automation recipes.
// ---------------------------------------------------------------------------

export type WorkflowStepType = "bash" | "agent_prompt" | "mcp_call" | "human_review";

export interface WorkflowStepTemplate {
  type: WorkflowStepType;
  summary: string;
  /** bash steps */
  command?: string;
  cwd?: string;
  /** agent_prompt steps */
  prompt?: string;
  /** mcp_call steps */
  connector?: string;
  tool?: string;
  args?: Record<string, unknown>;
  /** human_review steps */
  message?: string;
}

export interface WorkflowTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  steps: WorkflowStepTemplate[];
  trigger: { type: "on_demand" };
  approvedAt: string;
  createdAt: string;
  updatedAt: string;
  /** Pattern slug that generated this template, if auto-suggested. */
  sourcePattern?: string;
  timesRun: number;
}

// ---------------------------------------------------------------------------
// Executions — runtime state of a workflow template being executed.
// ---------------------------------------------------------------------------

export type ExecutionStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "waiting_agent"
  | "waiting_human";

export type ExecutionStatus =
  | "running"
  | "done"
  | "failed"
  | "waiting_agent"
  | "waiting_human";

// ---------------------------------------------------------------------------
// Knowledge — the context layer (v0). Facts about connectors, operations, and
// the user's domain, layered on top of raw activity. Sources: MCP tool
// self-descriptions (free, captured at connector_add), agent research briefs
// (knowledge_submit), users. Graduates into the keyoku-engine context graph.
// ---------------------------------------------------------------------------

export interface KnowledgeEntry {
  id: string;
  /** e.g. "connector:github", "operation:github.create_issue", "domain:deploys" */
  subject: string;
  kind: "connector" | "operation" | "note";
  fact: string;
  source: "mcp-description" | "agent-research" | "user" | "pattern-mining";
  at: string;
}

export interface ExecutionStep {
  index: number;
  type: WorkflowStepType;
  summary: string;
  status: ExecutionStepStatus;
  command?: string;
  cwd?: string;
  prompt?: string;
  connector?: string;
  tool?: string;
  args?: Record<string, unknown>;
  message?: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

export interface WorkflowExecution {
  id: string;
  templateId: string;
  templateSlug: string;
  status: ExecutionStatus;
  steps: ExecutionStep[];
  currentStep: number;
  startedAt: string;
  completedAt?: string;
  triggeredBy: "on_demand" | "hook";
}
