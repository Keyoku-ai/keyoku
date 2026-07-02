import { describe, expect, it, vi } from "vitest";

import {
  driveToConvergence,
  installPolicies,
  removePolicy,
} from "../src/omnigent-guardrails.js";
import type { OmnigentPolicySpec } from "../src/policy-compiler.js";

const policy: OmnigentPolicySpec = {
  name: "test-policy",
  handler: "omnigent.policies.builtins.cel.cel_policy",
  factory_params: { expression: '{"result":"ALLOW"}' },
};

describe("installPolicies", () => {
  it("creates policies on the omnigent connector and returns ids", async () => {
    const callTool = vi.fn(async () => ({ text: JSON.stringify({ id: "pol_1" }), isError: false }));

    await expect(installPolicies({ callTool }, "conv_1", [policy])).resolves.toEqual(["pol_1"]);

    expect(callTool).toHaveBeenCalledWith(
      "omnigent",
      "create_policy_v1_sessions__session_id__policies_post",
      {
        session_id: "conv_1",
        body: {
          type: "python",
          ...policy,
        },
      },
    );
  });

  it("deletes a policy by id", async () => {
    const callTool = vi.fn(async () => ({ text: "{}", isError: false }));

    await removePolicy({ callTool }, "conv_1", "pol_1");

    expect(callTool).toHaveBeenCalledWith(
      "omnigent",
      "delete_policy_v1_sessions__session_id__policies__policy_id__delete",
      { session_id: "conv_1", policy_id: "pol_1" },
    );
  });
});

describe("driveToConvergence", () => {
  it("installs the gate, posts continuation messages while unmet, and removes it on convergence", async () => {
    const callTool = vi.fn(async (_name: string, tool: string) => {
      if (tool.includes("create_policy")) return { text: JSON.stringify({ id: "gate_1" }), isError: false };
      return { text: "{}", isError: false };
    });
    const assess = vi
      .fn()
      .mockResolvedValueOnce({ converged: false, unmet: ["[c1] build fails"] })
      .mockResolvedValueOnce({ converged: true, unmet: [] });
    const postMessage = vi.fn(async (_text: string) => {});

    await expect(
      driveToConvergence({
        connectors: { callTool },
        sessionId: "conv_1",
        goalSlug: "ship-it",
        assess,
        postMessage,
      }),
    ).resolves.toEqual({ converged: true, rounds: 2 });

    expect(assess).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toContain("Still not done");
    expect(postMessage.mock.calls[0][0]).toContain("[c1] build fails");
    expect(callTool.mock.calls.filter((call) => String(call[1]).includes("create_policy"))).toHaveLength(1);
    expect(callTool.mock.calls.filter((call) => String(call[1]).includes("delete_policy"))).toHaveLength(1);
  });

  it("leaves the gate installed when max rounds are exhausted", async () => {
    const callTool = vi.fn(async (_name: string, _tool: string) => ({ text: JSON.stringify({ id: "gate_1" }), isError: false }));
    const assess = vi.fn(async () => ({ converged: false, unmet: ["[c1] still failing"] }));
    const postMessage = vi.fn(async () => {});

    await expect(
      driveToConvergence({
        connectors: { callTool },
        sessionId: "conv_1",
        goalSlug: "ship-it",
        assess,
        maxRounds: 2,
        postMessage,
      }),
    ).resolves.toEqual({ converged: false, rounds: 2 });

    expect(assess).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(callTool.mock.calls.filter((call) => String(call[1]).includes("delete_policy"))).toHaveLength(0);
  });
});
