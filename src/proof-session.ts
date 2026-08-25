import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const SlugSchema = z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/);
const TimestampSchema = z.string().datetime();

export const WorkItemSchema = z.object({
  id: SlugSchema,
  title: z.string().min(1),
  detail: z.string().optional(),
  status: z.enum(["queued", "working", "blocked", "done"]),
  actorId: z.string().min(1),
  updatedAt: TimestampSchema,
});

export const DecisionOptionSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1),
  description: z.string().min(1),
  instruction: z.string().min(1),
  outcomeEffect: z.string().min(1).optional(),
  deepDive: z.string().min(1).optional(),
  tradeoffs: z.array(z.string().min(1)).optional(),
});

export const DecisionRequestSchema = z.object({
  id: SlugSchema,
  title: z.string().min(1),
  agentIntent: z.string().min(1),
  blocker: z.string().min(1),
  whyHuman: z.string().min(1),
  options: z.array(DecisionOptionSchema).min(1).max(5),
  recommendedOptionId: SlugSchema.optional(),
  noResponse: z.string().min(1),
  requestedBy: z.string().min(1),
  status: z.enum(["pending", "resolved"]),
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.optional(),
  resolvedBy: z.string().optional(),
  selectedOptionId: SlugSchema.optional(),
  resolutionNote: z.string().optional(),
}).superRefine((request, context) => {
  if (request.recommendedOptionId && !request.options.some((option) => option.id === request.recommendedOptionId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recommendedOptionId"], message: "must identify one of the decision options" });
  }
  if (request.selectedOptionId && !request.options.some((option) => option.id === request.selectedOptionId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedOptionId"], message: "must identify one of the decision options" });
  }
});

export const InstructionSchema = z.object({
  id: SlugSchema,
  text: z.string().min(1),
  targetActorId: z.string().optional(),
  sourceDecisionId: SlugSchema.optional(),
  status: z.enum(["queued", "acknowledged"]),
  createdBy: z.string().min(1),
  createdAt: TimestampSchema,
  acknowledgedAt: TimestampSchema.optional(),
  acknowledgedBy: z.string().optional(),
});

export const AgentPresenceSchema = z.object({
  actorId: z.string().min(1),
  name: z.string().min(1),
  harness: z.string().optional(),
  model: z.string().optional(),
  status: z.enum(["working", "waiting", "idle"]),
  currentWorkId: SlugSchema.optional(),
  lastSeenAt: TimestampSchema,
});

export const DirectionProposalSchema = z.object({
  id: SlugSchema,
  eyebrow: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().min(1),
  outcomeEffect: z.string().min(1),
  deepDive: z.string().min(1),
  basis: z.string().min(1),
  tradeoffs: z.array(z.string().min(1)).min(1).max(5),
  evidenceRefs: z.array(z.string().min(1)).max(10).default([]),
  instruction: z.string().min(1),
  proposedBy: z.string().min(1),
  createdAt: TimestampSchema,
});

const WorkEventSchema = z.object({ type: z.literal("work.reported"), at: TimestampSchema, item: WorkItemSchema });
const DecisionRequestedEventSchema = z.object({ type: z.literal("decision.requested"), at: TimestampSchema, request: DecisionRequestSchema });
const DecisionResolvedEventSchema = z.object({
  type: z.literal("decision.resolved"), at: TimestampSchema, decisionId: SlugSchema,
  selectedOptionId: SlugSchema.optional(), note: z.string().optional(), resolvedBy: z.string().min(1),
});
const InstructionQueuedEventSchema = z.object({ type: z.literal("instruction.queued"), at: TimestampSchema, instruction: InstructionSchema });
const InstructionAcknowledgedEventSchema = z.object({
  type: z.literal("instruction.acknowledged"), at: TimestampSchema, instructionId: SlugSchema, acknowledgedBy: z.string().min(1),
});
const PresenceEventSchema = z.object({ type: z.literal("agent.heartbeat"), at: TimestampSchema, presence: AgentPresenceSchema });
const DirectionProposedEventSchema = z.object({ type: z.literal("direction.proposed"), at: TimestampSchema, direction: DirectionProposalSchema });

export const ProofSessionEventSchema = z.discriminatedUnion("type", [
  WorkEventSchema,
  DecisionRequestedEventSchema,
  DecisionResolvedEventSchema,
  InstructionQueuedEventSchema,
  InstructionAcknowledgedEventSchema,
  PresenceEventSchema,
  DirectionProposedEventSchema,
]);

export type WorkItem = z.infer<typeof WorkItemSchema>;
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;
export type Instruction = z.infer<typeof InstructionSchema>;
export type AgentPresence = z.infer<typeof AgentPresenceSchema>;
export type DirectionProposal = z.infer<typeof DirectionProposalSchema>;
export type ProofSessionEvent = z.infer<typeof ProofSessionEventSchema>;

export interface ProofSessionState {
  work: WorkItem[];
  decisions: DecisionRequest[];
  instructions: Instruction[];
  agents: Array<AgentPresence & { connected: boolean }>;
  directions: DirectionProposal[];
  eventCount: number;
  updatedAt?: string;
}

function now(): string { return new Date().toISOString(); }
function slug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "") || "item";
}
function eventsPath(root: string, contributionId: string): string {
  return join(root, ".keyoku", "contributions", slug(contributionId), "events.jsonl");
}
function appendEvent(root: string, contributionId: string, event: ProofSessionEvent): ProofSessionEvent {
  const parsed = ProofSessionEventSchema.parse(event);
  const path = eventsPath(root, contributionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
  return parsed;
}

export function readProofSessionEvents(root: string, contributionId: string): ProofSessionEvent[] {
  const path = eventsPath(root, contributionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line, index) => {
    try { return ProofSessionEventSchema.parse(JSON.parse(line)); }
    catch (error) { throw new Error(`Invalid proof session event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

export function readProofSession(root: string, contributionId: string, at = Date.now()): ProofSessionState {
  const events = readProofSessionEvents(root, contributionId);
  const work = new Map<string, WorkItem>();
  const decisions = new Map<string, DecisionRequest>();
  const instructions = new Map<string, Instruction>();
  const agents = new Map<string, AgentPresence>();
  const directions = new Map<string, DirectionProposal>();
  for (const event of events) {
    if (event.type === "work.reported") work.set(event.item.id, event.item);
    if (event.type === "decision.requested") decisions.set(event.request.id, event.request);
    if (event.type === "decision.resolved") {
      const request = decisions.get(event.decisionId);
      if (request) decisions.set(event.decisionId, DecisionRequestSchema.parse({ ...request, status: "resolved", resolvedAt: event.at, resolvedBy: event.resolvedBy, ...(event.selectedOptionId ? { selectedOptionId: event.selectedOptionId } : {}), ...(event.note ? { resolutionNote: event.note } : {}) }));
    }
    if (event.type === "instruction.queued") instructions.set(event.instruction.id, event.instruction);
    if (event.type === "instruction.acknowledged") {
      const instruction = instructions.get(event.instructionId);
      if (instruction) instructions.set(event.instructionId, InstructionSchema.parse({ ...instruction, status: "acknowledged", acknowledgedAt: event.at, acknowledgedBy: event.acknowledgedBy }));
    }
    if (event.type === "agent.heartbeat") agents.set(event.presence.actorId, event.presence);
    if (event.type === "direction.proposed") directions.set(event.direction.id, event.direction);
  }
  const byRecent = <T extends { updatedAt?: string; createdAt?: string }>(a: T, b: T) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt));
  return {
    work: [...work.values()].sort(byRecent),
    decisions: [...decisions.values()].sort(byRecent),
    instructions: [...instructions.values()].sort(byRecent),
    agents: [...agents.values()].map((agent) => ({ ...agent, connected: at - Date.parse(agent.lastSeenAt) <= 45_000 })).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
    directions: [...directions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    eventCount: events.length,
    ...(events.at(-1)?.at ? { updatedAt: events.at(-1)!.at } : {}),
  };
}

export function reportWork(root: string, contributionId: string, input: Omit<WorkItem, "updatedAt">): WorkItem {
  const item = WorkItemSchema.parse({ ...input, id: slug(input.id), updatedAt: now() });
  appendEvent(root, contributionId, { type: "work.reported", at: item.updatedAt, item });
  return item;
}

export function requestDecision(root: string, contributionId: string, input: Omit<DecisionRequest, "id" | "status" | "createdAt"> & { id?: string }): DecisionRequest {
  const createdAt = now();
  const request = DecisionRequestSchema.parse({ ...input, id: slug(input.id ?? `decision-${randomUUID().slice(0, 8)}`), status: "pending", createdAt });
  appendEvent(root, contributionId, { type: "decision.requested", at: createdAt, request });
  return request;
}

export function queueInstruction(root: string, contributionId: string, input: Omit<Instruction, "id" | "status" | "createdAt"> & { id?: string }): Instruction {
  const createdAt = now();
  const instruction = InstructionSchema.parse({ ...input, id: slug(input.id ?? `instruction-${randomUUID().slice(0, 8)}`), status: "queued", createdAt });
  appendEvent(root, contributionId, { type: "instruction.queued", at: createdAt, instruction });
  return instruction;
}

export function resolveDecision(root: string, contributionId: string, input: { decisionId: string; selectedOptionId?: string; note?: string; resolvedBy: string }): { decision: DecisionRequest; instruction: Instruction } {
  const current = readProofSession(root, contributionId).decisions.find((decision) => decision.id === input.decisionId);
  if (!current) throw new Error(`Unknown decision '${input.decisionId}'.`);
  if (current.status === "resolved") throw new Error(`Decision '${input.decisionId}' is already resolved.`);
  const option = input.selectedOptionId ? current.options.find((candidate) => candidate.id === input.selectedOptionId) : undefined;
  if (input.selectedOptionId && !option) throw new Error(`Unknown option '${input.selectedOptionId}' for decision '${input.decisionId}'.`);
  const note = input.note?.trim();
  if (!option && !note) throw new Error("Choose a decision option or provide a change request.");
  const at = now();
  appendEvent(root, contributionId, { type: "decision.resolved", at, decisionId: current.id, ...(option ? { selectedOptionId: option.id } : {}), ...(note ? { note } : {}), resolvedBy: input.resolvedBy });
  const instruction = queueInstruction(root, contributionId, {
    text: option?.instruction ?? note!, sourceDecisionId: current.id, createdBy: input.resolvedBy,
  });
  return { decision: readProofSession(root, contributionId).decisions.find((decision) => decision.id === current.id)!, instruction };
}

export function nextInstruction(root: string, contributionId: string, actorId?: string): Instruction | undefined {
  return readProofSession(root, contributionId).instructions
    .filter((instruction) => instruction.status === "queued" && (!instruction.targetActorId || instruction.targetActorId === actorId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

export function acknowledgeInstruction(root: string, contributionId: string, instructionId: string, acknowledgedBy: string): Instruction {
  const instruction = readProofSession(root, contributionId).instructions.find((candidate) => candidate.id === instructionId);
  if (!instruction) throw new Error(`Unknown instruction '${instructionId}'.`);
  if (instruction.status === "acknowledged") return instruction;
  appendEvent(root, contributionId, { type: "instruction.acknowledged", at: now(), instructionId, acknowledgedBy });
  return readProofSession(root, contributionId).instructions.find((candidate) => candidate.id === instructionId)!;
}

export function heartbeatAgent(root: string, contributionId: string, input: Omit<AgentPresence, "lastSeenAt">): AgentPresence {
  const presence = AgentPresenceSchema.parse({ ...input, lastSeenAt: now() });
  appendEvent(root, contributionId, { type: "agent.heartbeat", at: presence.lastSeenAt, presence });
  return presence;
}

export function proposeDirection(root: string, contributionId: string, input: Omit<DirectionProposal, "createdAt">): DirectionProposal {
  const direction = DirectionProposalSchema.parse({ ...input, id: slug(input.id), createdAt: now() });
  appendEvent(root, contributionId, { type: "direction.proposed", at: direction.createdAt, direction });
  return direction;
}
