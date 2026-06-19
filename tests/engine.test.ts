import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConnectorManager } from "../src/connectors.js";
import { Harness, autoRecordToFocusGoal, type CreateGoalInput } from "../src/engine.js";
import { Store } from "../src/store.js";
import type { SlmProvider } from "../src/slm.js";
import type { ActivityEvent } from "../src/types.js";

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

  it("build-then-verify: a goal that converges with no records promotes no hollow workflow, but retroactive records become muscle memory", async () => {
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
    // Converges on the first assess with nothing recorded: no hollow workflow,
    // and the guidance nudges the agent to record what it did.
    const conv = await harness.assess(goal.slug);
    expect(conv.converged).toBe(true);
    expect(harness.store.listWorkflows()).toHaveLength(0);
    expect(conv.guidance).toMatch(/goal_record/);

    // Retroactive record is ACCEPTED (not thrown), does not spend the budget,
    // keeps the goal converged, and promotes the workflow with the captured step.
    const before = harness.getGoal(goal.slug).usedIterations;
    const { goal: after } = harness.recordAction(goal.slug, {
      summary: "Did the real work",
      tool: "Bash",
    });
    expect(after.usedIterations).toBe(before); // retroactive: no budget spent
    expect(after.status).toBe("converged");
    const workflows = harness.store.listWorkflows();
    expect(workflows).toHaveLength(1);
    expect(workflows[0].steps.map((s) => s.summary)).toEqual(["Did the real work"]);
  });

  it("build-then-verify with activity: an empty trace backfills steps from the activity log", async () => {
    const goal = harness.createGoal({
      objective: "activity backfill works",
      criteria: [
        {
          description: "echo ok",
          probe: { kind: "command", run: "echo ok", parse: "text" },
          assert: { op: "eq", value: "ok" },
        },
      ],
    });
    let seq = 0;
    const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({
      id: `e${seq++}`,
      type: "tool_use",
      summary: "x",
      at: new Date().toISOString(),
      ...over,
    });
    // Real work — must be captured, in order:
    harness.store.appendActivity(ev({ type: "file_change", tool: "Edit", summary: "Edit: src/server.ts" }));
    harness.store.appendActivity(ev({ type: "shell", tool: "Bash", summary: "Bash: npm run build", detail: "npm run build" }));
    // Noise — must be excluded:
    harness.store.appendActivity(ev({ tool: "Read", summary: "Read: src/server.ts" })); // inspection
    harness.store.appendActivity(ev({ type: "shell", tool: "Bash", summary: "Bash: ls -la", detail: "ls -la" })); // inspection cmd
    harness.store.appendActivity(ev({ tool: "mcp__keyoku__goal_assess", summary: "assessed" })); // harness bookkeeping
    // Out of the goal's lifetime — must be excluded by the time window:
    harness.store.appendActivity(ev({ type: "file_change", tool: "Edit", summary: "Edit: old.ts", at: "2000-01-01T00:00:00.000Z" }));

    const conv = await harness.assess(goal.slug);
    expect(conv.converged).toBe(true);
    const wf = harness.store.getWorkflow(goal.slug);
    expect(wf).toBeTruthy();
    expect(wf?.steps.map((s) => s.summary)).toEqual(["Edit: src/server.ts", "Bash: npm run build"]);
    expect(wf?.steps.every((s) => s.source === "activity")).toBe(true);
    // The actual command is carried so the learned step is replayable, not just described.
    expect(wf?.steps.find((s) => s.tool === "Bash")?.detail).toBe("npm run build");
  });

  it("backfill looks back before goal creation and scopes to the dominant session", async () => {
    // The agent did the work, THEN declared + converged the goal (tiny lifetime).
    const goal = harness.createGoal({
      objective: "lookback and session scoping",
      criteria: [
        {
          description: "echo ok",
          probe: { kind: "command", run: "echo ok", parse: "text" },
          assert: { op: "eq", value: "ok" },
        },
      ],
    });
    const created = Date.parse(harness.getGoal(goal.slug).createdAt);
    const at = (deltaMs: number): string => new Date(created + deltaMs).toISOString();
    let seq = 0;
    const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({
      id: `e${seq++}`,
      type: "tool_use",
      summary: "x",
      at: at(0),
      ...over,
    });
    // Pre-goal work in the focus session s1, inside the lookback — MUST be captured:
    harness.store.appendActivity(ev({ type: "file_change", tool: "Edit", summary: "Edit: src/early.ts", sessionId: "s1", at: at(-5 * 60_000) }));
    // In-window work, same session — MUST be captured:
    harness.store.appendActivity(ev({ type: "shell", tool: "Bash", summary: "Bash: npm run build", detail: "npm run build", sessionId: "s1", at: at(-1_000) }));
    // Concurrent OTHER session — MUST be excluded by session scoping:
    harness.store.appendActivity(ev({ type: "file_change", tool: "Edit", summary: "Edit: other/project.ts", sessionId: "s2", at: at(-2_000) }));
    // Before the lookback window — MUST be excluded by time:
    harness.store.appendActivity(ev({ type: "file_change", tool: "Edit", summary: "Edit: ancient.ts", sessionId: "s1", at: at(-120 * 60_000) }));

    const conv = await harness.assess(goal.slug);
    expect(conv.converged).toBe(true);
    const wf = harness.store.getWorkflow(goal.slug);
    expect(wf?.steps.map((s) => s.summary)).toEqual(["Edit: src/early.ts", "Bash: npm run build"]);
  });

  it("backfill scopes to the dominant cwd-subtree within the session", async () => {
    const goal = harness.createGoal({
      objective: "cwd scoping",
      criteria: [
        {
          description: "echo ok",
          probe: { kind: "command", run: "echo ok", parse: "text" },
          assert: { op: "eq", value: "ok" },
        },
      ],
    });
    const created = Date.parse(harness.getGoal(goal.slug).createdAt);
    const at = (deltaMs: number): string => new Date(created + deltaMs).toISOString();
    let seq = 0;
    const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({
      id: `e${seq++}`,
      type: "tool_use",
      summary: "x",
      at: at(-1_000),
      sessionId: "s1",
      ...over,
    });
    // Dominant project /proj-a (2 events) + a subdir of it — all MUST be kept:
    harness.store.appendActivity(ev({ type: "file_change", tool: "Edit", summary: "Edit: a1.ts", cwd: "/proj-a", at: at(-5_000) }));
    harness.store.appendActivity(ev({ type: "file_change", tool: "Edit", summary: "Edit: a2.ts", cwd: "/proj-a", at: at(-4_000) }));
    harness.store.appendActivity(ev({ type: "shell", tool: "Bash", summary: "Bash: build a", detail: "make", cwd: "/proj-a/sub", at: at(-3_000) }));
    // Sibling project /proj-b — MUST be dropped:
    harness.store.appendActivity(ev({ type: "file_change", tool: "Edit", summary: "Edit: b1.ts", cwd: "/proj-b", at: at(-2_000) }));
    // No cwd — unattributable, MUST be kept:
    harness.store.appendActivity(ev({ type: "shell", tool: "Bash", summary: "Bash: no cwd step", detail: "node deploy.js", at: at(-1_500) }));

    const conv = await harness.assess(goal.slug);
    expect(conv.converged).toBe(true);
    const summaries = harness.store.getWorkflow(goal.slug)?.steps.map((s) => s.summary) ?? [];
    expect(summaries).toEqual(["Edit: a1.ts", "Edit: a2.ts", "Bash: build a", "Bash: no cwd step"]);
    expect(summaries).not.toContain("Edit: b1.ts");
  });

  it("backfill keeps first-N setup steps and the recent tail when capped", async () => {
    const goal = harness.createGoal({
      objective: "head tail cap",
      criteria: [
        {
          description: "echo ok",
          probe: { kind: "command", run: "echo ok", parse: "text" },
          assert: { op: "eq", value: "ok" },
        },
      ],
    });
    const created = Date.parse(harness.getGoal(goal.slug).createdAt);
    for (let i = 0; i < 50; i++) {
      harness.store.appendActivity({
        id: `e${i}`,
        type: "shell",
        tool: "Bash",
        summary: `Bash: step ${String(i).padStart(2, "0")}`,
        detail: `cmd ${i}`,
        sessionId: "s1",
        at: new Date(created - (50 - i) * 1_000).toISOString(),
      });
    }
    const conv = await harness.assess(goal.slug);
    expect(conv.converged).toBe(true);
    const steps = harness.store.getWorkflow(goal.slug)?.steps ?? [];
    expect(steps.length).toBe(31); // 30 cap + 1 omission marker
    expect(steps[0].summary).toBe("Bash: step 00"); // setup preserved
    expect(steps[7].summary).toBe("Bash: step 07");
    expect(steps.some((s) => /omitted/.test(s.summary))).toBe(true);
    expect(steps[steps.length - 1].summary).toBe("Bash: step 49"); // recent tail
  });

  it("muscle memory is REUSED — a similar goal gets the converged workflow suggested", async () => {
    const stateA = join(dir, "a.txt");
    writeFileSync(stateA, "ready");
    const a = harness.createGoal(
      fileGoal(stateA, { objective: "make the deploy pipeline green", slug: "deploy-green" }),
    );
    await harness.assess(a.slug); // converges (build-then-verify)
    harness.recordAction(a.slug, { summary: "Bumped the node version in CI", tool: "Edit" });

    const stateB = join(dir, "b.txt");
    writeFileSync(stateB, "nope");
    const b = harness.createGoal(
      fileGoal(stateB, { objective: "make the deploy pipeline pass", slug: "deploy-pass" }),
    );
    const report = await harness.assess(b.slug);
    expect(report.converged).toBe(false);
    expect(report.suggestedWorkflows.map((s) => s.slug)).toContain("deploy-green");
    expect(report.guidance).toContain("Bumped the node version in CI");
  });

  it("captures failed approaches as pitfalls and surfaces them to similar goals", async () => {
    const state = join(dir, "p.txt");
    writeFileSync(state, "ready");
    const g = harness.createGoal(
      fileGoal(state, { objective: "fix the flaky auth test", slug: "fix-flaky-auth" }),
    );
    harness.recordAction(g.slug, { summary: "Tried bumping the timeout", result: "failure" });
    harness.recordAction(g.slug, {
      summary: "Pinned the system clock",
      result: "success",
      tool: "Edit",
    });
    await harness.assess(g.slug); // converges with one failure + one success recorded

    const wf = harness.store.getWorkflow("fix-flaky-auth");
    expect(wf?.steps.map((s) => s.summary)).toEqual(["Pinned the system clock"]);
    expect(wf?.pitfalls).toEqual(["Tried bumping the timeout"]);

    const state2 = join(dir, "p2.txt");
    writeFileSync(state2, "nope");
    const g2 = harness.createGoal(
      fileGoal(state2, {
        objective: "fix the flaky auth integration test",
        slug: "fix-flaky-auth-2",
      }),
    );
    const report = await harness.assess(g2.slug);
    expect(report.guidance).toContain("avoid (failed before): Tried bumping the timeout");
  });

  it("SLM re-rank: default-on when a model is present, cached across assesses; KEYOKU_SLM_SUGGEST=0 disables", async () => {
    const conv = [
      {
        description: "echo",
        probe: { kind: "command" as const, run: "echo ok", parse: "text" as const },
        assert: { op: "eq" as const, value: "ok" },
      },
    ];
    const seed = async (slug: string, objective: string) => {
      harness.createGoal({ objective, slug, criteria: conv });
      harness.recordAction(slug, { summary: `did ${slug}`, tool: "Bash" });
      await harness.assess(slug);
    };
    await seed("deploy-staging", "deploy the staging service to kubernetes");
    await seed("deploy-api-staging", "deploy the staging api to kubernetes");

    // a query that stays unmet so suggestions surface
    harness.createGoal({
      objective: "deploy the production service to kubernetes",
      slug: "deploy-prod",
      criteria: [
        {
          description: "nope",
          probe: { kind: "command", run: "echo nope", parse: "text" },
          assert: { op: "eq", value: "ok" },
        },
      ],
    });

    // baseline: no SLM → deterministic jaccard returns both candidates
    const baseline = await harness.assess("deploy-prod");
    expect(baseline.suggestedWorkflows.length).toBeGreaterThanOrEqual(2);
    const candidate2 = baseline.suggestedWorkflows[1].slug;

    // A lite model that selects ONLY candidate #2. Re-rank is ON BY DEFAULT when a
    // model is present (no flag needed). `calls` proves the result is cached.
    delete process.env.KEYOKU_SLM_SUGGEST;
    let calls = 0;
    const fakeSlm: SlmProvider = {
      name: "fake",
      model: "fake",
      async complete() {
        calls++;
        return JSON.stringify({ relevant: [2] });
      },
    };
    const slmHarness = new Harness(harness.store, new ConnectorManager(harness.store), fakeSlm);

    const first = await slmHarness.assess("deploy-prod");
    expect(first.suggestedWorkflows.map((s) => s.slug)).toEqual([candidate2]);
    expect(calls).toBe(1);

    // cached: a second assess of the same goal + candidate set does NOT re-call the model
    const second = await slmHarness.assess("deploy-prod");
    expect(second.suggestedWorkflows.map((s) => s.slug)).toEqual([candidate2]);
    expect(calls).toBe(1);

    // explicit opt-out → deterministic jaccard order
    process.env.KEYOKU_SLM_SUGGEST = "0";
    try {
      const off = await slmHarness.assess("deploy-prod");
      expect(off.suggestedWorkflows.length).toBeGreaterThanOrEqual(2);
    } finally {
      delete process.env.KEYOKU_SLM_SUGGEST;
    }
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

describe("semantic recall (model surfaces what lexical overlap can't)", () => {
  const mk = async (slug: string, objective: string, step: string) => {
    harness.createGoal({
      objective,
      slug,
      criteria: [
        { description: "ok", probe: { kind: "command", run: "echo ready", parse: "text" }, assert: { op: "contains", value: "ready" } },
      ],
    });
    harness.recordAction(slug, { summary: step });
    await harness.assess(slug);
  };

  it("fires for a semantically-related goal whose wording barely overlaps", async () => {
    await mk("k8s-ingress-tls", "provision kubernetes ingress with cert-manager TLS", "kubectl apply ingress");
    await mk("db-backup-rotate", "rotate the database backup snapshots nightly", "run pg_dump cron");

    // Worded so differently that jaccard is below the floor for BOTH workflows.
    const goal = harness.createGoal({
      objective: "expose the service securely over HTTPS for the cluster",
      slug: "https-expose",
      criteria: [
        { description: "n/a", probe: { kind: "command", run: "echo no", parse: "text" }, assert: { op: "eq", value: "yes" } },
      ],
    });

    // Deterministic path: lexical overlap filters everything out.
    expect(harness.suggestWorkflows(goal)).toHaveLength(0);
    expect(await harness.suggestRelevant(goal)).toHaveLength(0);

    // With a lite model, semantic recall surfaces a workflow despite ~zero token overlap.
    const fakeSlm: SlmProvider = {
      name: "fake",
      model: "fake",
      async complete() {
        return JSON.stringify({ relevant: [1] });
      },
    };
    const slmH = new Harness(harness.store, new ConnectorManager(harness.store), fakeSlm);
    const picked = await slmH.suggestRelevant(goal);
    expect(picked).toHaveLength(1);
    expect(["k8s-ingress-tls", "db-backup-rotate"]).toContain(picked[0].slug);
  });

  it("surfaces candidates for the AGENT to judge with NO model (zero-dependency recall)", async () => {
    await mk("k8s-ingress-tls", "provision kubernetes ingress with cert-manager TLS", "kubectl apply ingress");
    // Worded so jaccard stays below the floor (shares only 'kubernetes').
    const goal = harness.createGoal({
      objective: "secure the kubernetes service endpoints",
      slug: "secure-cluster",
      criteria: [
        { description: "n/a", probe: { kind: "command", run: "echo no", parse: "text" }, assert: { op: "eq", value: "yes" } },
      ],
    });
    const report = await harness.assess(goal.slug); // harness has NO model
    expect(report.suggestedWorkflows).toHaveLength(0); // deterministic floor filters it out
    expect(report.candidateWorkflows.map((c) => c.slug)).toContain("k8s-ingress-tls"); // but the agent gets it
    expect(report.guidance).toContain("YOU judge relevance");
  });
});

describe("self-pruning (precision-ranked suggestions)", () => {
  // Converge a goal that records `steps`. The echo probe passes immediately, so
  // a single assess promotes the recorded trace and runs outcome scoring.
  const convergeWith = async (objective: string, steps: string[]): Promise<string> => {
    const g = harness.createGoal({
      objective,
      criteria: [
        {
          description: "ok",
          probe: { kind: "command", run: "echo ready", parse: "text" },
          assert: { op: "contains", value: "ready" },
        },
      ],
    });
    for (const s of steps) harness.recordAction(g.slug, { summary: s });
    await harness.assess(g.slug);
    return g.slug;
  };

  it("downranks a relevant workflow whose steps never actually recur", async () => {
    const RECUR = "restart the shared service daemon";
    // Two workflows topically relevant to the same family of goals; only
    // `useful`'s step is the one that keeps recurring in later work.
    const useful = await convergeWith("configure widget useful alpha beta gamma", [RECUR]);
    const noisy = await convergeWith("configure widget noisy alpha beta gamma", ["edit the alpha config file"]);

    // Later goals — topically near both, but token-disjoint from the final probe
    // — each re-run the recurring step, imprinting precision: useful helps, noisy
    // never does.
    for (const n of ["one", "two", "three"]) {
      await convergeWith(`alpha beta gamma tuning ${n}`, [RECUR]);
    }

    const u = harness.store.getWorkflow(useful)!;
    const x = harness.store.getWorkflow(noisy)!;
    expect(u.stats.helped ?? 0).toBeGreaterThanOrEqual(3);
    expect(u.stats.suggested ?? 0).toBeGreaterThanOrEqual(3);
    expect(x.stats.suggested ?? 0).toBeGreaterThanOrEqual(3);
    expect(x.stats.helped ?? 0).toBe(0);

    // A fresh goal relevant to BOTH (the "tuning" workflows are token-disjoint
    // from it, so only useful/noisy are eligible). Precision ranks the workflow
    // that actually recurred ahead of the one that only ever word-matched.
    const probe = harness.createGoal({
      objective: "configure widget delta",
      criteria: [
        { description: "n/a", probe: { kind: "command", run: "echo no", parse: "text" }, assert: { op: "eq", value: "yes" } },
      ],
    });
    const ranked = harness.suggestWorkflows(probe).map((s) => s.slug);
    expect(ranked[0]).toBe(useful);
    expect(ranked.indexOf(useful)).toBeLessThan(ranked.indexOf(noisy));

    // Opting out (KEYOKU_WF_SELF_PRUNE=0) restores pure jaccard: equal similarity,
    // so the precision-based reordering no longer applies.
    process.env.KEYOKU_WF_SELF_PRUNE = "0";
    try {
      const u2 = harness.suggestWorkflows(probe).find((s) => s.slug === useful);
      const x2 = harness.suggestWorkflows(probe).find((s) => s.slug === noisy);
      expect(u2?.similarity).toBeCloseTo(x2?.similarity ?? -1, 5);
    } finally {
      delete process.env.KEYOKU_WF_SELF_PRUNE;
    }
  });
});

describe("live capture (goal_focus + auto-record)", () => {
  const echoGoal = (objective: string): CreateGoalInput => ({
    objective,
    criteria: [
      {
        description: "echo ok",
        probe: { kind: "command", run: "echo ok", parse: "text" },
        assert: { op: "eq", value: "ok" },
      },
    ],
  });
  let seq = 0;
  const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({
    id: `ev${seq++}`,
    type: "tool_use",
    summary: "x",
    at: new Date().toISOString(),
    ...over,
  });

  it("captures real actions into the focused goal's trace, ignoring noise and out-of-scope work", () => {
    const goal = harness.createGoal(echoGoal("live capture"));
    harness.setFocus(goal.slug, { cwd: "/proj-a" });

    autoRecordToFocusGoal(harness.store, ev({ type: "file_change", tool: "Edit", summary: "Edit: a.ts", cwd: "/proj-a" }));
    autoRecordToFocusGoal(harness.store, ev({ type: "shell", tool: "Bash", summary: "Bash: make", detail: "make", cwd: "/proj-a/sub" })); // subdir kept
    autoRecordToFocusGoal(harness.store, ev({ tool: "Read", summary: "Read: a.ts", cwd: "/proj-a" })); // inspection — ignored
    autoRecordToFocusGoal(harness.store, ev({ type: "shell", tool: "Bash", summary: "Bash: ls", detail: "ls -la", cwd: "/proj-a" })); // inspection cmd — ignored
    autoRecordToFocusGoal(harness.store, ev({ tool: "mcp__keyoku__goal_assess", summary: "assess", cwd: "/proj-a" })); // bookkeeping — ignored
    autoRecordToFocusGoal(harness.store, ev({ type: "file_change", tool: "Edit", summary: "Edit: other.ts", cwd: "/proj-b" })); // wrong project — ignored

    const recs = harness.store.listRecords(goal.id);
    expect(recs.map((r) => r.summary)).toEqual(["Edit: a.ts", "Bash: make"]);
    expect(recs.every((r) => r.source === "activity")).toBe(true);
    // Auto-records must NOT spend the corrective-iteration budget.
    expect(harness.getGoal(goal.slug).usedIterations).toBe(0);
  });

  it("dedups the immediately repeated action", () => {
    const goal = harness.createGoal(echoGoal("dedup"));
    harness.setFocus(goal.slug, { cwd: "/p" });
    autoRecordToFocusGoal(harness.store, ev({ type: "file_change", tool: "Edit", summary: "Edit: x.ts", cwd: "/p" }));
    autoRecordToFocusGoal(harness.store, ev({ type: "file_change", tool: "Edit", summary: "Edit: x.ts", cwd: "/p" }));
    expect(harness.store.listRecords(goal.id)).toHaveLength(1);
  });

  it("a focused goal that converges promotes a workflow from live steps and clears focus", async () => {
    const goal = harness.createGoal(echoGoal("focus converge"));
    harness.setFocus(goal.slug, { cwd: "/p" });
    autoRecordToFocusGoal(harness.store, ev({ type: "shell", tool: "Bash", summary: "Bash: build", detail: "make", cwd: "/p" }));

    const conv = await harness.assess(goal.slug);
    expect(conv.converged).toBe(true);
    const wf = harness.store.getWorkflow(goal.slug);
    expect(wf?.steps.map((s) => s.summary)).toEqual(["Bash: build"]);
    expect(wf?.steps.every((s) => s.source === "activity")).toBe(true);
    expect(harness.getFocus()).toBeNull(); // cleared on convergence
  });

  it("learned steps carry the command (detail) so the workflow is replayable", async () => {
    const goal = harness.createGoal(echoGoal("replayable"));
    harness.setFocus(goal.slug, { cwd: "/p" });
    autoRecordToFocusGoal(
      harness.store,
      ev({ type: "shell", tool: "Bash", summary: "Bash: deploy", detail: "./deploy.sh --prod", cwd: "/p" }),
    );
    const conv = await harness.assess(goal.slug);
    expect(conv.converged).toBe(true);
    const wf = harness.store.getWorkflow(goal.slug);
    expect(wf?.steps[0].summary).toBe("Bash: deploy");
    expect(wf?.steps[0].detail).toBe("./deploy.sh --prod"); // the actual command, replayable
  });

  it("pins the session on first action so a concurrent same-project session can't contaminate", () => {
    const goal = harness.createGoal(echoGoal("pinning"));
    harness.setFocus(goal.slug, { cwd: "/p" }); // cwd-only focus, session unknown
    // s1 does the first matching action → recorded AND focus pins to s1
    autoRecordToFocusGoal(harness.store, ev({ type: "file_change", tool: "Edit", summary: "Edit: s1.ts", cwd: "/p", sessionId: "s1" }));
    expect(harness.getFocus()?.sessionId).toBe("s1");
    // s2, same project, different session → rejected now that focus is pinned
    autoRecordToFocusGoal(harness.store, ev({ type: "file_change", tool: "Edit", summary: "Edit: s2.ts", cwd: "/p", sessionId: "s2" }));
    // s1 again → still captured
    autoRecordToFocusGoal(harness.store, ev({ type: "shell", tool: "Bash", summary: "Bash: t", detail: "make", cwd: "/p", sessionId: "s1" }));
    expect(harness.store.listRecords(goal.id).map((r) => r.summary)).toEqual(["Edit: s1.ts", "Bash: t"]);
  });

  it("refuses to focus a non-active goal", () => {
    const goal = harness.createGoal(echoGoal("inactive"));
    harness.updateGoal(goal.slug, { status: "abandoned" });
    expect(() => harness.setFocus(goal.slug)).toThrow(/active/);
  });
});

describe("repairWorkflows (backfill repair of hollow muscle memory)", () => {
  let seq2 = 0;
  const ev2 = (over: Partial<ActivityEvent>): ActivityEvent => ({
    id: `re${seq2++}`,
    type: "tool_use",
    summary: "x",
    at: new Date().toISOString(),
    ...over,
  });

  it("repopulates a hollow workflow from activity, without bumping convergences", async () => {
    // Work happens (and is logged to activity) BEFORE the goal is declared — the
    // build-then-verify shape that left real workflows hollow under old builds.
    harness.store.appendActivity(ev2({ type: "shell", tool: "Bash", summary: "Bash: npm ci", detail: "npm ci", cwd: dir, sessionId: "S1" }));
    harness.store.appendActivity(ev2({ type: "shell", tool: "Bash", summary: "Bash: npm run build", detail: "npm run build", cwd: dir, sessionId: "S1" }));

    const state = join(dir, "ok.txt");
    writeFileSync(state, "ready");
    const goal = harness.createGoal(fileGoal(state));
    await harness.assess(goal.slug); // converges
    // Simulate the LEGACY state: converged under an old build → hollow workflow.
    const w = harness.store.getWorkflow(goal.slug)!;
    w.steps = [];
    harness.store.saveWorkflow(w);
    const convBefore = harness.store.getWorkflow(goal.slug)!.stats.convergences;
    expect(harness.store.getWorkflow(goal.slug)!.steps).toHaveLength(0);

    const report = harness.repairWorkflows();
    expect(report.find((r) => r.slug === goal.slug)?.status).toBe("populated");
    const after = harness.store.getWorkflow(goal.slug)!;
    expect(after.steps.length).toBeGreaterThan(0);
    expect(after.stats.convergences).toBe(convBefore); // a repair, not a new convergence
  });

  it("dry-run does not write, and a workflow that already has steps is skipped", async () => {
    harness.store.appendActivity(ev2({ type: "shell", tool: "Bash", summary: "Bash: make", detail: "make", cwd: dir, sessionId: "S2" }));
    const state = join(dir, "ok2.txt");
    writeFileSync(state, "ready");
    const goal = harness.createGoal({ ...fileGoal(state), slug: "dry-goal" });
    await harness.assess(goal.slug);
    expect(harness.store.getWorkflow("dry-goal")!.steps.length).toBeGreaterThan(0);

    const report = harness.repairWorkflows({ dryRun: true });
    expect(report.find((r) => r.slug === "dry-goal")?.status).toBe("skipped");
  });
});
