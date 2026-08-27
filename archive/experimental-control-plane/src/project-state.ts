import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { listOutcomes, loadProject } from "./contribution.js";

export type SteeringStatus = "queued" | "acknowledged" | "applied" | "superseded" | "could_not_apply";

export type InterventionKind = "query" | "direction" | "decision_response" | "control" | "proof_challenge";
export type InterventionPhase =
  | "committed"
  | "delivered"
  | "understood"
  | "planned"
  | "applied"
  | "verified"
  | "declined"
  | "expired"
  | "superseded"
  | "could_not_apply"
  | "cancelled";
export type DeliveryPolicy = "when_available" | "next_checkpoint" | "interrupt_now";
export type AgentSessionStatus = "idle" | "working" | "waiting" | "blocked" | "disconnected";

export interface ProtocolActor {
  kind: "human" | "agent" | "system";
  id: string;
  name: string;
  harness?: string;
  model?: string;
}

export interface InterventionReceipt {
  eventType: "intervention.receipt";
  eventId: string;
  interventionId: string;
  phase: Exclude<InterventionPhase, "committed">;
  summary: string;
  actor: ProtocolActor;
  createdAt: string;
  evidenceRefs?: string[];
}

export interface Intervention {
  schemaVersion: "keyoku.dev/intervention/v1alpha1";
  eventType: "intervention.created";
  eventId: string;
  id: string;
  projectId: string;
  threadId: string;
  correlationId: string;
  causationId?: string;
  kind: InterventionKind;
  message: string;
  actor: ProtocolActor;
  target: { mode: "current" | "session" | "all"; sessionId?: string };
  scope: { outcomeId?: string; contributionId?: string; snapshotRef: string };
  delivery: { policy: DeliveryPolicy; require: Array<"understood" | "applied" | "verified"> };
  createdAt: string;
  expiresAt?: string;
  idempotencyKey: string;
  phase: InterventionPhase;
  receipts: InterventionReceipt[];
}

export interface AgentSession {
  schemaVersion: "keyoku.dev/agent-session/v1alpha1";
  eventType: "agent.heartbeat";
  eventId: string;
  sessionId: string;
  actor: ProtocolActor;
  status: AgentSessionStatus;
  currentWork?: {
    outcomeId?: string;
    contributionId?: string;
    summary: string;
    capabilityIds?: string[];
    paths?: string[];
    baseSnapshot?: string;
  };
  capabilities: string[];
  transport: string;
  createdAt: string;
  leaseUntil: string;
  active: boolean;
}

export interface AgentCoordinationConflict {
  sessions: [string, string];
  reason: "same_contribution" | "overlapping_path";
  scope: string;
}

export interface SteeringRequest {
  id: string;
  kind: string;
  message: string;
  actor?: { kind?: string; name?: string };
  createdAt: string;
  status: SteeringStatus;
  acknowledgement?: {
    summary: string;
    actor: string;
    createdAt: string;
  };
}

interface SteeringAcknowledgement {
  eventType: "acknowledgement";
  steeringId: string;
  status: Exclude<SteeringStatus, "queued">;
  summary: string;
  actor: string;
  createdAt: string;
}

function jsonLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as unknown]; } catch { return []; }
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function steeringPath(root: string): string {
  return join(root, ".keyoku", "runtime", "human-steering.jsonl");
}

function protocolPath(root: string): string {
  return join(root, ".keyoku", "runtime", "thread-events.jsonl");
}

function sessionPath(root: string): string {
  return join(root, ".keyoku", "runtime", "agent-sessions.jsonl");
}

