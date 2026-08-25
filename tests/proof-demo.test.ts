import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runProofDemo } from "../src/proof-demo.js";

describe("proof demo", () => {
  it("runs a real exact-revision proof and leaves an inspectable repository", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "keyoku-proof-demo-test-")), "demo");
    const transcript: string[] = [];
    const result = await runProofDemo({ root, log: (line) => transcript.push(line) });

    expect(result.firstSnapshot.state).toBe("evidence_gaps");
    expect(result.firstSnapshot.summary).toMatchObject({ failed: 1, total: 1 });
    expect(result.snapshot.state).toBe("human_review_required");
    expect(result.snapshot.summary).toMatchObject({ passed: 1, total: 1 });
    expect(result.snapshot.repository.changedFiles).toContain("src/cart.js");
    expect(result.snapshot.repository.changedFiles).toContain("test/cart.test.js");
    expect(result.snapshot.repository.headSha).not.toBe("unknown");
    expect(result.snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(result.factfilePath)).toBe(true);
    expect(readFileSync(result.factfilePath, "utf8")).toContain("Human review remains");
    expect(result.staleRejection).toContain("repository changed after this Factfile was generated");
    expect(transcript.join("\n")).toContain("STALE PROOF REJECTED");
  });

  it("refuses to write into a non-empty requested directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "keyoku-proof-demo-nonempty-"));
    writeFileSync(join(root, "keep.txt"), "do not overwrite", "utf8");
    await expect(runProofDemo({ root })).rejects.toThrow("Demo directory is not empty");
  });
});
