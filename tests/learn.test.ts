import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mineHeuristic, normalizeStep, relevantPatterns, runLearning } from "../src/learn.js";
import { newId, Store } from "../src/store.js";
import type {
  ActionResult,
  Goal,
  GoalStatus,
  Observation,
  ObservationKind,
  Pattern,
  WorkflowStep,
} from "../src/types.js";

let dir: string;
let store: Store;

const NOW = "2026-06-10T00:00:00.000Z";

const goal = (slug: string, overrides: Partial<Goal> = {}): Goal => ({
  id: newId("goal"),
  slug,
  objective: `objective for ${slug}`,
  criteria: [],
  constraints: [],
  autonomy: "suggest",
  maxIterations: 10,
  usedIterations: 1,
  status: "converged" as GoalStatus,
  createdAt: NOW,
  updatedAt: NOW,
  convergedAt: NOW,
  lastAssessedAt: NOW,
  ...overrides,
});

const saveWorkflowFor = (g: Goal, summaries: string[]): void => {
  store.saveWorkflow({
    id: newId("wf"),
    slug: g.slug,
    objective: g.objective,
    steps: summaries.map((summary): WorkflowStep => ({ summary, result: "success" })),
    criteria: [],
    stats: { convergences: 1, totalActions: summaries.length },
    createdAt: NOW,
    updatedAt: NOW,
  });
};

const record = (g: Goal, summary: string, result: ActionResult, at: string): void => {
  store.appendRecord({
    id: newId("act"),
    goalId: g.id,
    iteration: 1,
    summary,
    result,
    at,
  });
};

const observe = (g: Goal, kind: ObservationKind, at: string): void => {
  const obs: Observation = {
    id: newId("obs"),
    goalId: g.id,
    goalSlug: g.slug,
    kind,
    summary: `${kind} on ${g.slug}`,
    unmet: [],
    at,
  };
  store.appendObservation(obs);
};

const pattern = (overrides: Partial<Pattern> & { name: string }): Pattern => ({
  id: newId("pat"),
  description: "",
  steps: [],
  evidence: { goalSlugs: [], occurrences: 1 },
  confidence: 0.5,
  stability: 1,
  source: "heuristic",
  createdAt: NOW,
  updatedAt: NOW,
  lastSeenAt: NOW,
  ...overrides,
});

/** Seed two converged goals whose workflows share a normalized step sequence. */
const seedCrossGoalRepeat = (): void => {
  const a = goal("deploy-api");
  const b = goal("deploy-web");
  store.saveGoal(a);
  store.saveGoal(b);
  saveWorkflowFor(a, [
    "Deploy revision 42 to /srv/app",
    'Restart service "api"',
    "Verify health endpoint returns 200",
  ]);
  saveWorkflowFor(b, [
    "deploy revision 57 to /opt/web",
    "restart service 'web'",
    "verify health endpoint returns 200",
  ]);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keyoku-learn-"));
  store = new Store(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("normalizeStep", () => {
  it("lowercases, collapses whitespace, and replaces numbers, quotes, and paths", () => {
    expect(normalizeStep('Deploy  revision 42 of "api" to /srv/app/v2')).toBe(
      "deploy revision <num> of <str> to <path>",
    );
    expect(normalizeStep("restart pod api-123")).toBe("restart pod api-<num>");
  });
});

describe("mineHeuristic", () => {
  it("finds a step sequence repeated across >= 2 converged goals", () => {
    seedCrossGoalRepeat();
    // A converged goal with a unique workflow and a non-converged goal with
    // the same steps must not contribute.
    const lone = goal("rotate-keys");
    const active = goal("deploy-staging", { status: "active", convergedAt: null });
    store.saveGoal(lone);
    store.saveGoal(active);
    saveWorkflowFor(lone, ["rotate the signing key"]);
    saveWorkflowFor(active, ["Deploy revision 9 to /srv/app", 'Restart service "x"', "Verify health endpoint returns 200"]);

    const candidates = mineHeuristic(store);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe(0.6);
    expect(candidates[0].goalSlugs.sort()).toEqual(["deploy-api", "deploy-web"]);
    expect(candidates[0].steps).toEqual([
      "deploy revision <num> to <path>",
      "restart service <str>",
      "verify health endpoint returns <num>",
    ]);
  });

  it("falls back to successful action records when a goal has no workflow", () => {
    const a = goal("fix-db-a");
    const b = goal("fix-db-b");
    store.saveGoal(a);
    store.saveGoal(b);
    record(a, "Rotate credential 'db-pass-1'", "success", "2026-06-01T00:00:00.000Z");
    record(a, "poked it randomly", "failure", "2026-06-01T00:01:00.000Z");
    record(a, "Restart database 5432", "success", "2026-06-01T00:02:00.000Z");
    record(b, "rotate credential 'db-pass-9'", "success", "2026-06-02T00:00:00.000Z");
    record(b, "restart database 5433", "success", "2026-06-02T00:01:00.000Z");

    const candidates = mineHeuristic(store);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].steps).toEqual([
      "rotate credential <str>",
      "restart database <num>",
    ]);
  });

  it("finds drift-recovery fixes that repeat with the same normalized summary", () => {
    const g = goal("keep-api-up");
    store.saveGoal(g);
    observe(g, "assessment", "2026-06-01T00:00:00.000Z");
    observe(g, "drift", "2026-06-02T00:00:00.000Z");
    observe(g, "convergence", "2026-06-03T00:00:00.000Z");
    observe(g, "drift", "2026-06-04T00:00:00.000Z");
    observe(g, "convergence", "2026-06-05T00:00:00.000Z");
    // Outside any drift window: must not count.
    record(g, "Initial deploy", "success", "2026-06-01T01:00:00.000Z");
    // Cycle 1: one successful fix, one failed attempt.
    record(g, "Restarted pod api-123", "success", "2026-06-02T01:00:00.000Z");
    record(g, "checked the logs", "failure", "2026-06-02T02:00:00.000Z");
    // Cycle 2: the same fix, modulo the pod number.
    record(g, "restarted pod api-456", "success", "2026-06-04T01:00:00.000Z");

    const candidates = mineHeuristic(store);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("recovery: restarted pod api-<num>");
    expect(candidates[0].confidence).toBe(0.5);
    expect(candidates[0].steps).toEqual(["restarted pod api-<num>"]);
    expect(candidates[0].goalSlugs).toEqual(["keep-api-up"]);
  });

  it("returns no candidates for an empty store", () => {
    expect(mineHeuristic(store)).toEqual([]);
  });
});

