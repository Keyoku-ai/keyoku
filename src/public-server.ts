import { readFileSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { appendWorkEvent, evaluateEvidence, readWorkEvents } from "./assurance-adapter.js";
import { findProjectRoot, runGate } from "./contribution.js";
import {
  DecisionOptionSchema,
  acknowledgeInstruction,
  heartbeatAgent,
  nextInstruction,
  readProofSession,
  reportWork,
  requestDecision,
} from "./proof-session.js";
import {
  appendPulseAdapterEvent,
  appendPulseEvent,
  planPulseDispatch,
  readPulseEvents,
  renderPulseProjection,
  replayPulseEvents,
  sealPulseEvent,
  trustedLocalCheckpointDigests,
  verifyAndSealLocalCheckpoint,
} from "./pulse.js";
import { PUBLIC_MCP_SURFACE, type PublicMcpTool } from "./public-surface.js";

export const VERSION: string = (() => {
  try {
    // package.json is copied next to dist/ in the npm tarball.
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

function fail(error: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
    isError: true,
  };
}

type PublicToolDefinition = {
  title: string;
  description: string;
  schema: z.AnyZodObject;
  run(input: unknown): Promise<ToolResult>;
};

const reportWorkSchema = z.object({
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
}).strict();

const requestDecisionSchema = z.object({
  contribution: z.string().min(1),
  id: z.string().optional(),
  title: z.string().min(1),
  agentIntent: z.string().min(1),
  blocker: z.string().min(1),
  whyHuman: z.string().min(1),
  options: z.array(DecisionOptionSchema).min(1).max(5),
  recommendedOptionId: z.string().optional(),
  noResponse: z.string().min(1),
  requestedBy: z.string().min(1),
  cwd: z.string().optional(),
}).strict();

const nextInstructionSchema = z.object({
  contribution: z.string().min(1),
  actorId: z.string().min(1),
  actorName: z.string().min(1),
  harness: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
}).strict();

const acknowledgeInstructionSchema = z.object({
  contribution: z.string().min(1),
  instruction: z.string().min(1),
  actorId: z.string().min(1),
  cwd: z.string().optional(),
}).strict();

const gateSchema = z.object({
  contribution: z.string().min(1),
  cwd: z.string().optional(),
}).strict();

const evidenceEvaluateSchema = z.object({ envelope: z.record(z.unknown()) }).strict();

const pulseEventSchema = z.object({
  event: z.record(z.unknown()),
  cwd: z.string().optional(),
}).strict();

const pulseCheckpointSchema = z.object({
  eventId: z.string().min(1),
  checkpoint: z.record(z.unknown()),
  cwd: z.string().optional(),
}).strict();

const pulseWorkEventSchema = z.object({
  event: z.record(z.unknown()),
  cwd: z.string().optional(),
}).strict();

const pulseStatusSchema = z.object({ cwd: z.string().optional() }).strict();

const pulsePlanSchema = z.object({
  now: z.string().datetime().optional(),
  staleAfterMs: z.number().int().nonnegative().optional(),
  debounceMs: z.number().int().nonnegative().optional(),
  deliveredContentDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  cwd: z.string().optional(),
}).strict();

const pulseRenderSchema = pulsePlanSchema.extend({
  audience: z.enum(["stakeholder", "developer", "timeline", "email", "text", "json"]),
}).strict();

const PUBLIC_TOOL_DEFINITIONS: Record<PublicMcpTool, PublicToolDefinition> = {
  contribution_report_work: {
    title: "Report proof-session work",
    description: "Upsert task status for coordination. Reported activity is never treated as proof of completion.",
    schema: reportWorkSchema,
    async run(input) {
      try {
        const { contribution, id, title, detail, status, actorId, actorName, harness, model, cwd } = reportWorkSchema.parse(input);
        const root = findProjectRoot(cwd);
        const item = reportWork(root, contribution, { id, title, ...(detail ? { detail } : {}), status, actorId });
        heartbeatAgent(root, contribution, {
          actorId,
          name: actorName,
          ...(harness ? { harness } : {}),
          ...(model ? { model } : {}),
          status: status === "working" ? "working" : status === "blocked" ? "waiting" : "idle",
          currentWorkId: item.id,
        });
        return json({ item, session: readProofSession(root, contribution), guidance: "Coordination updated. Completion still requires contribution_gate." });
      } catch (error) { return fail(error); }
    },
  },
  contribution_request_decision: {
    title: "Request human judgment",
    description: "Create a bounded human-decision request. This tool cannot resolve or approve the request.",
    schema: requestDecisionSchema,
    async run(input) {
      try {
        const { contribution, id, title, agentIntent, blocker, whyHuman, options, recommendedOptionId, noResponse, requestedBy, cwd } = requestDecisionSchema.parse(input);
        const root = findProjectRoot(cwd);
        const request = requestDecision(root, contribution, { ...(id ? { id } : {}), title, agentIntent, blocker, whyHuman, options, ...(recommendedOptionId ? { recommendedOptionId } : {}), noResponse, requestedBy });
        return json({ request, guidance: "Pause only dependent work; a human must decide through the local proof session." });
      } catch (error) { return fail(error); }
    },
  },
  contribution_next_instruction: {
    title: "Read the next human instruction",
    description: "Read the oldest queued instruction for this agent and refresh its proof-session presence.",
    schema: nextInstructionSchema,
    async run(input) {
      try {
        const { contribution, actorId, actorName, harness, model, cwd } = nextInstructionSchema.parse(input);
        const root = findProjectRoot(cwd);
        heartbeatAgent(root, contribution, { actorId, name: actorName, ...(harness ? { harness } : {}), ...(model ? { model } : {}), status: "waiting" });
        const instruction = nextInstruction(root, contribution, actorId);
        return json({ instruction: instruction ?? null, guidance: instruction ? "Acknowledge after incorporating it." : "No human instruction is queued." });
      } catch (error) { return fail(error); }
    },
  },
  contribution_ack_instruction: {
    title: "Acknowledge a human instruction",
    description: "Record that one durable instruction entered the agent's working context.",
    schema: acknowledgeInstructionSchema,
    async run(input) {
      try {
        const { contribution, instruction, actorId, cwd } = acknowledgeInstructionSchema.parse(input);
        const root = findProjectRoot(cwd);
        return json({ instruction: acknowledgeInstruction(root, contribution, instruction, actorId) });
      } catch (error) { return fail(error); }
    },
  },
  contribution_gate: {
    title: "Evaluate and render exact-source proof",
    description: "Run repository-declared probes and render a Factfile. This executes commands declared by the repository; inspect unfamiliar outcome files first.",
    schema: gateSchema,
    async run(input) {
      try {
        const { contribution, cwd } = gateSchema.parse(input);
        const root = findProjectRoot(cwd);
        const snapshot = await runGate(root, contribution);
        return json({
          snapshot,
          factfile: join(root, ".keyoku", "contributions", contribution, "factfile.html"),
          guidance: snapshot.state === "ready_for_review"
            ? "Declared checks passed for this exact source. A human may review it through the CLI or local session."
            : "Evidence or human judgment remains incomplete; do not report completion.",
        });
      } catch (error) { return fail(error); }
    },
  },
  evidence_evaluate: {
    title: "Evaluate neutral evidence",
    description: "Return a deterministic assurance result. This tool runs no commands, mutates no caller state, and grants no human approval.",
    schema: evidenceEvaluateSchema,
    async run(input) {
      try {
        const { envelope } = evidenceEvaluateSchema.parse(input);
        return json({ assessment: evaluateEvidence(envelope) });
      } catch (error) { return fail(error); }
    },
  },
  pulse_event_ingest: {
    title: "Ingest one Pulse lifecycle event",
    description: "Validate and append one content-digested event. Activity remains coordination, never proof.",
    schema: pulseEventSchema,
    async run(input) {
      try {
        const { event, cwd } = pulseEventSchema.parse(input);
        return json(appendPulseAdapterEvent(findProjectRoot(cwd), event));
      } catch (error) { return fail(error); }
    },
  },
  pulse_checkpoint_publish: {
    title: "Publish a verified Pulse checkpoint",
    description: "Recompute local Factfile and source digests before appending checkpoint_published.",
    schema: pulseCheckpointSchema,
    async run(input) {
      try {
        const { eventId, checkpoint: draft, cwd } = pulseCheckpointSchema.parse(input);
        const root = findProjectRoot(cwd);
        const checkpoint = verifyAndSealLocalCheckpoint(root, draft as Parameters<typeof verifyAndSealLocalCheckpoint>[1]);
        const event = sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: eventId, type: "checkpoint_published", at: checkpoint.publishedAt, leaseId: checkpoint.leaseIds[0], checkpoint });
        return json(appendPulseEvent(root, event));
      } catch (error) { return fail(error); }
    },
  },
  pulse_work_event_ingest: {
    title: "Ingest one neutral WorkEvent",
    description: "Append one validated WorkEvent to the local Pulse adapter ledger. It does not establish a verified checkpoint.",
    schema: pulseWorkEventSchema,
    async run(input) {
      try {
        const { event, cwd } = pulseWorkEventSchema.parse(input);
        return json(appendWorkEvent(findProjectRoot(cwd), event));
      } catch (error) { return fail(error); }
    },
  },
  pulse_work_event_list: {
    title: "Read neutral WorkEvents",
    description: "Read the validated local WorkEvent adapter ledger without changing it.",
    schema: pulseStatusSchema,
    async run(input) {
      try {
        const { cwd } = pulseStatusSchema.parse(input);
        const root = findProjectRoot(cwd);
        return json({ root, events: readWorkEvents(root) });
      } catch (error) { return fail(error); }
    },
  },
  pulse_status: {
    title: "Read Pulse state",
    description: "Replay the append-only Pulse ledger into deterministic lease state while preserving each checkpoint's verified or attested classification.",
    schema: pulseStatusSchema,
    async run(input) {
      try {
        const { cwd } = pulseStatusSchema.parse(input);
        const root = findProjectRoot(cwd);
        return json({ root, state: replayPulseEvents(readPulseEvents(root)) });
      } catch (error) { return fail(error); }
    },
  },
  pulse_dispatch_plan: {
    title: "Plan Pulse dispatch",
    description: "Return a deterministic send/defer/deduplicate/suppress/coalesce/stale_no_send decision without contacting any channel.",
    schema: pulsePlanSchema,
    async run(input) {
      try {
        const { cwd, ...options } = pulsePlanSchema.parse(input);
        const root = findProjectRoot(cwd);
        const events = readPulseEvents(root);
        return json({ root, decision: planPulseDispatch({ events, trustedCheckpointDigests: trustedLocalCheckpointDigests(root, events), ...options }) });
      } catch (error) { return fail(error); }
    },
  },
  pulse_projection_render: {
    title: "Render a Pulse audience projection",
    description: "Render one content-bound audience view after deterministic planning. This tool never sends it.",
    schema: pulseRenderSchema,
    async run(input) {
      try {
        const { audience, cwd, ...options } = pulseRenderSchema.parse(input);
        const root = findProjectRoot(cwd);
        const events = readPulseEvents(root);
        const decision = planPulseDispatch({ events, trustedCheckpointDigests: trustedLocalCheckpointDigests(root, events), ...options });
        if (!decision.snapshot || !["send", "coalesce"].includes(decision.outcome)) throw new Error(`Projection refused dispatcher outcome '${decision.outcome}' (${decision.reasonCode}).`);
        return json({ root, decision, audience, output: renderPulseProjection(decision.snapshot, audience) });
      } catch (error) { return fail(error); }
    },
  },
};

export function buildPublicServer(): McpServer {
  const server = new McpServer(
    { name: "keyoku", version: VERSION },
    {
      instructions:
        "Keyoku verifies repository-owned outcomes and plans trusted progress. Report work as coordination, run contribution_gate for proof, and never claim human review or delivery. Human acceptance is intentionally unavailable over MCP.",
    },
  );

  for (const item of PUBLIC_MCP_SURFACE) {
    const definition = PUBLIC_TOOL_DEFINITIONS[item.name];
    server.registerTool(
      item.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.schema.shape,
      },
      async (input: Record<string, unknown>) => definition.run(input),
    );
  }

  return server;
}
