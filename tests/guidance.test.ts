import { describe, expect, it } from "vitest";

import { buildCreateGuidance, PROTOCOL } from "../src/guidance.js";
import type { Goal } from "../src/types.js";

// Regression locks for the convergence-loop audit (AUDIT-convergence-loop-2026-06-17.md,
// proposed fix 3 + meta-note): the record-before-assess learning contract must be
// surfaced at goal_create, and the served protocol must document that build-then-verify
// (retroactive goal_record on a converged goal) is supported — the old text implied
// act/record always precedes convergence.

const goal: Goal = {
  id: "goal_test",
  slug: "test-goal",
  objective: "test objective",
  criteria: [
    {
      id: "c1",
      description: "echo ok",
      probe: { kind: "command", run: "echo ok", parse: "text" },
      assert: { op: "eq", value: "ok" },
    },
  ],
  constraints: [],
  autonomy: "suggest",
  status: "active",
  maxIterations: 10,
  usedIterations: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  convergedAt: null,
  lastAssessedAt: null,
};

describe("learning-contract surfacing (audit fix 3)", () => {
  it("goal_create guidance states the record-before-assess contract", () => {
    const guidance = buildCreateGuidance(goal);
    // Record as you work…
    expect(guidance).toMatch(/goal_record/);
    expect(guidance).toMatch(/BEFORE the final assess/);
    // …and the build-then-verify escape hatch: retroactive records are accepted.
    expect(guidance).toMatch(/accepted after convergence/);
    expect(guidance).toMatch(/build-then-verify/);
  });

  it("the served protocol documents build-then-verify / retroactive recording", () => {
    expect(PROTOCOL).toMatch(/[Bb]uild-then-verify/);
    expect(PROTOCOL).toMatch(/still accepted on\s+the converged goal/);
    expect(PROTOCOL).toMatch(/retroactive records spend no iteration budget/i);
  });
});
