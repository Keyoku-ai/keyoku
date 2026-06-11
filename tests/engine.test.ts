import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConnectorManager } from "../src/connectors.js";
import { Harness, type CreateGoalInput } from "../src/engine.js";
import { Store } from "../src/store.js";

let dir: string;
let harness: Harness;

const fileGoal = (file: string, extra: Partial<CreateGoalInput> = {}): CreateGoalInput => ({
  objective: "the state file must say ready",
  criteria: [
    {
      description: "state file contains 'ready'",
      probe: { kind: "command", run: `cat ${file}`, parse: "text" },
      assert: { op: "contains", value: "ready" },
    },
  ],
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keyoku-engine-"));
  const store = new Store(dir);
  harness = new Harness(store, new ConnectorManager(store));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Harness goal lifecycle", () => {
  it("creates goals with ids, slugs, defaults", () => {
    const goal = harness.createGoal(fileGoal("/dev/null"));
    expect(goal.slug).toBe("the-state-file-must-say-ready");
    expect(goal.criteria[0].id).toBe("c1");
    expect(goal.autonomy).toBe("suggest");
    expect(goal.maxIterations).toBe(10);
    expect(goal.status).toBe("active");
  });

  it("rejects goals without criteria", () => {
    expect(() =>
      harness.createGoal({ objective: "be better", criteria: [] }),
    ).toThrow(/machine-checkable/);
  });

  it("rejects mcp criteria referencing unknown connectors", () => {
    expect(() =>
      harness.createGoal({
        objective: "x",
        criteria: [
          {
            description: "y",
            probe: { kind: "mcp", connector: "ghost", tool: "t" },
            assert: { op: "truthy" },
          },
        ],
      }),
    ).toThrow(/unknown connector 'ghost'/);
  });

  it("getGoal resolves slug or id and lists known goals on miss", () => {
    const goal = harness.createGoal(fileGoal("/dev/null"));
    expect(harness.getGoal(goal.id).slug).toBe(goal.slug);
    expect(harness.getGoal(goal.slug).id).toBe(goal.id);
    expect(() => harness.getGoal("nope")).toThrow(goal.slug);
  });
});