describe("runLearning (heuristic)", () => {
  it("creates patterns on first run and reinforces (dedupes) on the second", async () => {
    seedCrossGoalRepeat();

    const first = await runLearning(store, null);
    expect(first.method).toBe("heuristic");
    expect(first.minedCandidates).toBe(1);
    expect(first.created).toBe(1);
    expect(first.reinforced).toBe(0);
    expect(first.totalPatterns).toBe(1);

    const [created] = store.listPatterns();
    expect(created.id).toMatch(/^pat_/);
    expect(created.source).toBe("heuristic");
    expect(created.stability).toBe(1);
    expect(created.evidence.occurrences).toBe(1);
    expect(created.confidence).toBe(0.6);

    const second = await runLearning(store, null);
    expect(second.created).toBe(0);
    expect(second.reinforced).toBe(1);
    expect(second.totalPatterns).toBe(1);

    const [reinforced] = store.listPatterns();
    expect(reinforced.id).toBe(created.id);
    expect(reinforced.stability).toBe(2);
    expect(reinforced.evidence.occurrences).toBe(2);
    // Union, not concat: slugs stay deduped.
    expect(reinforced.evidence.goalSlugs.sort()).toEqual(["deploy-api", "deploy-web"]);
    expect(reinforced.lastSeenAt >= created.lastSeenAt).toBe(true);
  });
});

