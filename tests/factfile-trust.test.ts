import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stringify } from "yaml";
import { describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../src/canonical-json.js";
import {
  initProject,
  listFactfileHistory,
  publishFactfile,
  readVerifiedFactfile,
  reviewContribution,
  runGate,
  startContribution,
  type GateSnapshot,
} from "../src/contribution.js";

async function fixture(): Promise<{ root: string; contributionId: string; path: string; snapshot: GateSnapshot }> {
  const root = mkdtempSync(join(tmpdir(), "keyoku-factfile-trust-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "owner@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Owner"], { cwd: root });
  writeFileSync(join(root, "README.md"), "# Trust fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  initProject({ root, name: "Trust fixture" });
  const timestamp = "2026-08-25T12:00:00.000Z";
  writeFileSync(join(root, ".keyoku", "outcomes", "trusted-snapshot.yaml"), stringify({
    schemaVersion: "keyoku.dev/outcome/v1alpha1",
    id: "trusted-snapshot",
    revision: 1,
    title: "The Factfile is complete",
    objective: "Generate one complete source-bound Factfile.",
    owner: { kind: "human", id: "owner@example.com", name: "Owner" },
    constraints: [],
    criteria: [{
      description: "A structured observation passes",
      probe: { kind: "command", run: "node -e \"console.log(JSON.stringify({Z:1,a:2,'Á':3,'ä':4,'あ':5,'😀':6}))\"", parse: "json" },
      assert: { path: "output.a", op: "eq", value: 2 },
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
  }), "utf8");
  const contribution = startContribution({ root, outcomeId: "trusted-snapshot" });
  const snapshot = await runGate(root, contribution.id);
  return {
    root,
    contributionId: contribution.id,
    path: join(root, ".keyoku", "contributions", contribution.id, "factfile.json"),
    snapshot,
  };
}

function readObject(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeResigned(path: string, value: Record<string, unknown>): void {
  const { digest: _oldDigest, ...unsigned } = value;
  writeFileSync(path, `${JSON.stringify({ ...unsigned, digest: canonicalJsonDigest(unsigned) }, null, 2)}\n`, "utf8");
}

describe("strict Factfile trust boundary", () => {
  it("accepts a complete generated snapshot and rejects duplicate keys or byte tampering", async () => {
    const { path, snapshot } = await fixture();
    expect(readVerifiedFactfile(path)).toMatchObject({ id: snapshot.id, digest: snapshot.digest });

    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace('  "state": "ready_for_review",', '  "state": "ready_for_review",\n  "state": "accepted",'), "utf8");
    expect(() => readVerifiedFactfile(path)).toThrow(/duplicate object key "state"/);

    writeFileSync(path, original, "utf8");
    const changed = readObject(path);
    changed.project = { ...(changed.project as Record<string, unknown>), summary: "tampered without a new digest" };
    writeFileSync(path, `${JSON.stringify(changed)}\n`, "utf8");
    expect(() => readVerifiedFactfile(path)).toThrow(/digest mismatch/);
  });

  it("rejects re-signed state and evidence contradictions", async () => {
    const stateFixture = await fixture();
    const state = readObject(stateFixture.path);
    state.state = "accepted";
    state.contribution = { ...(state.contribution as Record<string, unknown>), status: "accepted" };
    writeResigned(stateFixture.path, state);
    expect(() => readVerifiedFactfile(stateFixture.path)).toThrow(/accepted requires a human acceptance event/);

    const evidenceFixture = await fixture();
    const evidence = readObject(evidenceFixture.path);
    const items = evidence.evidence as Array<Record<string, unknown>>;
    items[0] = { ...items[0], pass: false };
    writeResigned(evidenceFixture.path, evidence);
    expect(() => readVerifiedFactfile(evidenceFixture.path)).toThrow(/must equal passing evidence count/);
  });

  it("rejects a re-signed source identity that no longer matches the repository", async () => {
    const { root, contributionId, path } = await fixture();
    const value = readObject(path);
    value.repository = { ...(value.repository as Record<string, unknown>), worktreeDigest: "c".repeat(64) };
    writeResigned(path, value);

    expect(() => reviewContribution({
      root,
      contributionId,
      decision: "note",
      comment: "This must not attach to a forged source identity.",
    })).toThrow(/repository changed/);
  });

  it("rejects re-signed review tampering and invalid historical snapshots", async () => {
    const reviewedFixture = await fixture();
    reviewContribution({
      root: reviewedFixture.root,
      contributionId: reviewedFixture.contributionId,
      decision: "accepted",
      comment: "Accept the exact source.",
    });
    const reviewed = readObject(reviewedFixture.path);
    const reviews = reviewed.reviews as Array<Record<string, unknown>>;
    reviews[0] = {
      ...reviews[0],
      reviewer: { ...(reviews[0]!.reviewer as Record<string, unknown>), kind: "agent" },
    };
    writeResigned(reviewedFixture.path, reviewed);
    expect(() => readVerifiedFactfile(reviewedFixture.path)).toThrow(/reviewer must be a human/);

    const historyFixture = await fixture();
    const historicalPath = join(historyFixture.root, ".keyoku", "contributions", historyFixture.contributionId, "snapshots", `${historyFixture.snapshot.id}.json`);
    const historical = readObject(historicalPath);
    historical.project = { ...(historical.project as Record<string, unknown>), summary: "tampered history" };
    writeFileSync(historicalPath, `${JSON.stringify(historical)}\n`, "utf8");
    expect(() => listFactfileHistory(historyFixture.root, historyFixture.contributionId)).toThrow(/digest mismatch/);
  });

  it("blocks publication before network I/O when the current Factfile is tampered", async () => {
    const { root, contributionId, path } = await fixture();
    const value = readObject(path);
    value.project = { ...(value.project as Record<string, unknown>), summary: "tampered publish" };
    writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
    await expect(publishFactfile(root, contributionId, "http://127.0.0.1:1")).rejects.toThrow(/digest mismatch/);
  });
});
