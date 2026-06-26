import { describe, expect, it, vi } from "vitest";

import {
  chooseAgentForGoal,
  listOmnigentAgents,
  LIST_AGENTS_TOOL,
  type OmnigentAgentCandidate,
} from "../src/dispatch.js";
import { runGoalOnOmnigent } from "../src/run.js";
import type { SlmProvider } from "../src/slm.js";
import type { ConvergenceReport, Goal } from "../src/types.js";

function goal(overrides: Partial<Goal> = {}): Goal {
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
    ...overrides,
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
      constraints: [],
      iterationsUsed: 0,
      iterationsRemaining: 5,
    },
    converged: pass,
    driftDetected: false,
    criteria: [],
    unmetCount: pass ? 0 : 1,
    suggestedWorkflows: [],
    candidateWorkflows: [],
    relevantPatterns: [],
    guidance: "",
  };
}

function fakeSlm(response: unknown, prompts: string[] = []): SlmProvider {
  return {
    name: "fake",
    model: "fake-model",
    async complete(prompt, opts) {
      prompts.push(prompt);
      expect(opts).toMatchObject({ json: true });
      return typeof response === "string" ? response : JSON.stringify(response);
    },
  };
}

const agents: OmnigentAgentCandidate[] = [
  {
    name: "codex-native-ui",
    harness: "codex-native",
    description: "Implementation, refactors, tests, and build fixes.",
  },
  {
    name: "polly",
    harness: "polly",
    description: "Decomposition and orchestration of broad goals.",
  },
];

describe("listOmnigentAgents", () => {
  it("lists Omnigent candidate agents through the connector", async () => {
    const callTool = vi.fn(async () => ({
      text: JSON.stringify({ data: [...agents, { id: "agent_without_name" }] }),
      isError: false,
    }));

    await expect(listOmnigentAgents({ callTool } as any)).resolves.toEqual(agents);
    expect(callTool).toHaveBeenCalledWith("omnigent", LIST_AGENTS_TOOL, { limit: 1000 });
  });
});

describe("chooseAgentForGoal", () => {
  it("returns the model's chosen agent and rationale", async () => {
    const prompts: string[] = [];
    const log = vi.fn();

    await expect(
      chooseAgentForGoal({
        goal: goal({
          objective: "Coordinate a broad migration across several packages",
          constraints: ["Keep CI green"],
        }),
        agents,
        slm: fakeSlm(
          {
            agent: "polly",
            rationale: "The goal needs decomposition and orchestration across packages before implementation.",
          },
          prompts,
        ),
        log,
      }),
    ).resolves.toEqual({
      agent: "polly",
      rationale: "The goal needs decomposition and orchestration across packages before implementation.",
    });

    expect(prompts[0]).toContain("A model must decide the best-fit agent every time");
    expect(prompts[0]).toContain("Do not use regex, keyword matching, or fixed defaults");
    expect(prompts[0]).toContain("polly");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("polly"));
  });

  it("returns a deterministic degraded fallback without a model", async () => {
    const log = vi.fn();
    const first = await chooseAgentForGoal({ goal: goal(), agents, slm: null, log });
    const second = await chooseAgentForGoal({ goal: goal({ objective: "A different task" }), agents: [], slm: null, log });

    expect(first).toEqual({
      agent: "codex-native-ui",
      rationale: "no model available — default",
      degraded: true,
    });
    expect(second).toEqual(first);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("degraded"));
  });
});

describe("runGoalOnOmnigent dispatch", () => {
  it("uses the chosen agent when no explicit agentName is provided", async () => {
    const callTool = vi.fn(async (_name: string, tool: string) => {
      if (tool === LIST_AGENTS_TOOL) return { text: JSON.stringify({ data: agents }), isError: false };
      if (tool === "create_session_v1_sessions_post") {
        return { text: JSON.stringify({ conversation_id: "session_dispatch" }), isError: false };
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
      slm: fakeSlm({
        agent: "polly",
        rationale: "The task needs orchestration before low-level implementation.",
      }),
      getGoal: vi.fn(() => goal({ constraints: [] })),
      assess: vi.fn().mockResolvedValue(report(true)),
    };

    const result = await runGoalOnOmnigent({
      engine: engine as any,
      connectors: connectors as any,
      goalSlug: "ship-it",
      maxRounds: 1,
      log: () => {},
    });

    expect(result).toMatchObject({
      converged: true,
      rounds: 1,
      sessionId: "session_dispatch",
      dispatch: {
        agent: "polly",
        rationale: "The task needs orchestration before low-level implementation.",
      },
    });
    expect(callTool).toHaveBeenCalledWith("omnigent", LIST_AGENTS_TOOL, { limit: 1000 });
    expect(callTool).toHaveBeenCalledWith("omnigent", "create_session_v1_sessions_post", {
      body: { agent_name: "polly", title: "keyoku:ship-it" },
    });
  });

  it("respects an explicit agentName and skips dispatch reasoning", async () => {
    const callTool = vi.fn(async (_name: string, tool: string) => {
      if (tool === LIST_AGENTS_TOOL) throw new Error("dispatch should not list agents");
      if (tool === "create_session_v1_sessions_post") {
        return { text: JSON.stringify({ session_id: "session_explicit" }), isError: false };
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
    const slm = {
      name: "fake",
      model: "fake-model",
      complete: vi.fn(async () => {
        throw new Error("dispatch should not call the model");
      }),
    };
    const engine = {
      slm,
      getGoal: vi.fn(() => goal({ constraints: [] })),
      assess: vi.fn().mockResolvedValue(report(true)),
    };

    const result = await runGoalOnOmnigent({
      engine: engine as any,
      connectors: connectors as any,
      goalSlug: "ship-it",
      agentName: "codex-test",
      maxRounds: 1,
      log: () => {},
    });

    expect(result).toEqual({ converged: true, rounds: 1, sessionId: "session_explicit" });
    expect(slm.complete).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledWith("omnigent", "create_session_v1_sessions_post", {
      body: { agent_name: "codex-test", title: "keyoku:ship-it" },
    });
  });
});
