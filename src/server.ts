import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  audit,
  connectorAutonomy,
  decideApproval,
  enqueueApproval,
  gateCall,
} from "./approvals.js";
import { detectPatterns, enrichWithEntities } from "./activity.js";
import { redactConnector } from "./connectors.js";
import type { Harness } from "./engine.js";
import { executeBashStep, executeMcpStep } from "./executor.js";
import { buildCreateGuidance, buildRecordGuidance, PROTOCOL } from "./guidance.js";
import { relevantPatterns, runLearning } from "./learn.js";
import { refineSuggestions } from "./refine.js";
import { observationDigest, stateTransitions } from "./observe.js";
import { resolveSlmFromEnv } from "./slm.js";
import { newId } from "./store.js";
import {
  ActionResultSchema,
  AutonomySchema,
  ConnectorTransportSchema,
  CriterionInputSchema,
  effectiveStability,
  type ActivityEvent,
  type Criterion,
  type Goal,
  type WorkflowExecution,
  type WorkflowStepTemplate,
  type WorkflowTemplate,
} from "./types.js";

export const VERSION = "0.1.0";

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

export function buildServer(harness: Harness): McpServer {
  const server = new McpServer(
    { name: "keyoku", version: VERSION },
    { instructions: PROTOCOL },
  );

  // M4: every consequential operation lands in the append-only audit trail.
  // audit() never throws, so this can't break the operation it records.
  const logAudit = (op: string, target: string | undefined, summary: string, ok: boolean) =>
    audit(harness.store, { actor: "agent", op, ...(target ? { target } : {}), summary, ok });

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
      },
    },
    async (args) => {
      try {
        const goal = harness.createGoal(args);
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
        "Update objective, autonomy, constraints, or iteration budget. Raising maxIterations unblocks a blocked goal. Set status to 'abandoned' to retire a goal, or 'active' to resume one.",
      inputSchema: {
        goal: GOAL_REF,
        objective: z.string().optional(),
        autonomy: AutonomySchema.optional(),
        constraints: z.array(z.string()).optional(),
        maxIterations: z.number().int().positive().max(1000).optional(),
        status: z.enum(["active", "abandoned"]).optional(),
      },
    },
    async ({ goal: ref, ...patch }) => {
      try {
        const goal = harness.updateGoal(ref, patch);
        logAudit("goal_update", goal.slug, Object.keys(patch).join(","), true);
        return json({ goal: goalSummary(goal) });
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
        return json(await harness.assess(ref));
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
        const { record, goal } = harness.recordAction(ref, input);
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
      const s = exec.steps[i];
      s.status = "running";
      s.startedAt = new Date().toISOString();
      exec.currentStep = i;
      harness.store.saveExecution(exec);

      if (s.type === "bash") {
        const { result, ok } = await executeBashStep(s.command ?? s.summary, s.cwd);
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
        const { result, ok } = await executeMcpStep(s.connector, s.tool, s.args ?? {}, harness.connectors);
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
    return json({ execution: summarizeExecution(exec), completed: true });
  }

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
        let event: ActivityEvent = {
          id: newId("ev"),
          type: args.type ?? "manual",
          summary: args.summary,
          ...(args.detail ? { detail: args.detail.slice(0, 500) } : {}),
          ...(args.tool ? { tool: args.tool } : {}),
          ...(args.entities?.length ? { entities: args.entities } : {}),
          ...(args.sessionId ? { sessionId: args.sessionId } : {}),
          at: new Date().toISOString(),
        };
        event = enrichWithEntities(event);
        harness.store.appendActivity(event);
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
        const events = harness.store.listActivity(300);
        let suggestions = detectPatterns(events, min_count ?? 3);
        let method = "heuristic";
        const slm = resolveSlmFromEnv();
        if (slm && suggestions.length > 0) {
          suggestions = await refineSuggestions(slm, suggestions, events.slice(-40));
          method = `heuristic+${slm.name}`;
        }
        return json({
          count: suggestions.length,
          suggestions,
          method,
          guidance:
            suggestions.length === 0
              ? "Not enough recurring patterns yet — keep working and run workflow_suggest again after more activity is recorded."
              : `Approve a suggestion with workflow_approve { slug, name, description, steps } to create a runnable template.`,
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
            z.object({
              type: z.enum(["bash", "agent_prompt", "mcp_call", "human_review"]),
              summary: z.string().min(1),
              command: z.string().optional(),
              cwd: z.string().optional().describe("Working directory for bash steps (default: the server's cwd)."),
              prompt: z.string().optional(),
              connector: z.string().optional(),
              tool: z.string().optional(),
              args: z.record(z.unknown()).optional(),
              message: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ slug, name, description, steps }) => {
      try {
        const now = new Date().toISOString();
        const existing = harness.store.getTemplate(slug);
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
      },
    },
    async ({ slug, triggered_by }) => {
      try {
        const template = harness.store.getTemplate(slug);
        if (!template)
          return fail(new Error(`No template '${slug}'. Use workflow_template_list to see available templates.`));

        const now = new Date().toISOString();
        const execution: WorkflowExecution = {
          id: newId("exec"),
          templateId: template.id,
          templateSlug: template.slug,
          status: "running",
          steps: template.steps.map((s, i) => ({
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
