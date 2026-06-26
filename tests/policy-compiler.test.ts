import { describe, expect, it, vi } from "vitest";

import {
  buildConvergenceGate,
  compileConstraintsToPolicies,
  type OmnigentPolicySpec,
} from "../src/policy-compiler.js";
import type { SlmProvider } from "../src/slm.js";

function fakeSlm(response: unknown, prompts: string[] = []): SlmProvider {
  return {
    name: "fake",
    model: "fake-model",
    async complete(prompt) {
      prompts.push(prompt);
      return typeof response === "string" ? response : JSON.stringify(response);
    },
  };
}

describe("buildConvergenceGate", () => {
  it("denies response events and allows other events", () => {
    const spec = buildConvergenceGate("ship-it");

    expect(spec.name).toBe("keyoku-convergence-gate-ship-it");
    expect(spec.handler).toBe("omnigent.policies.builtins.cel.cel_policy");
    expect(spec.factory_params.expression).toContain('event.type == "response"');
    expect(spec.factory_params.expression).toContain('"result": "DENY"');
    expect(spec.factory_params.expression).toContain('"result": "ALLOW"');
    expect(spec.factory_params.expression).toContain(
      "Keyoku convergence gate [ship-it]: success criteria not yet verified",
    );
  });
});

describe("compileConstraintsToPolicies", () => {
  it("uses the model to return one well-formed policy per constraint", async () => {
    const prompts: string[] = [];
    const policies: OmnigentPolicySpec[] = [
      {
        name: "keyoku-constraint-1",
        handler: "omnigent.policies.builtins.working_dir.block_working_dir_changes",
        factory_params: { allowed_dirs: ["/repo"], action: "DENY" },
      },
      {
        name: "keyoku-constraint-2",
        handler: "omnigent.policies.builtins.cel.cel_policy",
        factory_params: {
          expression:
            'event.type == "tool_call" ? {"result":"ASK","reason":"review required"} : {"result":"ALLOW"}',
        },
      },
    ];

    await expect(
      compileConstraintsToPolicies(
        ["Only work in /repo", "Ask before risky operations"],
        { slm: fakeSlm({ policies }, prompts) },
      ),
    ).resolves.toEqual(policies);

    expect(prompts[0]).toContain("Available handlers:");
    expect(prompts[0]).toContain("omnigent.policies.builtins.github.github_policy");
    expect(prompts[0]).toContain("Only work in /repo");
    expect(prompts[0]).toContain("Ask before risky operations");
  });

  it("returns a deterministic degraded fallback without a model", async () => {
    const log = vi.fn();
    const first = await compileConstraintsToPolicies(["Keep changes small"], { slm: null, log });
    const second = await compileConstraintsToPolicies(["Different constraint"], { slm: null, log });

    expect(first).toEqual([
      {
        name: "keyoku-degraded-blast-radius",
        handler: "omnigent.inner.nessie.policies.blast_radius",
        factory_params: {},
      },
    ]);
    expect(second).toEqual(first);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("degraded offline fallback"));
  });

  it("rejects malformed model output instead of guessing a mapping", async () => {
    await expect(
      compileConstraintsToPolicies(["No network writes"], {
        slm: fakeSlm({ policies: [{ name: "bad", handler: "unknown", factory_params: {} }] }),
      }),
    ).rejects.toThrow(/unsupported handler/);
  });
});
