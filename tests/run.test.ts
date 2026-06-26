import { describe, expect, it, vi } from "vitest";

import { ensureOmnigentConnector, runGoalOnOmnigent } from "../src/run.js";
import type { ConvergenceReport, Goal } from "../src/types.js";

function goal(): Goal {
  return {
    id: "goal_1",
    slug: "ship-it",
    objective: "Ship the feature",
    criteria: [],
    constraints: ["Stay inside the repo"],
    autonomy: "autonomous",
    maxIterations: 5,
    usedIterations: 0,
    status: "active",
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    convergedAt: null,
    lastAssessedAt: null,
  };
}

function report(pass: boolean): ConvergenceReport {
  return {
    goal: {
      id: "goal_1",
      slug: "ship-it",
      objective: "Ship the feature",
      status: pass ? "converged" : "active",
      autonomy: "autonomous",
      constraints: ["Stay inside the repo"],
      iterationsUsed: 0,
      iterationsRemaining: 5,
    },
    converged: pass,
    driftDetected: false,
    criteria: [
      {
        id: "c1",
        description: "tests pass",
        pass,
        actual: pass ? 0 : 1,
        expected: { path: "exitCode", op: "eq", value: 0 },
        ...(pass ? {} : { error: "command exited with code 1" }),
        durationMs: 1,
      },
    ],
    unmetCount: pass ? 0 : 1,
    suggestedWorkflows: [],
    candidateWorkflows: [],
    relevantPatterns: [],
    guidance: "",
  };
}

describe("ensureOmnigentConnector", () => {
  it("adds the omnigent preset when missing", async () => {
    const add = vi.fn(async () => ({ tools: [] }));
    const connectors = {
      get: vi.fn(() => undefined),
      add,
      callTool: vi.fn(),
    };

    await ensureOmnigentConnector(connectors as any);

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toMatchObject({
      name: "omnigent",
      description: expect.stringContaining("Omnigent"),
      autonomy: "approve",
      transport: {
        type: "openapi",
        allowMutating: true,
      },
    });
  });

  it("skips when omnigent is already registered", async () => {
    const add = vi.fn();
    const connectors = {
      get: vi.fn(() => ({ name: "omnigent" })),
      add,
      callTool: vi.fn(),
    };

    await ensureOmnigentConnector(connectors as any);

    expect(add).not.toHaveBeenCalled();
  });
});

describe("runGoalOnOmnigent", () => {
  it("creates a session, installs policies, drives to convergence, and returns the session id", async () => {
    let policyCount = 0;
    const callTool = vi.fn(async (_name: string, tool: string) => {
      if (tool === "create_session_v1_sessions_post") {
        return { text: JSON.stringify({ conversation_id: "session_1" }), isError: false };
      }
      if (tool === "create_policy_v1_sessions__session_id__policies_post") {
        policyCount += 1;
        return { text: JSON.stringify({ id: `policy_${policyCount}` }), isError: false };
      }
      return { text: "{}", isError: false };
    });
    const connectors = {
      get: vi.fn(() => ({ name: "omnigent" })),
      add: vi.fn(),
      callTool,
    };
    const engine = {
      slm: null,
      getGoal: vi.fn(() => goal()),
      assess: vi
        .fn()
        .mockResolvedValueOnce(report(false))
        .mockResolvedValueOnce(report(false))
        .mockResolvedValueOnce(report(true)),
    };

    const result = await runGoalOnOmnigent({
      engine: engine as any,
      connectors: connectors as any,
      goalSlug: "ship-it",
      agentName: "codex-test",
      maxRounds: 5,
    });

    expect(result).toEqual({ converged: true, rounds: 2, sessionId: "session_1" });
    expect(callTool).toHaveBeenCalledWith("omnigent", "create_session_v1_sessions_post", {
      body: { agent_name: "codex-test", title: "keyoku:ship-it" },
    });
    expect(engine.getGoal).toHaveBeenCalledWith("ship-it");
    expect(engine.assess).toHaveBeenCalledTimes(3);

    const createPolicyCalls = callTool.mock.calls.filter(
      (call) => call[1] === "create_policy_v1_sessions__session_id__policies_post",
    );
    expect(createPolicyCalls).toHaveLength(2);
    expect(createPolicyCalls[0][2]).toMatchObject({
      session_id: "session_1",
      body: { name: "keyoku-degraded-blast-radius" },
    });
    expect(createPolicyCalls[1][2]).toMatchObject({
      session_id: "session_1",
      body: { name: "keyoku-convergence-gate-ship-it" },
    });

    const postCalls = callTool.mock.calls.filter(
      (call) => call[1] === "post_event_v1_sessions__session_id__events_post",
    );
    expect(postCalls).toHaveLength(2);
    expect(JSON.stringify(postCalls[0][2])).toContain("Ship the feature");
    expect(JSON.stringify(postCalls[0][2])).toContain("[c1] tests pass");
    expect(JSON.stringify(postCalls[1][2])).toContain("Still not done");
    expect(callTool).toHaveBeenCalledWith(
      "omnigent",
      "delete_policy_v1_sessions__session_id__policies__policy_id__delete",
      { session_id: "session_1", policy_id: "policy_2" },
    );
  });

  it("falls back to agent_id session creation when the live Omnigent API requires it", async () => {
    const callTool = vi.fn(async (_name: string, tool: string, args: Record<string, unknown>) => {
      if (tool === "create_session_v1_sessions_post" && JSON.stringify(args).includes("agent_name")) {
        return { text: "HTTP 422: missing agent_id", isError: true };
      }
      if (tool === "list_builtin_agents_v1_agents_get") {
        return {
          text: JSON.stringify({ data: [{ id: "agent_1", name: "codex-test", harness: "codex-native" }] }),
          isError: false,
        };
      }
      if (tool === "create_session_v1_sessions_post") {
        return { text: JSON.stringify({ id: "session_2" }), isError: false };
      }
      if (tool === "create_policy_v1_sessions__session_id__policies_post") {
        return { text: JSON.stringify({ id: "gate_1" }), isError: false };
      }
      return { text: "{}", isError: false };
    });
    const connectors = {
      get: vi.fn(() => ({ name: "omnigent" })),
      add: vi.fn(),
      callTool,
    };
    const engine = {
      slm: null,
      getGoal: vi.fn(() => ({ ...goal(), constraints: [] })),
      assess: vi.fn().mockResolvedValue(report(true)),
    };

    const result = await runGoalOnOmnigent({
      engine: engine as any,
      connectors: connectors as any,
      goalSlug: "ship-it",
      agentName: "codex-test",
      maxRounds: 1,
    });

    expect(result).toEqual({ converged: true, rounds: 1, sessionId: "session_2" });
    expect(callTool).toHaveBeenCalledWith("omnigent", "create_session_v1_sessions_post", {
      body: { agent_name: "codex-test", title: "keyoku:ship-it" },
    });
    expect(callTool).toHaveBeenCalledWith("omnigent", "list_builtin_agents_v1_agents_get", {
      limit: 1000,
    });
    expect(callTool).toHaveBeenCalledWith("omnigent", "create_session_v1_sessions_post", {
      body: { agent_id: "agent_1", title: "keyoku:ship-it" },
    });
  });
});
