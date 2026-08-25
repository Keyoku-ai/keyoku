import { readFileSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  audit,
  connectorAutonomy,
  decideApproval,
  enqueueApproval,
  gateCall,
} from "./approvals.js";
import { detectPatterns, draftStep, enrichWithEntities, redactSecrets, type ActivitySuggestion } from "./activity.js";
import { proposeArchitectureChange, scanArchitecture } from "./architecture.js";
import { Brain } from "./brain.js";
import {
  ActorSchema,
  findProjectRoot,
  listOutcomes,
  loadContribution,
  loadProject,
  reviewContribution,
  runGate,
  startContribution,
} from "./contribution.js";
import {
  DecisionOptionSchema,
  DirectionProposalSchema,
  acknowledgeInstruction,
  heartbeatAgent,
  nextInstruction,
  readProofSession,
  reportWork,
  proposeDirection,
  requestDecision,
} from "./proof-session.js";
import {
  appendPulseEvent,
  planPulseDispatch,
  readPulseEvents,
  renderPulseProjection,
  replayPulseEvents,
  sealPulseEvent,
  verifyAndSealLocalCheckpoint,
} from "./pulse.js";
import { loadSurfaced, saveSurfaced } from "./nudge.js";
import { redactConnector } from "./connectors.js";
import { autoRecordToFocusGoal } from "./engine.js";
import type { Harness } from "./engine.js";
import { executeBashStep, executeMcpStep } from "./executor.js";
import { buildCreateGuidance, buildRecordGuidance, PROTOCOL } from "./guidance.js";
import { relevantPatterns, runLearning } from "./learn.js";
import { refineSuggestions } from "./refine.js";
import { observationDigest, stateTransitions } from "./observe.js";
import { resolveSlmFromEnv } from "./slm.js";
import { newId, slugify } from "./store.js";
import {
  ActionResultSchema,
  AutonomySchema,
  ConnectorTransportSchema,
  CriterionEditSchema,
  CriterionInputSchema,
  effectiveStability,
  type ActivityEvent,
  type Criterion,
  type Goal,
  type WorkflowExecution,
  type WorkflowStepTemplate,
  type WorkflowTemplate,
} from "./types.js";

// Single-sourced from package.json (ships next to dist/ in the npm tarball), so the
// reported version never drifts from the release. Falls back if unreadable.
export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function json(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function goalSummary(goal: Goal) {
  return {
    id: goal.id,
    slug: goal.slug,
    objective: goal.objective,
    status: goal.status,
    autonomy: goal.autonomy,
    criteria: goal.criteria.length,
    iterations: `${goal.usedIterations}/${goal.maxIterations}`,
    lastAssessedAt: goal.lastAssessedAt,
    convergedAt: goal.convergedAt,
    // Cross-project scoping (ADR-35). Absent on goals stamped before this
    // field existed and never re-focused since — see CHANGELOG.
    ...(goal.project ? { project: goal.project } : {}),
  };
}

const GOAL_REF = z
  .string()
  .describe("Goal slug or id (slugs are listed by goal_list).");

/**
 * Criteria can carry secrets (http probe auth headers). The store keeps the
 * real values — probes need them — but views echoed back into agent context
 * mask them.
 */
function redactCriteria(criteria: Criterion[]): Criterion[] {
  return criteria.map((c) =>
    c.probe.kind === "http" && c.probe.headers
      ? {
          ...c,
          probe: {
            ...c.probe,
            headers: Object.fromEntries(
              Object.keys(c.probe.headers).map((k) => [k, "•••redacted•••"]),
            ),
          },
        }
      : c,
  );

}

/** Fill {{placeholders}}; unresolved keys are collected, not guessed. */
function fillPlaceholders(
  text: string | undefined,
  params: Record<string, string>,
  missing: Set<string>,
): string | undefined {
  if (!text) return text;
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, key: string) => {
    if (params[key] === undefined) {
      missing.add(key);
      return `{{${key}}}`;
    }
    return params[key];
  });
}