describe("runLearning (slm)", () => {
  it("uses valid fenced SLM JSON, skipping invalid elements and clamping confidence", async () => {
    const g = goal("ship-hotfix", { objective: "ship the hotfix safely" });
    store.saveGoal(g);
    let seenPrompt = "";
    const slm = {
      name: "fake",
      model: "fake-1",
      complete: async (prompt: string) => {
        seenPrompt = prompt;
        return [
          "Here are the patterns:",
          "```json",
          JSON.stringify([
            {
              name: "Deploy hotfix",
              description: "Build, push, verify.",
              steps: ["build image", "push image", "verify deploy"],
              confidence: 1.7,
              goalSlugs: ["ship-hotfix"],
            },
            { description: "no name, must be skipped", steps: ["x"] },
            { name: "Rollback fast", steps: ["redeploy previous revision"] },
          ]),
          "```",
        ].join("\n");
      },
    };

    const result = await runLearning(store, slm);
    expect(result.method).toBe("slm");
    expect(result.minedCandidates).toBe(2);
    expect(result.created).toBe(2);
    expect(result.totalPatterns).toBe(2);

    const patterns = store.listPatterns();
    const deploy = patterns.find((p) => p.name === "Deploy hotfix");
    expect(deploy?.source).toBe("slm");
    expect(deploy?.confidence).toBe(1); // clamped from 1.7
    expect(deploy?.evidence.goalSlugs).toEqual(["ship-hotfix"]);
    const rollback = patterns.find((p) => p.name === "Rollback fast");
    expect(rollback?.confidence).toBe(0.5); // defaulted
    expect(rollback?.description).toBe("");

    // The corpus made it into the prompt.
    expect(seenPrompt).toContain("ship-hotfix");
    expect(seenPrompt).toContain("ship the hotfix safely");
  });

  it("merges an SLM candidate into an existing pattern by step-set overlap", async () => {
    const slmFor = (name: string, steps: string[], description: string) => ({
      name: "fake",
      model: "fake-1",
      complete: async () => JSON.stringify([{ name, steps, confidence: 0.8, description, goalSlugs: ["g1"] }]),
    });

    await runLearning(store, slmFor("Deploy hotfix", ["build image", "push image", "verify deploy"], "short"));
    // Different name, identical steps -> Jaccard 1 -> reinforce, keep longer description.
    const result = await runLearning(
      store,
      slmFor("ship a hotfix", ["build image", "push image", "verify deploy"], "a much longer description wins"),
    );
    expect(result.created).toBe(0);
    expect(result.reinforced).toBe(1);
    expect(result.totalPatterns).toBe(1);
    const [p] = store.listPatterns();
    expect(p.name).toBe("Deploy hotfix");
    expect(p.description).toBe("a much longer description wins");
    expect(p.stability).toBe(2);
  });

  it("falls back to heuristic when the SLM returns garbage", async () => {
    seedCrossGoalRepeat();
    const noArray = {
      name: "fake",
      model: "fake-1",
      complete: async () => "I could not find any patterns, sorry.",
    };
    const first = await runLearning(store, noArray);
    expect(first.method).toBe("heuristic");
    expect(first.created).toBe(1);
    expect(store.listPatterns()[0].source).toBe("heuristic");

    const badJson = {
      name: "fake",
      model: "fake-1",
      complete: async () => "```json\n[this is not json]\n```",
    };
    const second = await runLearning(store, badJson);
    expect(second.method).toBe("heuristic");
    expect(second.reinforced).toBe(1);
  });

  it("falls back to heuristic when the SLM throws", async () => {
    seedCrossGoalRepeat();
    const broken = {
      name: "fake",
      model: "fake-1",
      complete: async (): Promise<string> => {
        throw new Error("boom");
      },
    };
    const result = await runLearning(store, broken);
    expect(result.method).toBe("heuristic");
    expect(result.created).toBe(1);
    expect(result.totalPatterns).toBe(1);
  });
});

describe("relevantPatterns", () => {
  it("ranks the on-topic pattern first and filters off-topic ones", () => {
    const deploy = pattern({
      name: "deploy cloud run service",
      description: "build container, push, deploy, verify traffic",
      steps: ["gcloud run deploy"],
      stability: 3,
    });
    const rotate = pattern({
      name: "rotate database credentials",
      description: "rotate secret, update env, restart",
      steps: ["kubectl rollout restart"],
      stability: 3,
    });
    store.savePattern(deploy);
    store.savePattern(rotate);

    const results = relevantPatterns(store, "deploy the cloud run service with a new container");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe(deploy.id);
    expect(results.some((p) => p.id === rotate.id)).toBe(false);
  });

  it("boosts recently-seen stability: a stale twin ranks below a fresh pattern", () => {
    const fresh = pattern({
      name: "deploy cloud run service",
      stability: 3,
      lastSeenAt: "2026-06-09T00:00:00.000Z",
    });
    const stale = pattern({
      name: "deploy cloud run service",
      stability: 5,
      lastSeenAt: "2024-01-01T00:00:00.000Z", // ~2.5 years: stability fully decayed
    });
    store.savePattern(fresh);
    store.savePattern(stale);

    const results = relevantPatterns(store, "deploy cloud run service", new Date(NOW));
    expect(results.map((p) => p.id)).toEqual([fresh.id, stale.id]);
  });

  it("returns [] when nothing overlaps", () => {
    store.savePattern(pattern({ name: "deploy cloud run service", stability: 3 }));
    expect(relevantPatterns(store, "zebra dance party")).toEqual([]);
    expect(relevantPatterns(store, "")).toEqual([]);
  });

  it("caps results at 3", () => {
    for (let i = 0; i < 5; i++) {
      store.savePattern(pattern({ name: `deploy cloud run service variant${i}`, stability: i + 1 }));
    }
    expect(relevantPatterns(store, "deploy cloud run service")).toHaveLength(3);
  });
});