function eventId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}`;
}

function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function decisionsPath(root: string): string {
  return join(root, ".keyoku", "runtime", "human-decisions.jsonl");
}

function goalFocusPath(root: string): string {
  return join(root, ".keyoku", "runtime", "goal-focus.jsonl");
}

export function focusedProjectGoalId(root: string): string | undefined {
  const events = jsonLines(goalFocusPath(root)).filter(isRecord);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.eventType === "goal.focused" && typeof event.goalId === "string") return event.goalId;
  }
  return undefined;
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

export function listSteering(root: string): SteeringRequest[] {
  const requests = new Map<string, SteeringRequest>();
  const acknowledgements: SteeringAcknowledgement[] = [];

  for (const value of jsonLines(steeringPath(root))) {
    if (!isRecord(value)) continue;
    if (value.eventType === "acknowledgement") {
      if (
        typeof value.steeringId === "string" &&
        typeof value.status === "string" &&
        typeof value.summary === "string" &&
        typeof value.actor === "string" &&
        typeof value.createdAt === "string"
      ) acknowledgements.push(value as unknown as SteeringAcknowledgement);
      continue;
    }
    if (typeof value.id !== "string" || typeof value.message !== "string" || typeof value.createdAt !== "string") continue;
    requests.set(value.id, {
      id: value.id,
      kind: typeof value.kind === "string" ? value.kind : "direction",
      message: value.message,
      actor: isRecord(value.actor) ? {
        kind: typeof value.actor.kind === "string" ? value.actor.kind : undefined,
        name: typeof value.actor.name === "string" ? value.actor.name : undefined,
      } : undefined,
      createdAt: value.createdAt,
      status: value.status === "acknowledged" || value.status === "applied" || value.status === "superseded" || value.status === "could_not_apply"
        ? value.status
        : "queued",
    });
  }

  for (const acknowledgement of acknowledgements) {
    const request = requests.get(acknowledgement.steeringId);
    if (!request) continue;
    request.status = acknowledgement.status;
    request.acknowledgement = {
      summary: acknowledgement.summary,
      actor: acknowledgement.actor,
      createdAt: acknowledgement.createdAt,
    };
  }

  return [...requests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function acknowledgeSteering(input: {
  root: string;
  steeringId: string;
  status: Exclude<SteeringStatus, "queued">;
  summary: string;
  actor: string;
}): SteeringRequest {
  const request = listSteering(input.root).find((item) => item.id === input.steeringId);
  if (!request) throw new Error(`Unknown steering request '${input.steeringId}'.`);
  const event: SteeringAcknowledgement = {
    eventType: "acknowledgement",
    steeringId: input.steeringId,
    status: input.status,
    summary: input.summary.trim(),
    actor: input.actor.trim(),
    createdAt: new Date().toISOString(),
  };
  if (!event.summary || !event.actor) throw new Error("summary and actor are required");
  const path = steeringPath(input.root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  return listSteering(input.root).find((item) => item.id === input.steeringId)!;
}

export function createIntervention(input: {
  root: string;
  kind: InterventionKind;
  message: string;
  actor: ProtocolActor;
  target?: Intervention["target"];
  outcomeId?: string;
  contributionId?: string;
  deliveryPolicy?: DeliveryPolicy;
  require?: Intervention["delivery"]["require"];
  threadId?: string;
  causationId?: string;
  idempotencyKey?: string;
  expiresAt?: string;
}): Intervention {
  const message = input.message.trim();
  if (!message) throw new Error("message is required");
  const existing = input.idempotencyKey
    ? listInterventions(input.root).find((item) => item.idempotencyKey === input.idempotencyKey)
    : undefined;
  if (existing) return existing;
  const id = eventId("int");
  const intervention: Intervention = {
    schemaVersion: "keyoku.dev/intervention/v1alpha1",
    eventType: "intervention.created",
    eventId: eventId("evt"),
    id,
    projectId: loadProject(input.root).id,
    threadId: input.threadId || "project",
    correlationId: id,
    ...(input.causationId ? { causationId: input.causationId } : {}),
    kind: input.kind,
    message,
    actor: input.actor,
    target: input.target || { mode: "current" },
    scope: {
      ...(input.outcomeId ? { outcomeId: input.outcomeId } : {}),
      ...(input.contributionId ? { contributionId: input.contributionId } : {}),
      snapshotRef: git(input.root, ["rev-parse", "HEAD"]),
    },
    delivery: {
      policy: input.deliveryPolicy || "next_checkpoint",
      require: input.require || ["understood", "applied"],
    },
    createdAt: new Date().toISOString(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    idempotencyKey: input.idempotencyKey || eventId("idem"),
    phase: "committed",
    receipts: [],
  };
  appendJsonLine(protocolPath(input.root), intervention);
  return intervention;
}

export function recordInterventionReceipt(input: {
  root: string;
  interventionId: string;
  phase: Exclude<InterventionPhase, "committed">;
  summary: string;
  actor: ProtocolActor;
  evidenceRefs?: string[];
}): Intervention {
  const intervention = listInterventions(input.root).find((item) => item.id === input.interventionId);
  if (!intervention) throw new Error(`Unknown intervention '${input.interventionId}'.`);
  const receipt: InterventionReceipt = {
    eventType: "intervention.receipt",
    eventId: eventId("evt"),
    interventionId: input.interventionId,
    phase: input.phase,
    summary: input.summary.trim(),
    actor: input.actor,
    createdAt: new Date().toISOString(),
    ...(input.evidenceRefs?.length ? { evidenceRefs: input.evidenceRefs } : {}),
  };
  if (!receipt.summary) throw new Error("summary is required");
  appendJsonLine(protocolPath(input.root), receipt);
  return listInterventions(input.root).find((item) => item.id === input.interventionId)!;
}

export function listInterventions(root: string): Intervention[] {
  const interventions = new Map<string, Intervention>();
  const receipts: InterventionReceipt[] = [];
  for (const value of jsonLines(protocolPath(root))) {
    if (!isRecord(value)) continue;
    if (value.eventType === "intervention.receipt" && typeof value.interventionId === "string") {
      receipts.push(value as unknown as InterventionReceipt);
    } else if (value.eventType === "intervention.created" && typeof value.id === "string") {
      interventions.set(value.id, { ...(value as unknown as Intervention), phase: "committed", receipts: [] });
    }
  }
  for (const receipt of receipts) {
    const intervention = interventions.get(receipt.interventionId);
    if (!intervention) continue;
    intervention.receipts.push(receipt);
    intervention.phase = receipt.phase;
  }
  return [...interventions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function heartbeatAgentSession(input: {
  root: string;
  sessionId: string;
  actor: ProtocolActor;
  status: AgentSessionStatus;
  currentWork?: AgentSession["currentWork"];
  capabilities?: string[];
  transport: string;
  leaseSeconds?: number;
}): AgentSession {
  const leaseSeconds = Math.max(15, Math.min(input.leaseSeconds || 45, 300));
  const now = new Date();
  const session: AgentSession = {
    schemaVersion: "keyoku.dev/agent-session/v1alpha1",
    eventType: "agent.heartbeat",
    eventId: eventId("evt"),
    sessionId: input.sessionId.trim(),
    actor: input.actor,
    status: input.status,
    ...(input.currentWork ? { currentWork: input.currentWork } : {}),
    capabilities: [...new Set(input.capabilities || [])],
    transport: input.transport.trim(),
    createdAt: now.toISOString(),
    leaseUntil: new Date(now.getTime() + leaseSeconds * 1_000).toISOString(),
    active: input.status !== "disconnected",
  };
  if (!session.sessionId || !session.transport) throw new Error("sessionId and transport are required");
  appendJsonLine(sessionPath(input.root), session);
  return session;
}

export function listAgentSessions(root: string, now = new Date()): AgentSession[] {
  const sessions = new Map<string, AgentSession>();
  for (const value of jsonLines(sessionPath(root))) {
    if (!isRecord(value) || value.eventType !== "agent.heartbeat" || typeof value.sessionId !== "string") continue;
    sessions.set(value.sessionId, value as unknown as AgentSession);
  }
  return [...sessions.values()]
    .map((session) => ({
      ...session,
      active: session.status !== "disconnected" && new Date(session.leaseUntil).getTime() > now.getTime(),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findAgentCoordinationConflicts(sessions: AgentSession[]): AgentCoordinationConflict[] {
  const active = sessions.filter((session) => session.active && session.currentWork);
  const conflicts: AgentCoordinationConflict[] = [];
  const pathOverlaps = (left: string, right: string) => {
    const a = left.replace(/^\.\//, "").replace(/\/$/, "");
    const b = right.replace(/^\.\//, "").replace(/\/$/, "");
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  };
  for (let left = 0; left < active.length; left += 1) {
    for (let right = left + 1; right < active.length; right += 1) {
      const a = active[left]!;
      const b = active[right]!;
      if (a.currentWork?.contributionId && a.currentWork.contributionId === b.currentWork?.contributionId) {
        conflicts.push({ sessions: [a.sessionId, b.sessionId], reason: "same_contribution", scope: a.currentWork.contributionId });
      }
      for (const aPath of a.currentWork?.paths || []) {
        for (const bPath of b.currentWork?.paths || []) {
          if (pathOverlaps(aPath, bPath)) conflicts.push({ sessions: [a.sessionId, b.sessionId], reason: "overlapping_path", scope: aPath.length <= bPath.length ? aPath : bPath });
        }
      }
    }
  }
  return conflicts;
}

export function buildProjectOrientation(root: string) {
  const project = loadProject(root);
  const outcomes = listOutcomes(root);
  const decisions = jsonLines(decisionsPath(root)).filter(isRecord);
  const latestDecisions = new Map<string, Record<string, unknown>>();
  for (const decision of decisions) {
    if (typeof decision.decisionId === "string") latestDecisions.set(decision.decisionId, decision);
  }
  const steering = listSteering(root);
  const pendingSteering = steering.filter((item) => item.status === "queued");
  const interventions = listInterventions(root);
  const pendingInterventions = interventions.filter((item) => !["applied", "verified", "declined", "expired", "superseded", "could_not_apply", "cancelled"].includes(item.phase));
  const agentSessions = listAgentSessions(root);
  const agentConflicts = findAgentCoordinationConflicts(agentSessions);
  const status = git(root, ["status", "--porcelain=v1"], "");
  const changedFiles = status ? status.split("\n").filter(Boolean) : [];
  const focusedGoalId = focusedProjectGoalId(root);
  const currentOutcome = outcomes.find((outcome) => outcome.id === focusedGoalId) || [...outcomes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

  return {
    schemaVersion: "keyoku.dev/project-orientation/v1alpha1",
    project: {
      id: project.id,
      name: project.name,
      summary: project.summary,
    },
    snapshot: {
      branch: git(root, ["branch", "--show-current"], "detached"),
      head: git(root, ["rev-parse", "--short=12", "HEAD"]),
      changedFiles: changedFiles.length,
      exact: changedFiles.length === 0,
    },
    currentGoal: currentOutcome ? {
      id: currentOutcome.id,
      title: currentOutcome.title,
      objective: currentOutcome.objective,
      owner: currentOutcome.owner,
    } : null,
    goals: {
      focusedId: currentOutcome?.id || null,
      active: outcomes.map((outcome) => ({ id: outcome.id, title: outcome.title, objective: outcome.objective, owner: outcome.owner, updatedAt: outcome.updatedAt })),
      count: outcomes.length,
    },
    humanAttention: {
      pendingSteering,
      pendingInterventions,
      count: pendingSteering.length + pendingInterventions.length,
      rule: "Interrupt a person only for a consequential, non-inferable, time-sensitive choice. Otherwise continue safely or include it in the next checkpoint.",
    },
    decisions: [...latestDecisions.values()],
    agents: {
      active: agentSessions.filter((session) => session.active),
      recent: agentSessions,
      coordinationConflicts: agentConflicts,
      rule: "A session is active only while its signed heartbeat lease is valid; repository activity alone is not presence.",
    },
    instructions: [
      "Use this compact orientation before substantial work; retrieve detailed outcomes or contributions only when needed.",
      "Treat human decisions as constraints and distinguish observed evidence from agent proposals.",
      "If steering is queued, acknowledge it before claiming it changed the work.",
      "Checkpoint at a meaningful outcome boundary; do not dump raw transcripts into project state.",
    ],
  };
}