/** Subject for a practice knowledge entry — project dir name when visible. */
function practiceSubject(s: ActivitySuggestion): string {
  const first = s.draftSteps[0]?.summary ?? "";
  const m = first.match(/\/Development\/([^/]+)\//);
  return (m?.[1] ?? first.split(":")[0] ?? "general").toLowerCase();
}

export function buildServer(harness: Harness): McpServer {
  const server = new McpServer(
    { name: "keyoku", version: VERSION },
    {
      instructions: PROTOCOL,
      // Declared up front: the template store is usually empty at connect
      // time, and prompts are registered dynamically as workflows are
      // approved — without this the capability would never be advertised.
      capabilities: { prompts: { listChanged: true } },
    },
  );

  // The brain (keyoku-engine) is opt-in via KEYOKU_ENGINE_URL. When present,
  // knowledge is mirrored into it and queries upgrade to semantic search.
  const brain = Brain.fromEnv();
  function fileKnowledge(entry: Parameters<typeof harness.store.appendKnowledge>[0]): void {
    harness.store.appendKnowledge(entry);
    if (brain) void brain.remember(entry);
  }

  // M4: every consequential operation lands in the append-only audit trail.
  // audit() never throws, so this can't break the operation it records.
  const logAudit = (op: string, target: string | undefined, summary: string, ok: boolean) =>
    audit(harness.store, { actor: "agent", op, ...(target ? { target } : {}), summary, ok });

  // ----- repository outcomes and contributions -----

  // The experimental live agent-control surface was archived during the
  // proof-first pivot. V1 keeps MCP focused on repository outcomes, evidence,
  // human review, and the architecture projection used by Factfiles.

  server.registerTool(
    "architecture_scan",
    {
      title: "Scan the live project architecture",
      description:
        "Return the current architecture projection by combining the repository's declared semantic components with deterministic Git and filesystem observations. Use before substantial work and when architecture drift is suspected.",
      inputSchema: { cwd: z.string().optional().describe("A path inside the project (default: server cwd).") },
    },
    async ({ cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        return json({ root, architecture: scanArchitecture(root) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "architecture_propose",
    {
      title: "Propose an architecture graph change",
      description:
        "Propose a semantic architecture update without silently rewriting declared project truth. Deterministic file and Git state update automatically; component meaning and relationships remain attributed proposals until policy or a human accepts them.",
      inputSchema: {
        summary: z.string().min(1).max(500),
        rationale: z.string().min(1).max(2_000),
        operations: z.array(z.object({
          op: z.enum(["add", "update", "remove"]),
          target: z.string().min(1).max(500),
          value: z.unknown().optional(),
        })).min(1).max(100),
        actorId: z.string().min(1).max(200),
        actorName: z.string().min(1).max(200),
        harness: z.string().max(200).optional(),
        model: z.string().max(200).optional(),
        confidence: z.number().min(0).max(1),
        cwd: z.string().optional().describe("A path inside the project (default: server cwd)."),
      },
    },
    async ({ summary, rationale, operations, actorId, actorName, harness, model, confidence, cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        const proposal = proposeArchitectureChange({
          root,
          summary,
          rationale,
          operations,
          actor: { id: actorId, name: actorName, ...(harness ? { harness } : {}), ...(model ? { model } : {}) },
          confidence,
        });
        logAudit("architecture_propose", proposal.id, `${summary} (${confidence})`, true);
        return json({ root, proposal });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "project_inspect",
    {
      title: "Inspect the current Keyoku project",
      description:
        "Read the portable .keyoku project contract and list its versioned outcomes. Use this before starting substantial work in a repository that has adopted Keyoku.",
      inputSchema: {
        cwd: z.string().optional().describe("A path inside the project (default: server cwd)."),
      },
    },
    async ({ cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        return json({ root, project: loadProject(root), outcomes: listOutcomes(root) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "outcome_list",
    {
      title: "List project outcomes",
      description: "List the human-owned, versioned definitions of done under .keyoku/outcomes.",
      inputSchema: {
        cwd: z.string().optional().describe("A path inside the project (default: server cwd)."),
      },
    },
    async ({ cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        const outcomes = listOutcomes(root);
        return json({ root, count: outcomes.length, outcomes });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "contribution_start",
    {
      title: "Start an accountable contribution",
      description:
        "Bind new work to an exact outcome revision and Git base. Record the human or agent doing the work; agents should include their harness, model, and accountable ownerId.",
      inputSchema: {
        outcome: z.string().min(1).describe("Outcome id from outcome_list."),
        title: z.string().optional(),
        actor: ActorSchema.optional(),
        cwd: z.string().optional().describe("A path inside the project (default: server cwd)."),
      },
    },
    async ({ outcome, title, actor, cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        const contribution = startContribution({ root, outcomeId: outcome, title, actor });
        logAudit("contribution_start", contribution.id, contribution.title, true);
        return json({
          root,
          contribution,
          guidance: `Work toward outcome '${contribution.outcomeId}'. Keep work status current, then use contribution_propose_directions with evidence-grounded next moves before the final contribution_gate for contribution '${contribution.id}'. A human must review the resulting Factfile.`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "contribution_get",
    {
      title: "Get contribution status",
      description: "Read an accountable contribution's outcome revision, Git base, actors, and current gate state.",
      inputSchema: {
        contribution: z.string().min(1),
        cwd: z.string().optional().describe("A path inside the project (default: server cwd)."),
      },
    },
    async ({ contribution, cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        return json({ root, contribution: loadContribution(root, contribution), session: readProofSession(root, contribution) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "contribution_report_work",
    {
      title: "Report agent work to the live Factfile",
      description: "Upsert one task-level status item. Reported activity coordinates humans and agents; it is never treated as proof of completion.",
      inputSchema: {
        contribution: z.string().min(1),
        id: z.string().min(1),
        title: z.string().min(1),
        detail: z.string().optional(),
        status: z.enum(["queued", "working", "blocked", "done"]),
        actorId: z.string().min(1),
        actorName: z.string().min(1),
        harness: z.string().optional(),
        model: z.string().optional(),
        cwd: z.string().optional(),
      },
    },
    async ({ contribution, id, title, detail, status, actorId, actorName, harness, model, cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        const item = reportWork(root, contribution, { id, title, ...(detail ? { detail } : {}), status, actorId });
        heartbeatAgent(root, contribution, { actorId, name: actorName, ...(harness ? { harness } : {}), ...(model ? { model } : {}), status: status === "working" ? "working" : status === "blocked" ? "waiting" : "idle", currentWorkId: item.id });
        logAudit("contribution_report_work", contribution, `${item.id}: ${item.status}`, true);
        return json({ item, session: readProofSession(root, contribution), guidance: "Keep this status current. Completion still requires contribution_gate evidence." });
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    "contribution_propose_directions",
    {
      title: "Publish contextual next directions",
      description:
        "Before the final gate, synthesize 1-4 evidence-grounded next moves for the human. Use the whole outcome, changed-source scope, work history, architecture, proof results, and unresolved judgments. Provide concise rationale, evidence references, consequences, and tradeoffs; never expose hidden chain-of-thought or present speculation as fact.",
      inputSchema: {
        contribution: z.string().min(1),
        proposedBy: z.string().min(1),
        directions: z.array(DirectionProposalSchema.omit({ createdAt: true, proposedBy: true })).min(1).max(4),
        cwd: z.string().optional(),
      },
    },
    async ({ contribution, proposedBy, directions, cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        const proposed = directions.map((direction) => proposeDirection(root, contribution, { ...direction, proposedBy }));
        logAudit("contribution_propose_directions", contribution, `${proposed.length} contextual next directions`, true);
        return json({
          directions: proposed,
          session: readProofSession(root, contribution),
          guidance: "These directions will appear in the next Factfile. Run contribution_gate after all work and proposals are current; the first proposal is presented as the agent recommendation.",
        });
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    "contribution_request_decision",
    {
      title: "Ask a human for a blocking decision",
      description: "Create a structured Needs you request only when progress requires accountable product, risk, scope, or preference judgment.",
      inputSchema: {
        contribution: z.string().min(1),
        id: z.string().optional(),
        title: z.string().min(1),
        agentIntent: z.string().min(1),
        blocker: z.string().min(1),
        whyHuman: z.string().min(1),
        options: z.array(DecisionOptionSchema).min(1).max(5).describe("Each option should explain the direction, executable instruction, expected outcome effect, deeper context, and meaningful tradeoffs."),
        recommendedOptionId: z.string().optional(),
        noResponse: z.string().min(1),
        requestedBy: z.string().min(1),
        cwd: z.string().optional(),
      },
    },
    async ({ contribution, id, title, agentIntent, blocker, whyHuman, options, recommendedOptionId, noResponse, requestedBy, cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        const request = requestDecision(root, contribution, { ...(id ? { id } : {}), title, agentIntent, blocker, whyHuman, options, ...(recommendedOptionId ? { recommendedOptionId } : {}), noResponse, requestedBy });
        logAudit("contribution_request_decision", contribution, request.title, true);
        return json({ request, guidance: "Pause only the dependent work. Continue independent tasks while the human decision is pending." });
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    "contribution_next_instruction",
    {
      title: "Receive the next human instruction",
      description: "Read the oldest queued instruction addressed to this agent, including answers created from a Needs you decision.",
      inputSchema: { contribution: z.string().min(1), actorId: z.string().min(1), actorName: z.string().min(1), harness: z.string().optional(), model: z.string().optional(), cwd: z.string().optional() },
    },
    async ({ contribution, actorId, actorName, harness, model, cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        heartbeatAgent(root, contribution, { actorId, name: actorName, ...(harness ? { harness } : {}), ...(model ? { model } : {}), status: "waiting" });
        const instruction = nextInstruction(root, contribution, actorId);
        return json({ instruction: instruction ?? null, guidance: instruction ? "Acknowledge after incorporating it into your plan." : "No human instruction is queued." });
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    "contribution_ack_instruction",
    {
      title: "Acknowledge a human instruction",
      description: "Confirm that an instruction was received and incorporated into the agent's working context.",
      inputSchema: { contribution: z.string().min(1), instruction: z.string().min(1), actorId: z.string().min(1), cwd: z.string().optional() },
    },
    async ({ contribution, instruction, actorId, cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        const acknowledged = acknowledgeInstruction(root, contribution, instruction, actorId);
        logAudit("contribution_ack_instruction", contribution, acknowledged.id, true);
        return json({ instruction: acknowledged });
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    "contribution_gate",
    {
      title: "Evaluate a contribution and render its Factfile",
      description:
        "Run the outcome's declared probes, fail closed on incomplete or failed evidence, bind results to the exact Git/worktree snapshot, and render JSON, Markdown, and HTML Factfiles. This executes commands declared by the repository; inspect unfamiliar outcome files before calling it.",
      inputSchema: {
        contribution: z.string().min(1),
        cwd: z.string().optional().describe("A path inside the project (default: server cwd)."),
      },
    },
    async ({ contribution, cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        const snapshot = await runGate(root, contribution);
        logAudit("contribution_gate", contribution, `${snapshot.summary.passed}/${snapshot.summary.total} criteria passed`, snapshot.summary.verified);
        return json({
          snapshot,
          factfile: join(root, ".keyoku", "contributions", contribution, "factfile.html"),
          guidance: snapshot.state === "ready_for_review"
            ? "All automated and declared human criteria passed for this exact snapshot. It is ready for the accountable human's acceptance, not universally correct or safe."
            : snapshot.state === "human_review_required"
              ? "Automated evidence passed, but required human judgments remain pending. Present the Factfile and use contribution_review for each criterion."
              : snapshot.state === "review_blocked"
                ? "Automated evidence passed, but a human criterion failed. Iterate on the outcome and request another named review."
                : "Automated evidence gaps remain. Address the failed criteria, then run contribution_gate again.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "contribution_review",
    {
      title: "Record human review or exact-snapshot acceptance",
      description:
        "Append a review note or human acceptance to the current Factfile. The repository must still match the proven Git head and worktree digest; agents cannot act as the reviewer.",
      inputSchema: {
        contribution: z.string().min(1),
        decision: z.enum(["note", "accepted"]),
        comment: z.string().min(1),
        criterionId: z.string().optional().describe("Optional human criterion id from the outcome."),
        verdict: z.enum(["pass", "fail"]).optional().describe("Required with criterionId."),
        reviewer: ActorSchema.refine((actor) => actor.kind === "human", "reviewer must be human"),
        cwd: z.string().optional().describe("A path inside the project (default: server cwd)."),
      },
    },
    async ({ contribution, decision, comment, criterionId, verdict, reviewer, cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        const snapshot = reviewContribution({ root, contributionId: contribution, decision, comment, criterionId, verdict, reviewer });
        logAudit("contribution_review", contribution, `${decision} by ${reviewer.name}`, true);
        return json({
          snapshot,
          factfile: join(root, ".keyoku", "contributions", contribution, "factfile.html"),
          guidance: decision === "accepted"
            ? "This named human accepted the exact proven snapshot. Any subsequent source change requires a new gate and acceptance."
            : "The review note is now part of the append-only contribution history.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ----- trusted progress across Factfiles -----

  server.registerTool(
    "pulse_event_ingest",
    {
      title: "Append a harness-neutral Pulse lifecycle event",
      description:
        "Validate and append one already content-digested Pulse event. Events are idempotent by id and exact digest. Activity is coordination state, never proof; use pulse_checkpoint_publish to bind local Factfile bytes before publishing a checkpoint.",
      inputSchema: {
        event: z.record(z.unknown()),
        cwd: z.string().optional().describe("A path inside an initialized Keyoku project."),
      },
    },
    async ({ event, cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        return json(appendPulseEvent(root, event));
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    "pulse_checkpoint_publish",
    {
      title: "Verify local Factfiles and publish a Pulse checkpoint event",
      description:
        "Recompute each referenced local Factfile digest, match its exact Git head/worktree identity, seal the checkpoint, and append checkpoint_published. A digest-shaped reference alone is rejected.",
      inputSchema: {
        eventId: z.string().min(1),
        checkpoint: z.record(z.unknown()),
        cwd: z.string().optional().describe("A path inside an initialized Keyoku project."),
      },
    },
    async ({ eventId, checkpoint: input, cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        const checkpoint = verifyAndSealLocalCheckpoint(root, input as Parameters<typeof verifyAndSealLocalCheckpoint>[1]);
        const event = sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: eventId, type: "checkpoint_published", at: checkpoint.publishedAt, leaseId: checkpoint.leaseIds[0], checkpoint });
        return json(appendPulseEvent(root, event));
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    "pulse_status",
    {
      title: "Read Pulse lease and checkpoint state",
      description: "Replay the append-only Pulse ledger into deterministic harness, agent, lease, and verified-checkpoint state.",
      inputSchema: { cwd: z.string().optional().describe("A path inside an initialized Keyoku project.") },
    },
    async ({ cwd }) => {
      try {
        const root = findProjectRoot(cwd);
        return json({ root, state: replayPulseEvents(readPulseEvents(root)) });
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    "pulse_dispatch_plan",
    {
      title: "Plan a deterministic Pulse dispatch outcome",
      description:
        "Return send, defer, deduplicate, suppress, coalesce, or stale_no_send without contacting a delivery channel. Fresh working/verifying leases defer; stale or conflicting state fails closed.",
      inputSchema: {
        now: z.string().datetime().optional(),
        staleAfterMs: z.number().int().nonnegative().optional(),
        debounceMs: z.number().int().nonnegative().optional(),
        deliveredContentDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
        cwd: z.string().optional().describe("A path inside an initialized Keyoku project."),
      },
    },
    async ({ cwd, ...options }) => {
      try {
        const root = findProjectRoot(cwd);
        return json({ root, decision: planPulseDispatch({ events: readPulseEvents(root), ...options }) });
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    "pulse_projection_render",
    {
      title: "Render one audience view from a planned Pulse snapshot",
      description:
        "Render stakeholder, developer, timeline, email-safe, plain-text, or JSON output only after deterministic dispatch planning. This tool does not send the result.",
      inputSchema: {
        audience: z.enum(["stakeholder", "developer", "timeline", "email", "text", "json"]),
        now: z.string().datetime().optional(),
        staleAfterMs: z.number().int().nonnegative().optional(),
        debounceMs: z.number().int().nonnegative().optional(),
        deliveredContentDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
        cwd: z.string().optional().describe("A path inside an initialized Keyoku project."),
      },
    },
    async ({ audience, cwd, ...options }) => {
      try {
        const root = findProjectRoot(cwd);
        const decision = planPulseDispatch({ events: readPulseEvents(root), ...options });
        if (!decision.snapshot || !["send", "coalesce"].includes(decision.outcome)) throw new Error(`Projection refused dispatcher outcome '${decision.outcome}' (${decision.reasonCode}).`);
        return json({ root, decision, audience, output: renderPulseProjection(decision.snapshot, audience) });
      } catch (err) { return fail(err); }
    },
  );

  // ----- goals -----

  server.registerTool(
    "goal_create",
    {
      title: "Create a convergence goal",
      description:
        "Declare a goal with machine-checkable success criteria. Each criterion pairs a read-only probe (shell command, HTTP request, or MCP connector tool) with an assertion over its output (JMESPath path + operator). The harness will deterministically verify these on every goal_assess. If the user's goal is vague, pin down how success is verified before encoding it.",
      inputSchema: {
        objective: z.string().min(1).describe("What converged looks like, in one sentence."),
        slug: z.string().optional().describe("Short stable handle (derived from objective if omitted)."),
        // No .min(1) here: the engine's error message explains WHY a
        // criterion is required, which beats a raw schema validation dump.
        criteria: z.array(CriterionInputSchema),
        constraints: z.array(z.string()).optional().describe("Hard constraints the agent must respect while acting."),
        autonomy: AutonomySchema.optional().describe("Default: suggest."),
        maxIterations: z.number().int().positive().max(1000).optional().describe("Action budget before the goal blocks (default 10)."),
        cwd: z
          .string()
          .optional()
          .describe(
            "Project dir this goal belongs to, for cross-project scoping (default: the server's own cwd). Stamped once at creation as `project` (the git repo root of this dir, or the dir itself outside a repo); pass it explicitly if the server's cwd doesn't match where the goal is really being worked.",
          ),
      },
    },
    async (args) => {
      try {
        const goal = harness.createGoal({ ...args, cwd: args.cwd ?? process.cwd() });
        logAudit("goal_create", goal.slug, goal.objective.slice(0, 120), true);
        return json({
          goal: goalSummary(goal),
          criteria: redactCriteria(goal.criteria),
          guidance: buildCreateGuidance(goal),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "goal_list",
    {
      title: "List goals",
      description: "List all goals, optionally filtered by status (active | converged | blocked | abandoned).",
      inputSchema: {
        status: z.enum(["active", "converged", "blocked", "abandoned"]).optional(),
      },
    },
    async ({ status }) => {
      try {
        const goals = harness.store
          .listGoals()
          .filter((g) => !status || g.status === status)
          .map(goalSummary);
        return json({ count: goals.length, goals });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "goal_get",
    {
      title: "Get goal details",
      description: "Full goal definition including criteria, plus its recorded action trace.",
      inputSchema: { goal: GOAL_REF },
    },
    async ({ goal: ref }) => {
      try {
        const goal = harness.getGoal(ref);
        const trace = harness.store.listRecords(goal.id);
        return json({ goal: { ...goal, criteria: redactCriteria(goal.criteria) }, trace });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "goal_update",
    {
      title: "Update a goal",
      description:
        "Update objective, autonomy, constraints, iteration budget, or CRITERIA. Raising maxIterations unblocks a blocked goal. Set status to 'abandoned' to retire a goal, or 'active' to resume one. Refine criteria in place — no need to create a new goal to fix a wrong/incomplete probe: addCriteria appends new ones, removeCriteriaIds drops by id (see goal_get), editCriteria patches an existing criterion's description/probe/assert by id (fields you omit are preserved). Criteria not referenced by any of these are left unchanged. Editing criteria on a converged goal reopens it to 'active' (or 'blocked' if the budget is exhausted) — its convergence was proven against the OLD criteria and no longer holds; re-run goal_assess.",
      inputSchema: {
        goal: GOAL_REF,
        objective: z.string().optional(),
        autonomy: AutonomySchema.optional(),
        constraints: z.array(z.string()).optional(),
        maxIterations: z.number().int().positive().max(1000).optional(),
        status: z.enum(["active", "abandoned"]).optional(),
        addCriteria: z.array(CriterionInputSchema).optional().describe("New criteria to append."),
        removeCriteriaIds: z
          .array(z.string())
          .optional()
          .describe("Ids of existing criteria to drop (see goal_get for ids)."),
        editCriteria: z
          .array(CriterionEditSchema)
          .optional()
          .describe(
            "Patch existing criteria by id. Only the fields given (description/probe/assert) are changed; everything else on that criterion is preserved.",
          ),
      },
    },
    async ({ goal: ref, ...patch }) => {
      try {
        const goal = harness.updateGoal(ref, patch);
        const criteriaTouched =
          (patch.addCriteria?.length ?? 0) + (patch.removeCriteriaIds?.length ?? 0) + (patch.editCriteria?.length ?? 0) >
          0;
        logAudit("goal_update", goal.slug, Object.keys(patch).join(","), true);
        return json({
          goal: goalSummary(goal),
          ...(criteriaTouched ? { criteria: redactCriteria(goal.criteria) } : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "goal_delete",
    {
      title: "Delete a goal",
      description: "Delete a goal and its action trace. Learned workflows survive.",
      inputSchema: { goal: GOAL_REF },
    },
    async ({ goal: ref }) => {
      try {
        const goal = harness.deleteGoal(ref);
        logAudit("goal_delete", goal.slug, "", true);
        return json({ deleted: goal.slug });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "goal_assess",
    {
      title: "Assess convergence (run all probes)",
      description:
        "THE core loop step. Runs every criterion's probe, evaluates every assertion, and reports converged/unmet with next-step guidance. Read-only and does not consume the iteration budget — call it freely, including as a final verification after acting.",
      inputSchema: { goal: GOAL_REF },
    },
    async ({ goal: ref }) => {
      try {
        // A frontier coding agent is reading this — it is the final judge of
        // workflow relevance (better than a lite model, and zero-dependency).
        return json(await harness.assess(ref, { agentJudges: true }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "goal_record",
    {
      title: "Record an action taken toward a goal",
      description:
        "Log ONE corrective action you just took (this consumes one iteration of the budget). The trace becomes a reusable workflow when the goal converges — record honestly, including failures.",
      inputSchema: {
        goal: GOAL_REF,
        summary: z.string().min(1).describe("What you did, imperatively: 'Set min-instances=1 on svc-x'."),
        detail: z.string().optional().describe("Command/diff/output details worth keeping."),
        tool: z.string().optional().describe("Tool used (e.g. Bash, gcloud, connector:github)."),
        result: ActionResultSchema.optional().describe("Default: success."),
      },
    },
    async ({ goal: ref, ...input }) => {
      try {
        if (harness.store.isPaused()) return json({ recorded: false, paused: true });
        // Secrets must never enter a goal's trace — it is promoted into a
        // reusable workflow and can be baked into a repo-committed skill.
        const safe = {
          ...input,
          summary: redactSecrets(input.summary),
          ...(input.detail ? { detail: redactSecrets(input.detail) } : {}),
        };
        const { record, goal } = harness.recordAction(ref, safe);
        logAudit("goal_record", goal.slug, record.summary.slice(0, 120), record.result !== "failure");
        return json({
          recorded: { iteration: record.iteration, summary: record.summary, result: record.result },
          goalStatus: goal.status,
          guidance: buildRecordGuidance(goal),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "goal_focus",
    {
      title: "Focus a goal for live capture",
      description:
        "Declare that you are now working toward this goal. While focused, every real action you take (Bash/Edit/Write/connector — not inspection) is captured into the goal's trace LIVE as a source:'activity' record, so a build-then-verify run becomes a reusable workflow without you calling goal_record by hand. Capture is scoped to this session/project so it won't absorb other work. Also backfills the goal's `project` (cross-project scoping) from this cwd if it wasn't already stamped at goal_create. Clears automatically when the goal converges; call goal_unfocus to stop early.",
      inputSchema: {
        goal: GOAL_REF,
        cwd: z.string().optional().describe("Project dir to scope capture to (default: the server's cwd)."),
        sessionId: z.string().optional().describe("Session to scope capture to."),
      },
    },
    async ({ goal: ref, cwd, sessionId }) => {
      try {
        const focus = harness.setFocus(ref, {
          cwd: cwd ?? process.cwd(),
          ...(sessionId ? { sessionId } : {}),
        });
        logAudit("goal_focus", focus.goalSlug, focus.cwd ?? "", true);
        return json({
          focused: focus,
          guidance: `Now capturing actions toward '${focus.goalSlug}' live (scope: ${focus.cwd ?? "any"}). They land in the trace as source:"activity" and become the learned workflow on convergence. Call goal_unfocus to stop.`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "goal_unfocus",
    {
      title: "Stop live capture",
      description: "Stop capturing activity into the focused goal's trace.",
      inputSchema: {},
    },
    async () => {
      try {
        const prev = harness.clearFocus();
        logAudit("goal_unfocus", prev?.goalSlug ?? "", "", true);
        return json({ cleared: prev?.goalSlug ?? null });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ----- connectors -----

  server.registerTool(
    "connector_add",
    {
      title: "Register a connector",
      description:
        "Onboard a connector — the standard way to extend the harness's reach. Three classes: stdio MCP servers (command + args), HTTP/Streamable-HTTP MCP servers (url + headers), and 'openapi' connectors SYNTHESIZED from an OpenAPI 3.x / Swagger 2 spec (specUrl + optional baseUrl/auth; read-only GET/HEAD tools unless allowMutating). Verification happens before registration; openapi verification is sandboxed (spec parse only, no live API call). Optional autonomy sets the trust level for connector_call (defaults: mcp = autonomous, openapi = approve).",
      inputSchema: {
        name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-_]*$/, "lowercase alphanumeric with - or _"),
        transport: ConnectorTransportSchema,
        description: z.string().optional(),
        autonomy: AutonomySchema.optional(),
      },
    },
    async ({ name, transport, description, autonomy }) => {
      try {
        const { tools, warnings } = await harness.connectors.add({
          name,
          transport,
          ...(description ? { description } : {}),
          ...(autonomy ? { autonomy } : {}),
          addedAt: new Date().toISOString(),
        });
        const connector = harness.connectors.get(name);
        const level = connector ? connectorAutonomy(connector) : "autonomous";
        // Context layer v0: MCP servers self-describe — capture every tool
        // description as knowledge at registration. Free grounding for the
        // pattern annotator and for agents asking "what can this do?".
        const now = new Date().toISOString();
        for (const t of tools) {
          if (!t.description) continue;
          fileKnowledge({
            id: newId("kn"),
            subject: `operation:${name}.${t.name}`,
            kind: "operation",
            fact: t.description.slice(0, 500),
            source: "mcp-description",
            at: now,
          });
        }
        logAudit("connector_add", name, `registered ${transport.type} connector (${tools.length} tools, autonomy ${level})`, true);
        return json({
          connector: name,
          connected: true,
          autonomy: level,
          tools,
          ...(warnings ? { warnings } : {}),
          guidance: `Connector '${name}' is live with ${tools.length} tool(s) at autonomy '${level}'. Use connector_call to invoke them, or reference it in goal criteria via probes of kind 'mcp'.${level === "approve" ? " Calls will queue as approval requests for a human decision." : ""}`,
        });
      } catch (err) {
        logAudit("connector_add", name, `failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`, false);
        return fail(err);
      }
    },
  );

  server.registerTool(
    "connector_list",
    {
      title: "List connectors",
      description: "List registered connectors (the context layer).",
      inputSchema: {},
    },
    async () => {
      try {
        return json({ connectors: harness.connectors.list().map(redactConnector) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "connector_remove",
    {
      title: "Remove a connector",
      description: "Disconnect and deregister a connector.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      try {
        const removed = await harness.connectors.remove(name);
        if (removed) logAudit("connector_remove", name, "", true);
        return removed
          ? json({ removed: name })
          : fail(new Error(`No connector named '${name}'.`));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "connector_tools",
    {
      title: "List a connector's tools",
      description: "Discover what a registered connector can do.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      try {
        return json({ connector: name, tools: await harness.connectors.listTools(name) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "connector_call",
    {
      title: "Call a tool on a connector (autonomy-gated)",
      description:
        "Invoke a tool on a registered connector through the harness. Gated by the connector's autonomy level: observe/suggest refuse with guidance, approve queues an approval request for a human decision, autonomous executes directly. Probes (goal_assess) are NOT gated — they are read-only by convention.",
      inputSchema: {
        name: z.string().describe("Connector name."),
        tool: z.string(),
        args: z.record(z.unknown()).optional(),
      },
    },
    async ({ name, tool, args }) => {
      try {
        const connector = harness.connectors.get(name);
        if (!connector) {
          return fail(new Error(`Unknown connector '${name}'. Register it first with connector_add.`));
        }
        const decision = gateCall(connector, tool);
        if (decision.action === "refuse") {
          logAudit("connector_call", name, `refused ${tool} (autonomy ${connectorAutonomy(connector)})`, false);
          return json({
            executed: false,
            autonomy: connectorAutonomy(connector),
            guidance: decision.guidance,
          });
        }
        if (decision.action === "enqueue") {
          // Validate the tool exists (and survived the read-only filter for
          // openapi connectors) BEFORE asking a human to approve it — don't
          // desensitize approvers with requests that can only fail.
          const tools = await harness.connectors.listTools(name);
          if (!tools.some((t) => t.name === tool)) {
            logAudit("connector_call", name, `rejected ${tool}: no such tool`, false);
            return fail(
              new Error(
                `Connector '${name}' exposes no tool '${tool}' (read-only connectors hide mutating tools) — nothing was queued.`,
              ),
            );
          }
          const approval = enqueueApproval(harness.store, {
            connector: name,
            tool,
            args: args ?? {},
            reason: `connector '${name}' autonomy is 'approve'`,
          });
          logAudit("connector_call", name, `queued ${tool} as ${approval.id}`, true);
          return json({
            executed: false,
            queued: approval.id,
            guidance: `${decision.guidance} Approval id: ${approval.id} — a human decides via approval_approve/approval_deny (or 'keyoku-harness approvals').`,
          });
        }
        const result = await harness.connectors.callTool(name, tool, args ?? {});
        logAudit("connector_call", name, `${tool} → ${result.isError ? "error" : "ok"}`, !result.isError);
        // Feed the observation stream — connector usage is activity too, so
        // repeated external workflows (file issue → post message → …) become
        // detectable patterns that draft as runnable mcp_call steps. Honor
        // `keyoku pause`: the privacy switch must stop THIS recording path too.
        if (!result.isError && !harness.store.isPaused()) {
          harness.store.appendActivity(
            enrichWithEntities({
              id: newId("ev"),
              type: "tool_use",
              summary: `connector_call: ${name}.${tool}`,
              detail: redactSecrets(JSON.stringify({ connector: name, tool, args: args ?? {} })).slice(0, 500),
              tool: "connector_call",
              at: new Date().toISOString(),
            }),
          );
        }
        return {
          content: [{ type: "text", text: result.text || "(empty result)" }],
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (err) {
        logAudit("connector_call", name, `${tool} threw: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`, false);
        return fail(err);
      }
    },
  );

  // ----- learning + status -----

  server.registerTool(
    "workflow_list",
    {
      title: "List learned workflows",
      description:
        "Workflows promoted from converged goals' action traces, with stability stats (convergence counts). Optionally filter with a free-text query matched against objectives.",
      inputSchema: { query: z.string().optional() },
    },
    async ({ query }) => {
      try {
        let workflows = harness.store.listWorkflows();
        if (query) {
          const q = query.toLowerCase();
          workflows = workflows.filter(
            (w) =>
              w.objective.toLowerCase().includes(q) ||
              w.slug.includes(q) ||
              w.steps.some((s) => s.summary.toLowerCase().includes(q)),
          );
        }
        return json({ count: workflows.length, workflows });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "harness_status",
    {
      title: "Harness status",
      description:
        "Overview: goals by status, connectors (with autonomy), learned workflows and patterns, pending approvals, storage location.",
      inputSchema: {},
    },
    async () => {
      try {
        const goals = harness.store.listGoals();
        const byStatus: Record<string, number> = {};
        for (const g of goals) byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
        return json({
          home: harness.store.dir,
          goals: { total: goals.length, byStatus, active: goals.filter((g) => g.status === "active").map(goalSummary) },
          connectors: harness.connectors
            .list()
            .map((c) => ({ name: c.name, transport: c.transport.type, autonomy: connectorAutonomy(c) })),
          workflows: harness.store.listWorkflows().map((w) => ({ slug: w.slug, convergences: w.stats.convergences })),
          patterns: harness.store.listPatterns().length,
          pendingApprovals: harness.store.listApprovals("pending").length,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ----- M2: learning loop -----

  server.registerTool(
    "harness_learn",
    {
      title: "Run the learning loop (mine patterns)",
      description:
        "Mine reusable patterns from everything the harness has observed: action traces, observations, drift/recovery cycles, workflows. Uses the configured SLM (KEYOKU_SLM_PROVIDER + GEMINI_API_KEY or ANTHROPIC_API_KEY) and falls back to zero-LLM heuristic mining when none is configured. Mined patterns surface in goal_assess guidance for similar goals.",
      inputSchema: {},
    },
    async () => {
      try {
        const slm = resolveSlmFromEnv();
        const result = await runLearning(harness.store, slm);
        logAudit("harness_learn", undefined, `${result.method}: ${result.created} created, ${result.reinforced} reinforced`, true);
        return json({
          ...result,
          slm: slm ? `${slm.name}:${slm.model}` : null,
          guidance:
            result.method === "heuristic" && !slm
              ? "Mined heuristically (no SLM configured). For deeper mining, set GEMINI_API_KEY or ANTHROPIC_API_KEY (and optionally KEYOKU_SLM_PROVIDER / KEYOKU_SLM_MODEL) in the server's environment."
              : `Mined via ${result.method}. Patterns now inform goal_assess guidance for similar goals.`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "pattern_list",
    {
      title: "List mined patterns",
      description:
        "Patterns mined by the learning loop, with stability (reinforced by re-observation, decayed by disuse). Optional free-text query ranks by relevance.",
      inputSchema: { query: z.string().optional() },
    },
    async ({ query }) => {
      try {
        const now = new Date();
        const patterns = query
          ? relevantPatterns(harness.store, query, now)
          : harness.store.listPatterns();
        return json({
          count: patterns.length,
          patterns: patterns.map((p) => ({
            ...p,
            effectiveStability: Number(effectiveStability(p, now).toFixed(2)),
          })),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "observation_list",
    {
      title: "List observations for a goal",
      description:
        "The episodic record the perception layer keeps per goal: every assessment, drift, convergence, and block, plus transition counts.",
      inputSchema: { goal: GOAL_REF, limit: z.number().int().positive().max(500).optional() },
    },
    async ({ goal: ref, limit }) => {
      try {
        const goal = harness.getGoal(ref);
        return json({
          goal: goal.slug,
          transitions: stateTransitions(harness.store, goal.id),
          digest: observationDigest(harness.store, goal.id, limit ?? 50),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ----- M4: approvals + audit -----

  server.registerTool(
    "connector_set_autonomy",
    {
      title: "Set a connector's autonomy level",
      description:
        "Move a connector along the trust ladder: observe (probes only) → suggest (propose, user runs) → approve (calls queue for human approval) → autonomous (calls execute directly). Treat promotions as a human decision.",
      inputSchema: { name: z.string(), autonomy: AutonomySchema },
    },
    async ({ name, autonomy }) => {
      try {
        const connector = harness.connectors.get(name);
        if (!connector) return fail(new Error(`No connector named '${name}'.`));
        harness.store.saveConnector({ ...connector, autonomy });
        logAudit("connector_set_autonomy", name, `→ ${autonomy}`, true);
        return json({ connector: name, autonomy });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "approval_list",
    {
      title: "List approval requests",
      description: "Queued connector calls awaiting (or past) a human decision.",
      inputSchema: {
        status: z.enum(["pending", "denied", "executed", "failed"]).optional(),
      },
    },
    async ({ status }) => {
      try {
        const approvals = harness.store.listApprovals(status);
        return json({ count: approvals.length, approvals });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "approval_approve",
    {
      title: "Approve a queued connector call (human decision)",
      description:
        "Execute a pending approval request. This is the human's tool: agents must not call it for their own queued requests unless the user explicitly tells them to. Keep it un-allowlisted in your MCP client so each approval prompts.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const approval = await decideApproval(harness.store, id, "approve", (c, t, a) =>
          harness.connectors.callTool(c, t, a),
        );
        logAudit("approval_approve", approval.connector, `${approval.tool} → ${approval.status}`, approval.status === "executed");
        return json({ approval });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "approval_deny",
    {
      title: "Deny a queued connector call",
      description: "Reject a pending approval request, optionally with a reason the agent can learn from.",
      inputSchema: { id: z.string(), reason: z.string().optional() },
    },
    async ({ id, reason }) => {
      try {
        const approval = await decideApproval(
          harness.store,
          id,
          "deny",
          (c, t, a) => harness.connectors.callTool(c, t, a),
          reason,
        );
        logAudit("approval_deny", approval.connector, approval.tool, true);
        return json({ approval });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "audit_list",
    {
      title: "List the audit trail",
      description: "Append-only record of every consequential harness operation (most recent last).",
      inputSchema: { limit: z.number().int().positive().max(1000).optional() },
    },
    async ({ limit }) => {
      try {
        const entries = harness.store.listAudit(limit ?? 100);
        return json({ count: entries.length, entries });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ----- activity observation -----

  function summarizeExecution(ex: WorkflowExecution) {
    return {
      id: ex.id,
      templateSlug: ex.templateSlug,
      status: ex.status,
      currentStep: ex.currentStep,
      totalSteps: ex.steps.length,
      startedAt: ex.startedAt,
      completedAt: ex.completedAt,
      steps: ex.steps.map((s) => ({
        index: s.index,
        type: s.type,
        summary: s.summary,
        status: s.status,
        result: s.result?.slice(0, 200),
      })),
    };
  }

  /**
   * Run an execution forward from startIdx. Shared by workflow_execute and
   * execution_complete so step semantics and audit logging cannot drift apart.
   * Persists after every step (crash-safe); pauses on agent_prompt /
   * human_review; fails fast on a misconfigured step instead of leaving it
   * stuck in "running".
   */
  // Executions cancelled mid-flight. execution_cancel records here for an
  // immediate same-process signal; advanceExecution also re-reads the store so
  // a cross-process cancel (another session) is honored too.
  const cancelledExecutions = new Set<string>();
  const isCancelled = (execId: string): boolean =>
    cancelledExecutions.has(execId) || harness.store.getExecution(execId)?.status === "failed";
  const cancelledResult = (execId: string): ToolResult => {
    const persisted = harness.store.getExecution(execId);
    return json({
      execution: persisted ? summarizeExecution(persisted) : { id: execId, status: "failed" },
      cancelled: true,
      guidance: "Execution was cancelled; remaining steps were not run.",
    });
  };

  async function advanceExecution(
    exec: WorkflowExecution,
    template: WorkflowTemplate | undefined,
    startIdx: number,
  ): Promise<ToolResult> {
    const failAt = (i: number, error: string): ToolResult => {
      exec.status = "failed";
      harness.store.saveExecution(exec);
      logAudit("workflow_execute", exec.templateSlug, `failed at step ${i}`, false);
      return json({ execution: summarizeExecution(exec), failed_at: i, error });
    };

    for (let i = startIdx; i < exec.steps.length; i++) {
      // Cancellation can arrive (as a separate execution_cancel tool call)
      // while we are awaiting a step. Re-check before starting each step and
      // bail without overwriting the cancelled record — otherwise cancel is a
      // no-op and every remaining step still runs.
      if (isCancelled(exec.id)) return cancelledResult(exec.id);

      const s = exec.steps[i];
      s.status = "running";
      s.startedAt = new Date().toISOString();
      exec.currentStep = i;
      harness.store.saveExecution(exec);

      if (s.type === "bash") {
        if (!s.command) {
          // No fallback to s.summary — running a human-readable summary as a
          // shell command is never intended and is a data-integrity hazard.
          s.status = "failed";
          s.error = "bash step is missing a command";
          s.completedAt = new Date().toISOString();
          return failAt(i, s.error);
        }
        const { result, ok } = await executeBashStep(s.command, {
          ...(s.cwd ? { cwd: s.cwd } : {}),
          ...(exec.paramEnv ? { env: exec.paramEnv } : {}),
        });
        if (isCancelled(exec.id)) return cancelledResult(exec.id);
        s.result = result;
        s.status = ok ? "done" : "failed";
        s.completedAt = new Date().toISOString();
        if (!ok) return failAt(i, result);
        harness.store.saveExecution(exec);
      } else if (s.type === "mcp_call") {
        if (!s.connector || !s.tool) {
          s.status = "failed";
          s.error = "mcp_call step is missing connector or tool";
          s.completedAt = new Date().toISOString();
          return failAt(i, s.error);
        }
        // Workflow steps respect the same autonomy gate as connector_call —
        // putting a tool in a template must not bypass approval.
        const stepConnector = harness.connectors.get(s.connector);
        if (!stepConnector) {
          s.status = "failed";
          s.error = `unknown connector '${s.connector}'`;
          s.completedAt = new Date().toISOString();
          return failAt(i, s.error);
        }
        const decision = gateCall(stepConnector, s.tool);
        if (decision.action === "refuse") {
          s.status = "failed";
          s.error = decision.guidance;
          s.completedAt = new Date().toISOString();
          return failAt(i, s.error);
        }
        if (decision.action === "enqueue") {
          const approval = enqueueApproval(harness.store, {
            connector: s.connector,
            tool: s.tool,
            args: s.args ?? {},
            reason: `workflow '${exec.templateSlug}' step ${i} — connector autonomy is 'approve'`,
          });
          s.status = "waiting_human";
          s.approvalId = approval.id; // link so execution_complete can require it be decided
          exec.status = "waiting_human";
          harness.store.saveExecution(exec);
          return json({
            execution: summarizeExecution(exec),
            waiting_for: "human",
            approval_id: approval.id,
            step: { index: i, type: "mcp_call", summary: s.summary },
            guidance: `Step ${i} needs approval (${approval.id}). Decide with approval_approve/approval_deny, then call execution_complete { id: "${exec.id}", step_index: ${i}, result: "<outcome>" } to continue.`,
          });
        }
        const { result, ok } = await executeMcpStep(s.connector, s.tool, s.args ?? {}, harness.connectors);
        if (isCancelled(exec.id)) return cancelledResult(exec.id);
        s.result = result;
        s.status = ok ? "done" : "failed";
        s.completedAt = new Date().toISOString();
        if (!ok) return failAt(i, result);
        harness.store.saveExecution(exec);
      } else if (s.type === "agent_prompt") {
        s.status = "waiting_agent";
        exec.status = "waiting_agent";
        harness.store.saveExecution(exec);
        return json({
          execution: summarizeExecution(exec),
          waiting_for: "agent",
          step: { index: i, type: "agent_prompt", summary: s.summary, prompt: s.prompt },
          guidance: `Handle this step, then call execution_complete { id: "${exec.id}", step_index: ${i}, result: "your result" } to continue.`,
        });
      } else {
        s.status = "waiting_human";
        exec.status = "waiting_human";
        harness.store.saveExecution(exec);
        return json({
          execution: summarizeExecution(exec),
          waiting_for: "human",
          step: { index: i, type: "human_review", summary: s.summary, message: s.message },
          guidance: `Review required. When ready, call execution_complete { id: "${exec.id}", step_index: ${i}, result: "approved" }.`,
        });
      }
    }

    exec.status = "done";
    exec.completedAt = new Date().toISOString();
    harness.store.saveExecution(exec);
    if (template) {
      template.timesRun += 1;
      harness.store.saveTemplate(template);
    }
    logAudit("workflow_execute", exec.templateSlug, `completed ${exec.steps.length} steps`, true);
    // Graduation hint at stability milestones: proven workflows deserve to
    // be baked into the repo as agent skills (the practice → bake ladder).
    const bakeHint =
      template && [5, 10, 25].includes(template.timesRun)
        ? {
            bake_hint: `'${template.slug}' has now run ${template.timesRun}× — it has earned permanence. Bake it into the repo as a team-shareable skill: keyoku export ${template.slug}`,
          }
        : {};
    return json({ execution: summarizeExecution(exec), completed: true, ...bakeHint });
  }

  // ----- workflow prompts catalog -----
  // Every approved workflow is published as an MCP prompt; MCP hosts surface
  // prompts natively (Claude Code renders them as slash commands), so the
  // catalog is ambient and always current — no asking required.
  // A static catalog prompt registered before connect — this installs the
  // prompt handlers up front so per-workflow prompts can register dynamically
  // after the transport is live (SDK installs handlers on first registration).
  server.registerPrompt(
    "keyoku-catalog",
    {
      title: "Keyoku workflow catalog",
      description: "List your approved keyoku workflows and how to run them.",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: "Call workflow_template_list and present my approved keyoku workflows (name, slug, steps, timesRun). Remind me each can be run via workflow_execute { slug }.",
          },
        },
      ],
    }),
  );

  const workflowPrompts = new Map<string, { remove(): void }>();
  function syncWorkflowPrompts(): void {
    const templates = harness.store.listTemplates();
    const live = new Set(templates.map((t) => t.slug));
    for (const [slug, reg] of workflowPrompts) {
      if (!live.has(slug)) {
        reg.remove();
        workflowPrompts.delete(slug);
      }
    }
    for (const t of templates) {
      if (workflowPrompts.has(t.slug)) continue;
      const reg = server.registerPrompt(
        `workflow-${t.slug}`,
        { title: t.name, description: t.description },
        async () => ({
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `Run the keyoku workflow '${t.slug}' (${t.name}). Call workflow_execute { slug: "${t.slug}" }; if it pauses (waiting_for agent or human), handle the step and resume with execution_complete until it reports completed. Description: ${t.description}`,
              },
            },
          ],
        }),
      );
      workflowPrompts.set(t.slug, reg);
    }
  }
  syncWorkflowPrompts();

  server.registerTool(
    "activity_record",
    {
      title: "Record an activity event",
      description:
        "Log a user or agent action into the observation stream. Called automatically by Claude Code PostToolUse hooks, but can also be called manually for significant events.",
      inputSchema: {
        summary: z.string().min(1).describe("One-liner: 'Bash: git push origin main'"),
        type: z.enum(["tool_use", "shell", "file_change", "git", "manual"]).optional(),
        detail: z.string().optional().describe("Full command or context (truncated to 500 chars)."),
        tool: z.string().optional().describe("Claude Code tool name: Bash, Edit, Write, etc."),
        entities: z.array(z.string()).optional().describe("Files, services, endpoints involved."),
        sessionId: z.string().optional(),
      },
    },
    async (args) => {
      try {
        // `keyoku pause` is the privacy switch — honor it on the server-side
        // path too (hooks stop separately), checked per-call so a mid-session
        // pause takes effect immediately.
        if (harness.store.isPaused()) return json({ recorded: false, paused: true });
        let event: ActivityEvent = {
          id: newId("ev"),
          type: args.type ?? "manual",
          summary: redactSecrets(args.summary),
          ...(args.detail ? { detail: redactSecrets(args.detail).slice(0, 500) } : {}),
          ...(args.tool ? { tool: args.tool } : {}),
          ...(args.entities?.length ? { entities: args.entities } : {}),
          ...(args.sessionId ? { sessionId: args.sessionId } : {}),
          at: new Date().toISOString(),
        };
        event = enrichWithEntities(event);
        harness.store.appendActivity(event);
        // Live muscle memory: if a goal is focused, capture this action too.
        autoRecordToFocusGoal(harness.store, event);
        return json({ recorded: true, id: event.id });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "activity_list",
    {
      title: "List recent activity events",
      description: "Browse the observation stream — what the harness has seen you doing.",
      inputSchema: {
        limit: z.number().int().positive().max(500).optional().describe("Default 50."),
        type: z.enum(["tool_use", "shell", "file_change", "git", "manual"]).optional(),
      },
    },
    async ({ limit, type }) => {
      try {
        let events = harness.store.listActivity(limit ?? 50);
        if (type) events = events.filter((e) => e.type === type);
        return json({ count: events.length, events });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ----- knowledge (context layer v0) -----

  server.registerTool(
    "knowledge_submit",
    {
      title: "Submit knowledge to the context layer",
      description:
        "Store a researched or observed fact about a connector, operation, or domain. Use this to file findings from research the user asked for — e.g. a connector's auth model, rate limits, or dangerous operations — so future workflow suggestions are grounded in it.",
      inputSchema: {
        subject: z
          .string()
          .min(1)
          .describe("e.g. 'connector:github', 'operation:github.create_issue', 'domain:deploys'"),
        kind: z.enum(["connector", "operation", "note"]),
        fact: z.string().min(1).max(2000),
        source: z.enum(["agent-research", "user"]).optional(),
      },
    },
    async ({ subject, kind, fact, source }) => {
      try {
        if (harness.store.isPaused()) return json({ stored: false, paused: true });
        const entry = {
          id: newId("kn"),
          subject,
          kind,
          fact,
          source: source ?? ("agent-research" as const),
          at: new Date().toISOString(),
        };
        fileKnowledge(entry);
        logAudit("knowledge_submit", subject, fact.slice(0, 80), true);
        return json({ stored: true, id: entry.id });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "knowledge_query",
    {
      title: "Query the context layer",
      description:
        "Retrieve stored knowledge about connectors, operations, or domains. Filter by subject prefix and/or a text query.",
      inputSchema: {
        subject: z.string().optional().describe("Subject prefix filter, e.g. 'connector:github' or 'operation:'"),
        query: z.string().optional().describe("Case-insensitive text match over facts."),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ subject, query, limit }) => {
      try {
        // With an engine configured, text queries upgrade to semantic search
        // over the mirrored knowledge; any failure falls back to local.
        if (brain && query) {
          const hits = await brain.search(query, limit ?? 50);
          if (hits !== null) {
            const filtered = subject ? hits.filter((h) => h.subject.startsWith(subject)) : hits;
            return json({
              count: filtered.length,
              method: "engine-semantic",
              entries: filtered.map((h) => ({ subject: h.subject, fact: h.fact, score: h.score })),
            });
          }
        }
        let entries = harness.store.listKnowledge(subject);
        if (query) {
          const q = query.toLowerCase();
          entries = entries.filter((e) => e.fact.toLowerCase().includes(q) || e.subject.toLowerCase().includes(q));
        }
        entries = entries.slice(-(limit ?? 50));
        return json({ count: entries.length, method: "local", entries });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ----- workflow templates -----

  server.registerTool(
    "workflow_suggest",
    {
      title: "Suggest workflows from observed activity",
      description:
        "Suggest workflows from recent activity. Heuristic mining proposes candidate sequences; when an SLM is configured (GEMINI_API_KEY or ANTHROPIC_API_KEY) the model refines them — filtering noise, naming them properly, and parameterizing commands. Falls back to heuristic-only with no key. Approve drafts with workflow_approve.",
      inputSchema: {
        min_count: z.number().int().min(2).max(20).optional().describe("Min occurrences to qualify (default 3)."),
      },
    },
    async ({ min_count }) => {
      try {
        // Mine a deep window — transcript import can backfill thousands of
        // events, and per-session partitioning keeps the cost linear.
        const events = harness.store.listActivity(5000);
        const detected = detectPatterns(events, min_count ?? 3, 5000);
        let suggestions = detected.filter((s) => s.kind === "automation");

        // Practice patterns (files that change together, edit clusters) are
        // real but not runnable: file them into the knowledge layer — where
        // they ground refinement and answer agent queries — and mark them
        // surfaced so they are never offered as run buttons.
        const practice = detected.filter((s) => s.kind === "practice");
        let practiceFiled = 0;
        if (practice.length > 0) {
          const surfaced = loadSurfaced(harness.store.dir);
          for (const p of practice) {
            if (surfaced.has(p.key)) continue;
            surfaced.add(p.key);
            fileKnowledge({
              id: newId("kn"),
              subject: `practice:${practiceSubject(p)}`,
              kind: "note",
              fact: `Recurring work pattern (${p.count}×): ${p.draftSteps.map((s) => s.summary).join(" → ")}`.slice(0, 800),
              source: "pattern-mining",
              at: new Date().toISOString(),
            });
            practiceFiled += 1;
          }
          saveSurfaced(harness.store.dir, surfaced);
        }

        let method = "heuristic";
        const slm = resolveSlmFromEnv();
        if (slm && suggestions.length > 0) {
          // Ground the model: recent activity for situational context plus
          // the knowledge layer (operation meanings, researched facts).
          suggestions = await refineSuggestions(
            slm,
            suggestions,
            events.slice(-40),
            harness.store.listKnowledge().slice(-100),
          );
          method = `heuristic+${slm.name}`;
        }
        return json({
          count: suggestions.length,
          suggestions,
          ...(practiceFiled > 0 ? { practice_filed: practiceFiled } : {}),
          method,
          guidance:
            suggestions.length === 0
              ? "Not enough recurring patterns yet — keep working and run workflow_suggest again after more activity is recorded."
              : method === "heuristic"
                ? "These are raw heuristic drafts — refine them before approving: merge overlapping fragments of the same workflow, drop coincidental sequences, replace run-specific values (commit messages, file paths) with {{placeholders}}, generalize agent_prompt steps to intent (e.g. 'fix the failing tests'), and write a real name/description. Then call workflow_approve { slug, name, description, steps }."
                : "Model-refined drafts. Review and approve with workflow_approve { slug, name, description, steps }.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "workflow_capture",
    {
      title: "Capture recent actions as a workflow draft",
      description:
        "On-demand capture for 'save what I just did': turns the last N actions of the current session into a workflow draft. No repetition needed — pattern detection requires 3×, capture requires the user vouching once. Returns a draft to review, clean up, and save with workflow_approve.",
      inputSchema: {
        last: z.number().int().min(1).max(50).optional().describe("How many recent actions to capture (default 10)."),
        name: z.string().optional(),
        slug: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-_]*$/)
          .optional(),
      },
    },
    async ({ last, name, slug }) => {
      try {
        const all = harness.store.listActivity(500);
        if (all.length === 0) return fail(new Error("No activity recorded yet."));
        // "The current session" = the session of the most recent event.
        const session = all[all.length - 1].sessionId;
        const recent = all.filter((e) => e.sessionId === session).slice(-(last ?? 10));
        const steps = recent.map(draftStep);
        const draftName = name ?? `Captured: ${recent[0]?.summary.slice(0, 50) ?? "recent work"}`;
        const draftSlug = slug ?? harness.store.uniqueSlug(slugify(draftName));
        return json({
          draft: {
            slug: draftSlug,
            name: draftName,
            description: `Captured on demand from the last ${recent.length} actions of the current session.`,
            steps,
          },
          guidance:
            "Review with the user before saving: drop noise steps (Reads, inspections), parameterize run-specific values with {{placeholders}}, tighten the name/description, then call workflow_approve { slug, name, description, steps }.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "workflow_approve",
    {
      title: "Approve (save) a workflow template",
      description:
        "Save an approved workflow template — either from a workflow_suggest draft or hand-authored. Once saved, trigger with workflow_execute.",
      inputSchema: {
        slug: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][a-z0-9-_]*$/)
          .describe("Short handle, e.g. 'deploy-and-verify'."),
        name: z.string().min(1),
        description: z.string().min(1),
        steps: z
          .array(
            z
              .object({
                type: z.enum(["bash", "agent_prompt", "mcp_call", "human_review"]),
                summary: z.string().min(1),
                command: z.string().optional(),
                cwd: z.string().optional().describe("Working directory for bash steps (default: the server's cwd)."),
                prompt: z.string().optional(),
                connector: z.string().optional(),
                tool: z.string().optional(),
                args: z.record(z.unknown()).optional(),
                message: z.string().optional(),
              })
              .superRefine((s, ctx) => {
                // A bash step with no command would otherwise fall through to
                // running its human summary as a shell command — reject at the
                // trust boundary. (mcp_call misconfig is caught gracefully at
                // execution time so a partial template can still be inspected.)
                if (s.type === "bash" && !s.command)
                  ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a bash step requires a 'command'" });
              }),
          )
          .min(1),
        overwrite: z
          .boolean()
          .optional()
          .describe("Set true to replace an existing template with the same slug. Default false — collisions are refused."),
      },
    },
    async ({ slug, name, description, steps, overwrite }) => {
      try {
        const now = new Date().toISOString();
        const existing = harness.store.getTemplate(slug);
        if (existing && !overwrite)
          return fail(
            new Error(
              `A template '${slug}' already exists (ran ${existing.timesRun}× since ${existing.approvedAt}). ` +
                `Pass overwrite: true to replace it, edit it in place with workflow_update, or choose a different slug.`,
            ),
          );
        const template: WorkflowTemplate = existing
          ? { ...existing, name, description, steps: steps as WorkflowStepTemplate[], updatedAt: now }
          : {
              id: newId("tmpl"),
              slug,
              name,
              description,
              steps: steps as WorkflowStepTemplate[],
              trigger: { type: "on_demand" },
              approvedAt: now,
              createdAt: now,
              updatedAt: now,
              timesRun: 0,
            };
        harness.store.saveTemplate(template);
        syncWorkflowPrompts();
        logAudit("workflow_approve", slug, `${steps.length} steps`, true);
        return json({
          template: { id: template.id, slug: template.slug, name: template.name, steps: template.steps.length },
          guidance: `Template '${slug}' saved. Run it with workflow_execute { slug: "${slug}" }.`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "workflow_update",
    {
      title: "Update a workflow template",
      description:
        "Edit an approved workflow in place — rename, redescribe, or replace steps — without losing its identity, run count, or published slash command.",
      inputSchema: {
        slug: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        steps: z
          .array(
            z.object({
              type: z.enum(["bash", "agent_prompt", "mcp_call", "human_review"]),
              summary: z.string().min(1),
              command: z.string().optional(),
              cwd: z.string().optional(),
              prompt: z.string().optional(),
              connector: z.string().optional(),
              tool: z.string().optional(),
              args: z.record(z.unknown()).optional(),
              message: z.string().optional(),
            }),
          )
          .min(1)
          .optional(),
      },
    },
    async ({ slug, name, description, steps }) => {
      try {
        const template = harness.store.getTemplate(slug);
        if (!template) return fail(new Error(`No template '${slug}'.`));
        if (!name && !description && !steps)
          return fail(new Error("Nothing to update — pass name, description, and/or steps."));
        if (name) template.name = name;
        if (description) template.description = description;
        if (steps) template.steps = steps as WorkflowStepTemplate[];
        template.updatedAt = new Date().toISOString();
        harness.store.saveTemplate(template);
        // Refresh the published prompt so the catalog reflects the edit.
        workflowPrompts.get(template.slug)?.remove();
        workflowPrompts.delete(template.slug);
        syncWorkflowPrompts();
        logAudit(
          "workflow_update",
          slug,
          [name && "name", description && "description", steps && "steps"].filter(Boolean).join("+"),
          true,
        );
        return json({
          updated: slug,
          template: { slug: template.slug, name: template.name, steps: template.steps.length, timesRun: template.timesRun },
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "workflow_template_list",
    {
      title: "List approved workflow templates",
      description: "All templates approved by the user, ready to execute.",
      inputSchema: { query: z.string().optional() },
    },
    async ({ query }) => {
      try {
        let templates = harness.store.listTemplates();
        if (query) {
          const q = query.toLowerCase();
          templates = templates.filter(
            (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.slug.includes(q),
          );
        }
        return json({
          count: templates.length,
          templates: templates.map((t) => ({
            id: t.id,
            slug: t.slug,
            name: t.name,
            description: t.description,
            steps: t.steps.length,
            timesRun: t.timesRun,
            approvedAt: t.approvedAt,
          })),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "workflow_template_delete",
    {
      title: "Delete a workflow template",
      description: "Remove an approved template.",
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      try {
        const template = harness.store.getTemplate(slug);
        if (!template) return fail(new Error(`No template '${slug}'.`));
        harness.store.deleteTemplate(template.id);
        syncWorkflowPrompts();
        logAudit("workflow_template_delete", slug, "", true);
        return json({ deleted: slug });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ----- execution -----

  server.registerTool(
    "workflow_execute",
    {
      title: "Execute a workflow template",
      description:
        "Run an approved workflow. Bash and mcp_call steps execute directly with output captured. Pauses on agent_prompt (returns the step for you to handle, then call execution_complete) and human_review steps.",
      inputSchema: {
        slug: z.string().describe("Template slug from workflow_template_list."),
        triggered_by: z.enum(["on_demand", "hook"]).optional(),
        params: z
          .record(z.string())
          .optional()
          .describe('Values for {{placeholders}} in the template, e.g. { "commit_message": "fix: …" }.'),
      },
    },
    async ({ slug, triggered_by, params }) => {
      try {
        const template = harness.store.getTemplate(slug);
        if (!template)
          return fail(new Error(`No template '${slug}'. Use workflow_template_list to see available templates.`));

        // {{placeholders}} become real here: fill from params, refuse to run
        // with holes — a half-substituted command is worse than no run.
        // SECURITY: bash `command` params are NOT interpolated into the command
        // string (that let `{{x}}` = "; rm -rf ~" inject). They are bound as
        // environment variables the command references via "$VAR", so `sh`
        // treats them as data in every quoting context. Prompt/message are text
        // (shown to an agent/human, never executed) → plain substitution.
        const missing = new Set<string>();
        const paramEnv: Record<string, string> = {};
        const keyToEnv = new Map<string, string>();
        const envNameFor = (key: string, value: string): string => {
          let envName = keyToEnv.get(key);
          if (!envName) {
            envName = `KEYOKU_PARAM_${keyToEnv.size}`;
            keyToEnv.set(key, envName);
            paramEnv[envName] = value;
          }
          return envName;
        };
        // Bind each {{param}} in a bash command to an env var reference, chosen by
        // the SHELL QUOTE STATE at that position so the value is always data,
        // never code, AND substitution still works in every context:
        //   unquoted {{x}}  → "$VAR"        (double-quote to stop word-splitting)
        //   "…{{x}}…"       → $VAR          (already inside dq — expands as data)
        //   '…{{x}}…'       → '"$VAR"'      (close sq, dq the var, reopen sq)
        // Even if quote tracking is imperfect on exotic input, all three forms are
        // injection-safe — a value like $(rm -rf ~) can never be re-evaluated.
        const bindCommand = (cmd: string | undefined): string | undefined => {
          if (!cmd) return cmd;
          let out = "";
          let quote: "'" | '"' | null = null;
          for (let i = 0; i < cmd.length; ) {
            const m = /^\{\{\s*([\w-]+)\s*\}\}/.exec(cmd.slice(i));
            if (m) {
              const key = m[1];
              const value = (params ?? {})[key];
              if (value === undefined) {
                missing.add(key);
                out += m[0];
              } else {
                const v = `$${envNameFor(key, value)}`;
                out += quote === "'" ? `'"${v}"'` : quote === '"' ? v : `"${v}"`;
              }
              i += m[0].length;
              continue;
            }
            const c = cmd[i];
            if (quote === null && (c === "'" || c === '"')) quote = c;
            else if (quote === c) quote = null;
            out += c;
            i += 1;
          }
          return out;
        };
        const filled = template.steps.map((s) => ({
          ...s,
          command: bindCommand(s.command),
          prompt: fillPlaceholders(s.prompt, params ?? {}, missing),
          message: fillPlaceholders(s.message, params ?? {}, missing),
        }));
        if (missing.size > 0)
          return fail(
            new Error(
              `Template '${slug}' needs params: ${[...missing].join(", ")}. Ask the user for values, then call workflow_execute { slug: "${slug}", params: { ... } }.`,
            ),
          );

        const now = new Date().toISOString();
        const execution: WorkflowExecution = {
          id: newId("exec"),
          templateId: template.id,
          templateSlug: template.slug,
          status: "running",
          steps: filled.map((s, i) => ({
            index: i,
            type: s.type,
            summary: s.summary,
            status: "pending" as const,
            ...(s.command ? { command: s.command } : {}),
            ...(s.cwd ? { cwd: s.cwd } : {}),
            ...(s.prompt ? { prompt: s.prompt } : {}),
            ...(s.connector ? { connector: s.connector } : {}),
            ...(s.tool ? { tool: s.tool } : {}),
            ...(s.args ? { args: s.args } : {}),
            ...(s.message ? { message: s.message } : {}),
          })),
          currentStep: 0,
          startedAt: now,
          triggeredBy: triggered_by ?? "on_demand",
          ...(Object.keys(paramEnv).length > 0 ? { paramEnv } : {}),
        };

        return advanceExecution(execution, template, 0);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "execution_complete",
    {
      title: "Complete a paused execution step",
      description:
        "Resume a workflow that is waiting for agent or human input. Provide your result for the paused step; execution continues from the next step automatically.",
      inputSchema: {
        id: z.string().describe("Execution id from workflow_execute."),
        step_index: z.number().int().describe("Index of the step you completed."),
        result: z.string().describe("Output / result of the completed step."),
        ok: z.boolean().optional().describe("Default true. Set false if the step failed."),
      },
    },
    async ({ id, step_index, result, ok = true }) => {
      try {
        const execution = harness.store.getExecution(id);
        if (!execution) return fail(new Error(`No execution '${id}'.`));
        if (execution.status === "done" || execution.status === "failed")
          return fail(new Error(`Execution '${id}' is already ${execution.status}.`));

        const step = execution.steps[step_index];
        if (!step) return fail(new Error(`No step ${step_index} in execution '${id}'.`));
        if (step_index !== execution.currentStep)
          return fail(new Error(`Expected step_index ${execution.currentStep}, got ${step_index}. Steps must be completed in order.`));
        // Only a step actually PAUSED for input may be completed by hand. Guards
        // against double-execution of downstream steps and fabricated completion
        // of a running/pending/done step (e.g. an approval-gated mcp_call).
        if (step.status !== "waiting_agent" && step.status !== "waiting_human")
          return fail(
            new Error(
              `Step ${step_index} is '${step.status}', not awaiting input — only waiting_agent/waiting_human steps can be completed with execution_complete.`,
            ),
          );
        // Approval-gated step: it may only be completed once its linked approval
        // has been DECIDED and executed — otherwise a caller could fabricate the
        // outcome of a gated mcp_call without any human approval.
        if (step.approvalId) {
          const approval = harness.store.getApproval(step.approvalId);
          if (!approval || approval.status === "pending")
            return fail(
              new Error(
                `Step ${step_index} is gated by approval '${step.approvalId}', which is not yet decided — resolve it with approval_approve / approval_deny first; it cannot be hand-completed.`,
              ),
            );
          if (approval.status !== "executed") {
            step.status = "failed";
            step.error = `linked approval '${step.approvalId}' was ${approval.status}`;
            step.completedAt = new Date().toISOString();
            execution.status = "failed";
            harness.store.saveExecution(execution);
            return json({ execution: summarizeExecution(execution), failed_at: step_index, error: step.error });
          }
          // Prefer the approval's real executed result over any provided text.
          if (typeof approval.result === "string" && approval.result) result = approval.result;
        }
        step.result = result;
        step.status = ok ? "done" : "failed";
        step.completedAt = new Date().toISOString();

        if (!ok) {
          execution.status = "failed";
          harness.store.saveExecution(execution);
          return json({ execution: summarizeExecution(execution), failed_at: step_index });
        }

        const template = harness.store.getTemplate(execution.templateSlug);
        return advanceExecution(execution, template, step_index + 1);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "execution_cancel",
    {
      title: "Cancel a workflow execution",
      description:
        "Stop a running or paused execution. The current step is marked failed with a cancellation note; the execution ends as failed.",
      inputSchema: { id: z.string().describe("Execution id from workflow_execute / execution_list.") },
    },
    async ({ id }) => {
      try {
        const execution = harness.store.getExecution(id);
        if (!execution) return fail(new Error(`No execution '${id}'.`));
        if (execution.status === "done" || execution.status === "failed")
          return fail(new Error(`Execution '${id}' is already ${execution.status}.`));
        // Signal an in-flight advanceExecution loop to stop between steps BEFORE
        // persisting — otherwise its next saveExecution could clobber this cancel.
        cancelledExecutions.add(id);
        const step = execution.steps[execution.currentStep];
        if (step && (step.status === "running" || step.status === "waiting_agent" || step.status === "waiting_human")) {
          step.status = "failed";
          step.error = "cancelled by user";
          step.completedAt = new Date().toISOString();
        }
        execution.status = "failed";
        execution.completedAt = new Date().toISOString();
        harness.store.saveExecution(execution);
        logAudit("execution_cancel", execution.templateSlug, `cancelled at step ${execution.currentStep}`, true);
        return json({ cancelled: true, execution: summarizeExecution(execution) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "execution_list",
    {
      title: "List workflow executions",
      description: "Past and in-progress workflow executions.",
      inputSchema: {
        status: z.enum(["running", "done", "failed", "waiting_agent", "waiting_human"]).optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ status, limit }) => {
      try {
        let executions = harness.store.listExecutions(status);
        if (limit) executions = executions.slice(-limit);
        return json({ count: executions.length, executions: executions.map(summarizeExecution) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
