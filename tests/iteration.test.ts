import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stringify } from "yaml";
import { describe, expect, it } from "vitest";

import {
  checkpointIteration,
  currentIterationInstruction,
  readIteration,
  readIterationEvents,
  startIteration,
} from "../src/iteration.js";

function fixture(options: { fixed?: boolean; humanReview?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "keyoku-iteration-test-"));
  mkdirSync(join(root, ".keyoku", "outcomes"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".keyoku/runtime/\n.keyoku/contributions/\n");
  writeFileSync(join(root, "state.txt"), options.fixed ? "fixed\n" : "broken\n");
  writeFileSync(join(root, ".keyoku", "project.yaml"), stringify({
    schemaVersion: "keyoku.dev/project/v1alpha1",
    id: "iteration-fixture",
    name: "Iteration fixture",
    summary: "Synthetic behavior loop",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  }));
  writeFileSync(join(root, ".keyoku", "outcomes", "behavior.yaml"), stringify({
    schemaVersion: "keyoku.dev/outcome/v1alpha1",
    id: "behavior",
    revision: 1,
    title: "Observed behavior is fixed",
    objective: "The product exposes the intended fixed behavior.",
    owner: { kind: "human", id: "owner", name: "Owner", role: "accountable owner" },
    constraints: ["Do not edit generated proof output."],
    criteria: [{
      description: "The state file reports fixed",
      probe: { kind: "command", run: "node -e \"process.exit(require('fs').readFileSync('state.txt','utf8').trim()==='fixed'?0:1)\"", parse: "text", timeoutMs: 30_000 },
      assert: { path: "exitCode", op: "eq", value: 0 },
    }],
    humanCriteria: options.humanReview ? [{ id: "visual-review", description: "The interaction is clear to a human" }] : [],
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

describe("behavior iteration", () => {
  it("turns failed proof into an instruction, then stops on exact-source success", async () => {
    const root = fixture();
    const started = await startIteration({ root, outcomeId: "behavior", limits: { maxRounds: 3 } });
    expect(started.status).toBe("awaiting_agent");
    expect(started.rounds).toHaveLength(1);
    expect(started.rounds[0]?.automated).toMatchObject({ passed: 0, total: 1, verified: false });
    expect(started.currentInstruction?.failedClaims[0]).toMatchObject({ index: 0, description: "The state file reports fixed" });
    expect(started.currentInstruction?.checkpoint).toContain(started.id);

    writeFileSync(join(root, "state.txt"), "fixed\n");
    const completed = await checkpointIteration({
      root,
      sessionId: started.id,
      checkpointId: "repair-1",
      summary: "Changed the observable fixture state.",
      usage: { inputTokens: 120, outputTokens: 30, toolCalls: 2, costUsd: 0.012 },
      usageSource: "provider_receipt",
    });
    expect(completed.status).toBe("ready_for_review");
    expect(completed.rounds).toHaveLength(2);
    expect(completed.rounds[1]?.automated).toMatchObject({ passed: 1, total: 1, verified: true });
    expect(completed.usage).toMatchObject({ inputTokens: 120, outputTokens: 30, toolCalls: 2, costUsd: 0.012 });
    expect(completed.currentInstruction).toBeUndefined();

    const replay = await checkpointIteration({
      root,
      sessionId: started.id,
      checkpointId: "repair-1",
      summary: "Changed the observable fixture state.",
      usage: { inputTokens: 120, outputTokens: 30, toolCalls: 2, costUsd: 0.012 },
      usageSource: "provider_receipt",
    });
    expect(replay.rounds).toHaveLength(2);
    expect(replay.checkpoints).toHaveLength(1);
    expect(readIterationEvents(root, started.id).map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    await expect(checkpointIteration({
      root,
      sessionId: started.id,
      checkpointId: "repair-1",
      summary: "Conflicting duplicate",
    })).rejects.toThrow("idempotency conflict");
  });

  it("stops repeated no-change checkpoints instead of looping forever", async () => {
    const root = fixture();
    const started = await startIteration({ root, outcomeId: "behavior", limits: { maxRounds: 5, maxNoProgressRounds: 1 } });
    const stopped = await checkpointIteration({ root, sessionId: started.id, checkpointId: "no-change-1", summary: "No source change was made." });
    expect(stopped.status).toBe("stopped_no_progress");
    expect(stopped.rounds[1]?.noProgressRounds).toBe(1);
    expect(stopped.stopReason).toContain("no source change");
  });

  it("enforces reported cost ceilings and labels the usage source", async () => {
    const root = fixture();
    const started = await startIteration({ root, outcomeId: "behavior", limits: { maxRounds: 5, maxCostUsd: 0.01 } });
    const stopped = await checkpointIteration({
      root,
      sessionId: started.id,
      checkpointId: "cost-limit",
      summary: "Provider receipt reached the configured ceiling.",
      usage: { costUsd: 0.01 },
      usageSource: "provider_receipt",
    });
    expect(stopped.status).toBe("stopped_cost_limit");
    expect(stopped.checkpoints[0]?.usageSource).toBe("provider_receipt");
    expect(stopped.stopReason).toContain("$0.010000");
  });

  it("stops for accountable human judgment even after machine evidence passes", async () => {
    const root = fixture({ fixed: true, humanReview: true });
    const state = await startIteration({ root, outcomeId: "behavior" });
    expect(state.status).toBe("human_review_required");
    expect(state.rounds[0]?.automated.verified).toBe(true);
    expect(state.rounds[0]?.humanReview.pending).toBe(1);
    expect(currentIterationInstruction(root, state.id)).toBeUndefined();
  });

  it("fails closed when the append-only event ledger is tampered", async () => {
    const root = fixture();
    const started = await startIteration({ root, outcomeId: "behavior" });
    const path = join(root, ".keyoku", "runtime", "iterations", started.id, "events.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const first = JSON.parse(lines[0]!);
    first.payload.limits.maxRounds = 99;
    lines[0] = JSON.stringify(first);
    writeFileSync(path, `${lines.join("\n")}\n`);
    expect(() => readIteration(root, started.id)).toThrow("ledger digest mismatch");
  });
});
