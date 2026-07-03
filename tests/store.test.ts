import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newId, slugify, Store } from "../src/store.js";
import type { Goal } from "../src/types.js";

let dir: string;
let store: Store;

const goal = (overrides: Partial<Goal> = {}): Goal => ({
  id: newId("goal"),
  slug: "test-goal",
  objective: "test objective",
  criteria: [],
  constraints: [],
  autonomy: "suggest",
  maxIterations: 10,
  usedIterations: 0,
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  convergedAt: null,
  lastAssessedAt: null,
  ...overrides,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keyoku-store-"));
  store = new Store(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Store", () => {
  it("persists goals across instances", () => {
    const g = goal();
    store.saveGoal(g);
    const reloaded = new Store(dir);
    expect(reloaded.getGoal(g.slug)?.id).toBe(g.id);
    expect(reloaded.getGoal(g.id)?.slug).toBe(g.slug);
  });

  it("updates in place by id", () => {
    const g = goal();
    store.saveGoal(g);
    store.saveGoal({ ...g, status: "converged" });
    expect(store.listGoals()).toHaveLength(1);
    expect(store.getGoal(g.id)?.status).toBe("converged");
  });

  it("deletes goals and their records", () => {
    const g = goal();
    store.saveGoal(g);
    store.appendRecord({
      id: newId("act"),
      goalId: g.id,
      iteration: 1,
      summary: "did a thing",
      result: "success",
      at: new Date().toISOString(),
    });
    store.appendObservation({
      id: newId("obs"),
      goalId: g.id,
      goalSlug: g.slug,
      kind: "assessment",
      summary: "1/1 criteria unmet: c1",
      unmet: ["c1"],
      at: new Date().toISOString(),
    });
    expect(store.listRecords(g.id)).toHaveLength(1);
    expect(store.listObservations(g.id)).toHaveLength(1);
    expect(store.deleteGoal(g.id)).toBe(true);
    expect(store.getGoal(g.id)).toBeUndefined();
    expect(store.listRecords(g.id)).toHaveLength(0);
    expect(store.listObservations(g.id)).toHaveLength(0); // observations no longer orphaned
  });

  it("listAudit skips a torn/corrupt line instead of throwing", () => {
    const auditPath = join(dir, "audit.jsonl");
    const good = JSON.stringify({ id: "a", at: "2026-01-01T00:00:00Z", actor: "cli", op: "x", summary: "ok", ok: true });
    // A corrupt (unparseable) line sitting between valid ones — the reader must
    // skip it rather than throw and darken the whole trail.
    writeFileSync(auditPath, `${good}\n{"id":"torn","at":"2026\n`);
    store.appendAudit({ id: "after", at: "2026-06-18T00:00:00Z", actor: "agent", op: "y", summary: "z", ok: true });
    const entries = store.listAudit(10);
    expect(entries.some((e) => e.id === "a")).toBe(true);
    expect(entries.some((e) => e.id === "after")).toBe(true);
    expect(entries.some((e) => e.id === "torn")).toBe(false); // corrupt line dropped, not fatal
  });

  it("caps executions.json: keeps in-flight runs + most recent terminal ones", () => {
    const mkExec = (n: number, status: "done" | "running"): import("../src/types.js").WorkflowExecution => ({
      id: `exec_${n}`,
      templateId: "t",
      templateSlug: "t",
      status,
      steps: [],
      currentStep: 0,
      startedAt: new Date().toISOString(),
      triggeredBy: "on_demand",
    });
    for (let i = 0; i < 205; i++) store.saveExecution(mkExec(i, "done"));
    store.saveExecution(mkExec(9999, "running")); // an in-flight run
    const all = store.listExecutions();
    expect(all.filter((e) => e.status === "done").length).toBeLessThanOrEqual(200);
    expect(all.some((e) => e.id === "exec_9999")).toBe(true); // in-flight never dropped
    expect(all.some((e) => e.id === "exec_204")).toBe(true); // newest terminal kept
    expect(all.some((e) => e.id === "exec_0")).toBe(false); // oldest terminal evicted
  });

  it("appends and reads JSONL records in order", () => {
    const g = goal();
    store.saveGoal(g);
    for (let i = 1; i <= 3; i++) {
      store.appendRecord({
        id: newId("act"),
        goalId: g.id,
        iteration: i,
        summary: `step ${i}`,
        result: "success",
        at: new Date().toISOString(),
      });
    }
    expect(store.listRecords(g.id).map((r) => r.summary)).toEqual([
      "step 1",
      "step 2",
      "step 3",
    ]);
  });

  it("makes slugs unique", () => {
    store.saveGoal(goal({ slug: "deploy" }));
    expect(store.uniqueSlug("deploy")).toBe("deploy-2");
    store.saveGoal(goal({ slug: "deploy-2" }));
    expect(store.uniqueSlug("deploy")).toBe("deploy-3");
    expect(store.uniqueSlug("fresh")).toBe("fresh");
  });

  it("uniqueSlug also avoids surviving workflow slugs (deleted goals leave workflows behind)", () => {
    store.saveWorkflow({
      id: newId("wf"),
      slug: "deploy",
      objective: "old deploy goal",
      steps: [],
      criteria: [],
      stats: { convergences: 3, totalActions: 5 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(store.uniqueSlug("deploy")).toBe("deploy-2");
  });

  it("reads fresh from disk — two Store instances over the same dir see each other's writes", () => {
    const a = new Store(dir);
    const b = new Store(dir);
    const g1 = goal({ slug: "from-a" });
    const g2 = goal({ slug: "from-b" });
    a.saveGoal(g1);
    b.saveGoal(g2); // b must not clobber a's goal with a stale snapshot
    expect(a.listGoals().map((g) => g.slug).sort()).toEqual(["from-a", "from-b"]);
    expect(b.getGoal("from-a")).toBeDefined();

    // And an update through one instance is visible to the other immediately.
    g1.status = "converged";
    a.saveGoal(g1);
    expect(b.getGoal("from-a")?.status).toBe("converged");
  });

  it("creates the home dir 0700 and store files 0600", () => {
    const home = join(dir, "fresh-home");
    const fresh = new Store(home);
    fresh.saveGoal(goal());
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "goals.json")).mode & 0o777).toBe(0o600);
  });

  it("persists connectors and workflows", () => {
    store.saveConnector({
      name: "gh",
      transport: { type: "stdio", command: "gh-mcp" },
      addedAt: new Date().toISOString(),
    });
    store.saveWorkflow({
      id: newId("wf"),
      slug: "deploy",
      objective: "deploy the app",
      steps: [{ summary: "push", result: "success" }],
      criteria: ["app responds"],
      stats: { convergences: 1, totalActions: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const reloaded = new Store(dir);
    expect(reloaded.getConnector("gh")?.transport.type).toBe("stdio");
    expect(reloaded.getWorkflow("deploy")?.stats.convergences).toBe(1);
    expect(reloaded.deleteConnector("gh")).toBe(true);
    expect(reloaded.deleteConnector("gh")).toBe(false);
  });

  it("bounds the audit log once it crosses the size cap", () => {
    const auditPath = join(dir, "audit.jsonl");
    const line = JSON.stringify({ id: "old", at: "2026-01-01T00:00:00Z", actor: "cli", op: "x", summary: "y".repeat(160), ok: true });
    writeFileSync(auditPath, (line + "\n").repeat(7000)); // > 1 MB
    expect(statSync(auditPath).size).toBeGreaterThan(1_000_000);

    store.appendAudit({ id: "fresh", at: "2026-06-18T00:00:00Z", actor: "agent", op: "release", summary: "stable", ok: true });

    expect(statSync(auditPath).size).toBeLessThan(1_000_000); // trimmed
    expect(store.listAudit(10).some((e) => e.id === "fresh")).toBe(true); // newest kept
  });
});

describe("helpers", () => {
  it("slugify produces short stable handles", () => {
    expect(slugify("All prod Cloud Run services have min instances!")).toBe(
      "all-prod-cloud-run-services-have",
    );
    expect(slugify("???")).toBe("goal");
  });

  it("newId is unique across rapid calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId("x")));
    expect(ids.size).toBe(500);
  });
});
