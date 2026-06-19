import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  observationDigest,
  observationFromReport,
  recordObservation,
  stateTransitions,
} from "../src/observe.js";
import { newId, Store } from "../src/store.js";
import type {
  ConvergenceReport,
  CriterionEvaluation,
  Observation,
  ObservationKind,
} from "../src/types.js";

let dir: string;
let store: Store;

const evaluation = (id: string, pass: boolean): CriterionEvaluation => ({
  id,
  description: `criterion ${id}`,
  pass,
  actual: pass ? "ok" : "bad",
  expected: { op: "eq", value: "ok", path: "output" },
  durationMs: 5,
});

const report = (
  overrides: Partial<Omit<ConvergenceReport, "goal">> = {},
  goalOverrides: Partial<ConvergenceReport["goal"]> = {},
): ConvergenceReport => ({
  goal: {
    id: "goal_abc123",
    slug: "test-goal",
    objective: "test objective",
    status: "active",
    autonomy: "suggest",
    constraints: [],
    iterationsUsed: 1,
    iterationsRemaining: 9,
    ...goalOverrides,
  },
  converged: false,
  driftDetected: false,
  criteria: [evaluation("c1", true), evaluation("c2", false), evaluation("c3", false)],
  unmetCount: 2,
  suggestedWorkflows: [],
  candidateWorkflows: [],
  relevantPatterns: [],
  guidance: "keep going",
  ...overrides,
});

const observation = (
  kind: ObservationKind,
  at: string,
  summary = `${kind} summary`,
): Observation => ({
  id: newId("obs"),
  goalId: "goal_abc123",
  goalSlug: "test-goal",
  kind,
  summary,
  unmet: [],
  at,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keyoku-observe-"));
  store = new Store(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("observationFromReport", () => {
  it("maps a converged report to a convergence observation", () => {
    const obs = observationFromReport(
      report({
        converged: true,
        criteria: [evaluation("c1", true), evaluation("c2", true), evaluation("c3", true)],
        unmetCount: 0,
      }),
    );
    expect(obs.kind).toBe("convergence");
    expect(obs.summary).toBe("all 3 criteria pass");
    expect(obs.unmet).toEqual([]);
  });

  it("maps a drifted report to a drift observation with failing ids", () => {
    const obs = observationFromReport(report({ driftDetected: true }));
    expect(obs.kind).toBe("drift");
    expect(obs.summary).toBe("2/3 criteria unmet: c2, c3");
    expect(obs.unmet).toEqual(["c2", "c3"]);
  });

  it("maps a blocked goal to a blocked observation", () => {
    const obs = observationFromReport(report({}, { status: "blocked" }));
    expect(obs.kind).toBe("blocked");
    expect(obs.summary).toBe("2/3 criteria unmet: c2, c3");
  });

  it("defaults to an assessment and carries the goal identity", () => {
    const obs = observationFromReport(report());
    expect(obs.kind).toBe("assessment");
    expect(obs.goalId).toBe("goal_abc123");
    expect(obs.goalSlug).toBe("test-goal");
    expect(obs.unmet).toEqual(["c2", "c3"]);
  });

  it("prefers drift over blocked when both apply", () => {
    const obs = observationFromReport(
      report({ driftDetected: true }, { status: "blocked" }),
    );
    expect(obs.kind).toBe("drift");
  });
});

describe("recordObservation", () => {
  it("stamps an id + ISO timestamp and persists the observation", () => {
    const before = Date.now();
    const recorded = recordObservation(store, observationFromReport(report()));
    expect(recorded.id).toMatch(/^obs_/);
    expect(new Date(recorded.at).getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(recorded.at).toBe(new Date(recorded.at).toISOString());

    const stored = store.listObservations(recorded.goalId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(recorded);
  });

  it("appends each recording in order", () => {
    recordObservation(store, observationFromReport(report()));
    recordObservation(store, observationFromReport(report({ driftDetected: true })));
    expect(store.listObservations("goal_abc123").map((o) => o.kind)).toEqual([
      "assessment",
      "drift",
    ]);
  });
});

describe("observationDigest", () => {
  it("returns an empty string when there are no observations", () => {
    expect(observationDigest(store, "goal_abc123")).toBe("");
  });

  it("renders one line per observation, oldest first", () => {
    store.appendObservation(
      observation("assessment", "2026-06-01T00:00:00.000Z", "2/3 criteria unmet: c2, c3"),
    );
    store.appendObservation(
      observation("convergence", "2026-06-02T00:00:00.000Z", "all 3 criteria pass"),
    );
    expect(observationDigest(store, "goal_abc123")).toBe(
      "2026-06-01T00:00:00.000Z assessment 2/3 criteria unmet: c2, c3\n" +
        "2026-06-02T00:00:00.000Z convergence all 3 criteria pass",
    );
  });

  it("caps the digest to the most recent <limit> observations", () => {
    for (let i = 1; i <= 5; i++) {
      store.appendObservation(
        observation("assessment", `2026-06-0${i}T00:00:00.000Z`, `step ${i}`),
      );
    }
    const lines = observationDigest(store, "goal_abc123", 3).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("step 3");
    expect(lines[2]).toContain("step 5");
  });
});

describe("stateTransitions", () => {
  it("returns zero counts and no timestamps for an unobserved goal", () => {
    expect(stateTransitions(store, "goal_abc123")).toEqual({
      assessments: 0,
      drifts: 0,
      convergences: 0,
      blocked: 0,
    });
  });

  it("counts every kind and tracks the latest drift/convergence timestamps", () => {
    store.appendObservation(observation("assessment", "2026-06-01T00:00:00.000Z"));
    store.appendObservation(observation("convergence", "2026-06-02T00:00:00.000Z"));
    store.appendObservation(observation("drift", "2026-06-03T00:00:00.000Z"));
    store.appendObservation(observation("assessment", "2026-06-04T00:00:00.000Z"));
    store.appendObservation(observation("convergence", "2026-06-05T00:00:00.000Z"));
    store.appendObservation(observation("drift", "2026-06-06T00:00:00.000Z"));
    store.appendObservation(observation("blocked", "2026-06-07T00:00:00.000Z"));

    expect(stateTransitions(store, "goal_abc123")).toEqual({
      assessments: 2,
      drifts: 2,
      convergences: 2,
      blocked: 1,
      lastDriftAt: "2026-06-06T00:00:00.000Z",
      lastConvergenceAt: "2026-06-05T00:00:00.000Z",
    });
  });

  it("only counts observations for the requested goal", () => {
    store.appendObservation(observation("convergence", "2026-06-01T00:00:00.000Z"));
    store.appendObservation({
      ...observation("drift", "2026-06-02T00:00:00.000Z"),
      goalId: "goal_other",
    });
    const transitions = stateTransitions(store, "goal_abc123");
    expect(transitions.convergences).toBe(1);
    expect(transitions.drifts).toBe(0);
  });
});
