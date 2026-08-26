import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRY = join(__dirname, "..", "dist", "index.js");

function cli(args: string[]): string {
  return execFileSync(process.execPath, [ENTRY, ...args], { encoding: "utf8" });
}

describe("Pulse CLI", () => {
  it("ingests a synthetic fixture but refuses dispatch and audience rendering", () => {
    const root = mkdtempSync(join(tmpdir(), "keyoku-pulse-cli-"));
    const fixturePath = join(root, "generic.jsonl");
    const project = join(root, "project");
    const fixture = JSON.parse(cli(["pulse", "fixture", "generic", "--out", fixturePath, "--json"]));
    expect(fixture).toMatchObject({ ok: true, result: { kind: "fixture", out: fixturePath } });
    expect(readFileSync(fixturePath, "utf8").trim().split("\n")).toHaveLength(4);

    const ingest = JSON.parse(cli(["pulse", "ingest", "--root", project, "--file", fixturePath, "--json"]));
    expect(ingest).toMatchObject({ ok: true, result: { appended: 4, deduplicated: 0 } });
    const replay = JSON.parse(cli(["pulse", "ingest", "--root", project, "--file", fixturePath, "--json"]));
    expect(replay).toMatchObject({ ok: true, result: { appended: 0, deduplicated: 4 } });
    const status = JSON.parse(cli(["pulse", "status", "--root", project, "--json"]));
    expect(status).toMatchObject({ ok: true, result: { eventCount: 4, leases: [{ harness: "generic-jsonl", state: "completed" }], checkpoints: [{ id: "cart-recovery-verified" }] } });
    const plan = JSON.parse(cli(["pulse", "plan", "--root", project, "--now", "2026-08-24T16:05:00.000Z", "--debounce-ms", "0", "--json"]));
    expect(plan).toMatchObject({ ok: true, result: { decision: { outcome: "suppress", reasonCode: "attested_checkpoint", checkpointIds: ["cart-recovery-verified"] } } });
    try {
      cli(["pulse", "render", "--root", project, "--now", "2026-08-24T16:05:00.000Z", "--debounce-ms", "0", "--audience", "timeline", "--json"]);
      throw new Error("expected attested render refusal");
    } catch (error) {
      const stdout = (error as { stdout?: Buffer | string }).stdout;
      expect(JSON.parse(Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout))).toMatchObject({ ok: false, error: { message: expect.stringContaining("attested_checkpoint") } });
    }
  });

  it("returns a stable machine-readable error envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "keyoku-pulse-cli-error-"));
    try {
      cli(["pulse", "fixture", "unknown", "--root", root, "--json"]);
      throw new Error("expected Pulse fixture failure");
    } catch (error) {
      const stdout = (error as { stdout?: Buffer | string }).stdout;
      const parsed = JSON.parse(Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout));
      expect(parsed).toMatchObject({ ok: false, error: { code: "pulse_error" } });
    }
  });
});