describe("the convergence loop", () => {
  it("assess → act → record → assess converges and promotes a workflow", async () => {
    const state = join(dir, "state.txt");
    writeFileSync(state, "not yet");
    const goal = harness.createGoal(fileGoal(state));

    const first = await harness.assess(goal.slug);
    expect(first.converged).toBe(false);
    expect(first.unmetCount).toBe(1);
    expect(first.criteria[0].actual).toBe("not yet");
    expect(first.guidance).toContain("NOT CONVERGED");
    expect(first.guidance).toContain("suggest");

    // The "agent" acts.
    writeFileSync(state, "ready");
    harness.recordAction(goal.slug, {
      summary: "Wrote 'ready' to the state file",
      tool: "Bash",
    });

    const second = await harness.assess(goal.slug);
    expect(second.converged).toBe(true);
    expect(second.goal.status).toBe("converged");
    expect(second.guidance).toContain("CONVERGED");

    const workflows = harness.store.listWorkflows();
    expect(workflows).toHaveLength(1);
    expect(workflows[0].slug).toBe(goal.slug);
    expect(workflows[0].steps.map((s) => s.summary)).toEqual([
      "Wrote 'ready' to the state file",
    ]);
    expect(workflows[0].stats.convergences).toBe(1);
  });

  it("detects drift and reactivates the goal", async () => {
    const state = join(dir, "state.txt");
    writeFileSync(state, "ready");
    const goal = harness.createGoal(fileGoal(state));

    expect((await harness.assess(goal.slug)).converged).toBe(true);

    writeFileSync(state, "broken");
    const drifted = await harness.assess(goal.slug);
    expect(drifted.converged).toBe(false);
    expect(drifted.driftDetected).toBe(true);
    expect(drifted.goal.status).toBe("active");
    expect(drifted.guidance).toContain("DRIFT");
  });

  it("re-convergence bumps stability without erasing learned steps", async () => {
    const state = join(dir, "state.txt");
    writeFileSync(state, "not yet");
    const goal = harness.createGoal(fileGoal(state));

    await harness.assess(goal.slug);
    writeFileSync(state, "ready");
    harness.recordAction(goal.slug, { summary: "fix the file" });
    await harness.assess(goal.slug);

    // Drift, then steady-state recovery with no new actions recorded.
    writeFileSync(state, "broken");
    await harness.assess(goal.slug);
    writeFileSync(state, "ready");
    await harness.assess(goal.slug);

    const wf = harness.store.getWorkflow(goal.slug);
    expect(wf?.stats.convergences).toBe(2);
    expect(wf?.steps.map((s) => s.summary)).toEqual(["fix the file"]);
    // The trace is cumulative — stats must not double-count it.
    expect(wf?.stats.totalActions).toBe(1);
  });

  it("blocks the goal when the iteration budget is exhausted", async () => {
    const goal = harness.createGoal(fileGoal("/dev/null", { maxIterations: 2 }));
    harness.recordAction(goal.slug, { summary: "try 1" });
    harness.recordAction(goal.slug, { summary: "try 2" });
    expect(harness.getGoal(goal.slug).status).toBe("blocked");
    expect(() => harness.recordAction(goal.slug, { summary: "try 3" })).toThrow(/blocked/);

    // Raising the budget unblocks.
    harness.updateGoal(goal.slug, { maxIterations: 5 });
    expect(harness.getGoal(goal.slug).status).toBe("active");
    harness.recordAction(goal.slug, { summary: "try 3" });
    expect(harness.getGoal(goal.slug).usedIterations).toBe(3);
  });

  it("probe errors fail criteria with explanations instead of throwing", async () => {
    const goal = harness.createGoal({
      objective: "missing file readable",
      criteria: [
        {
          description: "file exists",
          probe: { kind: "command", run: `cat ${join(dir, "missing.txt")}`, parse: "text" },
          assert: { path: "exitCode", op: "eq", value: 0 },
        },
      ],
    });
    const report = await harness.assess(goal.slug);
    expect(report.converged).toBe(false);
    expect(report.criteria[0].error).toContain("exit");
  });

  it("a failing probe cannot satisfy a criterion even when the assertion would pass", async () => {
    const goal = harness.createGoal({
      objective: "no false convergence on broken probes",
      criteria: [
        {
          description: "output is empty",
          // stdout matches the assertion, but the probe itself failed
          probe: { kind: "command", run: "exit 1", parse: "text" },
          assert: { op: "falsy" },
        },
      ],
    });
    const report = await harness.assess(goal.slug);
    expect(report.converged).toBe(false);
    expect(report.criteria[0].error).toContain("probe itself failed");
    expect(harness.store.listWorkflows()).toHaveLength(0);
  });

  it("assertions that explicitly inspect transport fields still work on failing probes", async () => {
    const goal = harness.createGoal({
      objective: "command must fail",
      criteria: [
        {
          description: "exit code is 1",
          probe: { kind: "command", run: "exit 1", parse: "text" },
          assert: { path: "exitCode", op: "eq", value: 1 },
        },
      ],
    });
    const report = await harness.assess(goal.slug);
    expect(report.converged).toBe(true);
  });

  it("drift with an exhausted budget blocks instead of silently re-arming", async () => {
    const state = join(dir, "state.txt");
    writeFileSync(state, "not yet");
    const goal = harness.createGoal(fileGoal(state, { maxIterations: 1 }));
    await harness.assess(goal.slug);
    writeFileSync(state, "ready");
    harness.recordAction(goal.slug, { summary: "fix" });
    expect((await harness.assess(goal.slug)).converged).toBe(true);

    writeFileSync(state, "broken");
    const drifted = await harness.assess(goal.slug);
    expect(drifted.driftDetected).toBe(true);
    expect(drifted.goal.status).toBe("blocked");
    expect(drifted.guidance).toContain("BLOCKED");
  });

  it("recording on a converged goal is rejected", async () => {
    const goal = harness.createGoal({
      objective: "always true",
      criteria: [
        {
          description: "echo ok",
          probe: { kind: "command", run: "echo ok", parse: "text" },
          assert: { op: "eq", value: "ok" },
        },
      ],
    });
    await harness.assess(goal.slug);
    expect(() => harness.recordAction(goal.slug, { summary: "pointless" })).toThrow(
      /already converged/,
    );
  });

  it("abandoned goals refuse assess and record until resumed", async () => {
    const goal = harness.createGoal(fileGoal("/dev/null"));
    harness.updateGoal(goal.slug, { status: "abandoned" });
    await expect(harness.assess(goal.slug)).rejects.toThrow(/abandoned/);
    expect(() => harness.recordAction(goal.slug, { summary: "x" })).toThrow(/abandoned/);
    harness.updateGoal(goal.slug, { status: "active" });
    expect((await harness.assess(goal.slug)).converged).toBe(false);
  });

  it("reactivating via status cannot bypass an exhausted budget", () => {
    const goal = harness.createGoal(fileGoal("/dev/null", { maxIterations: 1 }));
    harness.recordAction(goal.slug, { summary: "only try" });
    expect(harness.getGoal(goal.slug).status).toBe("blocked");
    expect(() => harness.updateGoal(goal.slug, { status: "active" })).toThrow(
      /Raise maxIterations/,
    );
  });

  it("lowering maxIterations below spent iterations blocks immediately", () => {
    const goal = harness.createGoal(fileGoal("/dev/null", { maxIterations: 5 }));
    harness.recordAction(goal.slug, { summary: "try 1" });
    harness.recordAction(goal.slug, { summary: "try 2" });
    harness.updateGoal(goal.slug, { maxIterations: 2 });
    expect(harness.getGoal(goal.slug).status).toBe("blocked");
    expect(() => harness.recordAction(goal.slug, { summary: "over budget" })).toThrow(/blocked/);
  });

  it("a slow assess does not roll back a concurrent record or resurrect a deleted goal", async () => {
    const state = join(dir, "state.txt");
    writeFileSync(state, "ready");
    const slowGoal = harness.createGoal({
      objective: "slow probe goal",
      criteria: [
        {
          description: "slow but true",
          probe: { kind: "command", run: `sleep 0.4 && cat ${state}`, parse: "text" },
          assert: { op: "eq", value: "ready" },
        },
      ],
    });

    // Record lands while the probe is still sleeping; assess must not undo it.
    const assessing = harness.assess(slowGoal.slug);
    await new Promise((r) => setTimeout(r, 100));
    harness.recordAction(slowGoal.slug, { summary: "mid-flight action" });
    const report = await assessing;
    expect(report.goal.iterationsUsed).toBe(1);
    expect(harness.getGoal(slowGoal.slug).usedIterations).toBe(1);

    // Delete lands while a second assess is in flight; it must not resurrect.
    const secondAssess = harness.assess(slowGoal.slug);
    await new Promise((r) => setTimeout(r, 100));
    harness.deleteGoal(slowGoal.slug);
    await expect(secondAssess).rejects.toThrow(/deleted/);
    expect(harness.store.getGoal(slowGoal.slug)).toBeUndefined();
  });

  it("caps huge probe output in the report", async () => {
    const goal = harness.createGoal({
      objective: "big output",
      criteria: [
        {
          description: "lots of text",
          probe: { kind: "command", run: "head -c 100000 /dev/zero | tr '\\0' 'x'", parse: "text" },
          assert: { op: "len_gte", value: 100000 },
        },
      ],
    });
    const report = await harness.assess(goal.slug);
    expect(report.converged).toBe(true);
    expect(JSON.stringify(report.criteria[0].actual).length).toBeLessThan(3000);
    expect(String(report.criteria[0].actual)).toContain("truncated");
  });
});

describe("workflow suggestions", () => {
  it("suggests workflows from similar converged goals", async () => {
    const state = join(dir, "deploy.txt");
    writeFileSync(state, "deployed");
    const done = harness.createGoal({
      objective: "deploy the payment service to production",
      criteria: [
        {
          description: "marker says deployed",
          probe: { kind: "command", run: `cat ${state}`, parse: "text" },
          assert: { op: "eq", value: "deployed" },
        },
      ],
    });
    harness.recordAction(done.slug, { summary: "run terraform apply" });
    harness.recordAction(done.slug, { summary: "verify health endpoint" });
    await harness.assess(done.slug);

    const similar = harness.createGoal({
      objective: "deploy the billing service to production",
      criteria: [
        {
          description: "never passes",
          probe: { kind: "command", run: "echo no", parse: "text" },
          assert: { op: "eq", value: "yes" },
        },
      ],
    });
    const report = await harness.assess(similar.slug);
    expect(report.suggestedWorkflows).toHaveLength(1);
    expect(report.suggestedWorkflows[0].slug).toBe(done.slug);
    expect(report.guidance).toContain("run terraform apply");
  });
});
