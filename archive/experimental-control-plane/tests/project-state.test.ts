import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acknowledgeSteering,
  buildProjectOrientation,
  createIntervention,
  findAgentCoordinationConflicts,
  heartbeatAgentSession,
  listAgentSessions,
  listInterventions,
  listSteering,
  recordInterventionReceipt,
} from "../src/project-state.js";

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keyoku-project-state-"));
  roots.push(root);
  mkdirSync(join(root, ".keyoku", "outcomes"), { recursive: true });
  mkdirSync(join(root, ".keyoku", "runtime"), { recursive: true });
  writeFileSync(join(root, ".keyoku", "project.yaml"), `schemaVersion: keyoku.dev/project/v1alpha1
id: demo
name: Demo
summary: A test project
createdAt: 2026-08-11T00:00:00.000Z
updatedAt: 2026-08-11T00:00:00.000Z
`);
  writeFileSync(join(root, ".keyoku", "outcomes", "current.yaml"), `schemaVersion: keyoku.dev/outcome/v1alpha1
id: current
revision: 1
title: Make the project understandable
objective: A person can understand the current work
owner:
  kind: human
  id: owner
  name: Owner
constraints: []
criteria:
  - description: A file exists
    probe:
      kind: command
      run: test -f README.md
    assert:
      path: exitCode
      op: eq
      value: 0
humanCriteria: []
createdAt: 2026-08-11T00:00:00.000Z
updatedAt: 2026-08-11T00:00:00.000Z
`);
  writeFileSync(join(root, ".keyoku", "runtime", "human-steering.jsonl"), `${JSON.stringify({
    id: "steer_1",
    kind: "direction",
    message: "Prioritize the mobile view",
    actor: { kind: "human", name: "Owner" },
    createdAt: "2026-08-11T01:00:00.000Z",
    status: "queued",
  })}\n`);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project state", () => {
  it("presents compact orientation with queued human steering", () => {
    const root = projectRoot();
    const orientation = buildProjectOrientation(root);
    expect(orientation.project.name).toBe("Demo");
    expect(orientation.currentGoal?.title).toBe("Make the project understandable");
    expect(orientation.humanAttention.count).toBe(1);
    expect(orientation.humanAttention.pendingSteering[0]?.message).toBe("Prioritize the mobile view");
  });

  it("keeps multiple goals active while focusing one independently of agent assignment", () => {
    const root = projectRoot();
    writeFileSync(join(root, ".keyoku", "outcomes", "parallel.yaml"), `schemaVersion: keyoku.dev/outcome/v1alpha1
id: parallel
revision: 1
title: Ship a parallel outcome
objective: Complete work without replacing the other goal
owner: { kind: human, id: owner, name: Owner }
constraints: []
criteria:
  - description: A parallel result exists
    probe: { kind: command, run: "true" }
    assert: { path: exitCode, op: eq, value: 0 }
humanCriteria: []
createdAt: 2026-08-11T00:00:00.000Z
updatedAt: 2026-08-12T00:00:00.000Z
`);
    writeFileSync(join(root, ".keyoku", "runtime", "goal-focus.jsonl"), `${JSON.stringify({ eventType: "goal.focused", goalId: "current", createdAt: "2026-08-12T01:00:00.000Z" })}\n`);
    heartbeatAgentSession({
      root,
      sessionId: "parallel-agent",
      actor: { kind: "agent", id: "parallel-agent", name: "Parallel agent", harness: "test" },
      status: "working",
      currentWork: { outcomeId: "parallel", summary: "Working elsewhere" },
      transport: "test",
    });
    const orientation = buildProjectOrientation(root);
    expect(orientation.goals.count).toBe(2);
    expect(orientation.currentGoal?.id).toBe("current");
    expect(orientation.agents.active[0]?.currentWork?.outcomeId).toBe("parallel");
  });

  it("records an agent acknowledgement without rewriting the human request", () => {
    const root = projectRoot();
    const updated = acknowledgeSteering({
      root,
      steeringId: "steer_1",
      status: "applied",
      summary: "Mobile is now the first responsive breakpoint tested.",
      actor: "test-agent",
    });
    expect(updated.status).toBe("applied");
    expect(updated.acknowledgement?.actor).toBe("test-agent");
    expect(listSteering(root)).toHaveLength(1);
    expect(listSteering(root)[0]?.message).toBe("Prioritize the mobile view");
  });

  it("separates a committed intervention from understood, applied, and verified receipts", () => {
    const root = projectRoot();
    const actor = { kind: "human" as const, id: "owner", name: "Owner" };
    const created = createIntervention({
      root,
      kind: "direction",
      message: "Make the agent channel fully bidirectional",
      actor,
      deliveryPolicy: "next_checkpoint",
      idempotencyKey: "owner-message-1",
    });
    expect(created.phase).toBe("committed");
    expect(createIntervention({ root, kind: "direction", message: "duplicate", actor, idempotencyKey: "owner-message-1" }).id).toBe(created.id);

    const understood = recordInterventionReceipt({
      root,
      interventionId: created.id,
      phase: "understood",
      summary: "I will add presence, durable delivery, and semantic receipts.",
      actor: { kind: "agent", id: "agent-1", name: "Test agent", harness: "test" },
    });
    expect(understood.phase).toBe("understood");
    expect(understood.receipts).toHaveLength(1);

    const applied = recordInterventionReceipt({
      root,
      interventionId: created.id,
      phase: "applied",
      summary: "The protocol types and relay endpoints changed.",
      actor: { kind: "agent", id: "agent-1", name: "Test agent", harness: "test" },
      evidenceRefs: ["tests/project-state.test.ts"],
    });
    expect(applied.phase).toBe("applied");
    expect(listInterventions(root)[0]?.receipts[1]?.evidenceRefs).toEqual(["tests/project-state.test.ts"]);
  });

  it("treats agent presence as a renewable lease instead of inferring it", () => {
    const root = projectRoot();
    const heartbeat = heartbeatAgentSession({
      root,
      sessionId: "session-1",
      actor: { kind: "agent", id: "agent-1", name: "Test agent", harness: "test", model: "test-model" },
      status: "working",
      currentWork: { outcomeId: "current", summary: "Testing presence" },
      capabilities: ["stream", "intervene"],
      transport: "mcp-poll",
      leaseSeconds: 30,
    });
    expect(heartbeat.active).toBe(true);
    expect(listAgentSessions(root, new Date(heartbeat.createdAt))[0]?.active).toBe(true);
    expect(listAgentSessions(root, new Date(Date.parse(heartbeat.leaseUntil) + 1))[0]?.active).toBe(false);
  });

  it("surfaces overlapping multi-agent work without pretending to lock Git", () => {
    const root = projectRoot();
    for (const [sessionId, path] of [["agent-a", "src"], ["agent-b", "src/server.ts"]]) {
      heartbeatAgentSession({
        root,
        sessionId,
        actor: { kind: "agent", id: sessionId, name: sessionId, harness: "test" },
        status: "working",
        currentWork: { summary: "Parallel work", paths: [path], baseSnapshot: "abc123" },
        transport: "test",
      });
    }
    const conflicts = findAgentCoordinationConflicts(listAgentSessions(root));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ reason: "overlapping_path", scope: "src" });
    expect(new Set(conflicts[0]?.sessions)).toEqual(new Set(["agent-a", "agent-b"]));
  });
});
