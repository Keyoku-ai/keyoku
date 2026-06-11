import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConnectorManager } from "../src/connectors.js";
import { Harness } from "../src/engine.js";
import { buildRequest, type SynthTool } from "../src/openapi.js";
import { resolveSlmFromEnv } from "../src/slm.js";
import { observationFromReport } from "../src/observe.js";
import { newId, Store } from "../src/store.js";
import type { ConvergenceReport, Observation } from "../src/types.js";

// Regression coverage for the code-review fixes on the M2–M4 build.

describe("store: listObservations limit=0 means none, not all", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keyoku-reg-"));
    store = new Store(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns [] for limit 0 and the tail for positive limits", () => {
    for (let i = 0; i < 5; i++) {
      const obs: Observation = {
        id: newId("obs"),
        goalId: "g1",
        goalSlug: "g1",
        kind: "assessment",
        summary: `o${i}`,
        unmet: [],
        at: new Date().toISOString(),
      };
      store.appendObservation(obs);
    }
    expect(store.listObservations("g1", 0)).toHaveLength(0);
    expect(store.listObservations("g1", 2)).toHaveLength(2);
    expect(store.listObservations("g1")).toHaveLength(5);
  });
});

describe("slm: empty KEYOKU_SLM_MODEL falls back to the provider default", () => {
  it("does not produce an empty model id", () => {
    const slm = resolveSlmFromEnv({ GEMINI_API_KEY: "k", KEYOKU_SLM_MODEL: "" });
    expect(slm?.model).toBe("gemini-3.5-flash");
    const ws = resolveSlmFromEnv({ GEMINI_API_KEY: "k", KEYOKU_SLM_MODEL: "   " });
    expect(ws?.model).toBe("gemini-3.5-flash");
    const explicit = resolveSlmFromEnv({ GEMINI_API_KEY: "k", KEYOKU_SLM_MODEL: "gemini-3.1-flash-lite" });
    expect(explicit?.model).toBe("gemini-3.1-flash-lite");
  });
});

describe("openapi buildRequest: null handling and body gating", () => {
  const tool: SynthTool = {
    name: "getThing",
    description: "",
    method: "get",
    pathTemplate: "/things/{id}",
    params: [
      { name: "id", in: "path", required: true },
      { name: "verbose", in: "query", required: false },
      { name: "body", in: "query", required: false },
    ],
    hasBody: false,
    mutating: false,
  };

  it("skips null optional params instead of stringifying 'null'", () => {
    const req = buildRequest(tool, { id: "1", verbose: null }, "http://h");
    expect(req.url).toBe("http://h/things/1");
    expect(req.url).not.toContain("verbose");
  });

  it("rejects a null required path param", () => {
    expect(() => buildRequest(tool, { id: null }, "http://h")).toThrow(/missing required path/);
  });

  it("does not consume args.body as the HTTP body when hasBody is false", () => {
    // 'body' is a declared query param here; it must NOT become the request body.
    const req = buildRequest(tool, { id: "1", body: "x" }, "http://h");
    expect(req.body).toBeUndefined();
    expect(req.url).toContain("body=x");
  });

  it("query auth overrides a caller-supplied param of the same name", () => {
    const req = buildRequest(
      tool,
      { id: "1", api_key: "caller" },
      "http://h",
      { kind: "query", name: "api_key", value: "SECRET" },
    );
    const params = new URL(req.url).searchParams.getAll("api_key");
    expect(params).toEqual(["SECRET"]);
  });
});

describe("engine + observe: re-asserting a converged goal is not a new convergence", () => {
  let dir: string;
  let harness: Harness;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keyoku-reg-"));
    const store = new Store(dir);
    harness = new Harness(store, new ConnectorManager(store));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records 'convergence' once, then 'assessment' on steady-state re-checks", async () => {
    const state = join(dir, "s.txt");
    writeFileSync(state, "ready");
    const goal = harness.createGoal({
      objective: "state is ready",
      criteria: [
        {
          description: "ready",
          probe: { kind: "command", run: `cat ${state}`, parse: "text" },
          assert: { op: "eq", value: "ready" },
        },
      ],
    });
    await harness.assess(goal.slug); // fresh convergence
    await harness.assess(goal.slug); // steady-state
    await harness.assess(goal.slug); // steady-state
    const t = (await import("../src/observe.js")).stateTransitions(harness.store, goal.id);
    expect(t.convergences).toBe(1);
    expect(t.assessments).toBe(2);
  });

  it("observationFromReport still maps a fresh converged report to convergence", () => {
    const report: ConvergenceReport = {
      goal: {
        id: "g",
        slug: "g",
        objective: "o",
        status: "converged",
        autonomy: "suggest",
        constraints: [],
        iterationsUsed: 0,
        iterationsRemaining: 10,
      },
      converged: true,
      driftDetected: false,
      criteria: [
        { id: "c1", description: "x", pass: true, actual: 1, expected: { op: "eq", value: 1, path: "output" }, durationMs: 1 },
      ],
      unmetCount: 0,
      suggestedWorkflows: [],
      relevantPatterns: [],
      guidance: "",
    };
    expect(observationFromReport(report).kind).toBe("convergence");
  });
});
