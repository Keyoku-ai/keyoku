import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeBashStep } from "../src/executor.js";

const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

describe("executeBashStep", () => {
  it("captures stdout and reports ok on exit 0", async () => {
    const r = await executeBashStep("echo hello");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("hello");
  });

  it("reports ok=false and captures stderr on non-zero exit", async () => {
    const r = await executeBashStep("echo boom >&2; exit 3");
    expect(r.ok).toBe(false);
    expect(r.result).toContain("boom");
  });

  it("times out runaway commands", async () => {
    const r = await executeBashStep("sleep 5", { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.result).toContain("timed out");
  }, 10_000);

  it("truncates huge output to 2000 chars", async () => {
    const r = await executeBashStep("yes x | head -c 10000");
    expect(r.ok).toBe(true);
    expect(r.result.length).toBeLessThanOrEqual(2000);
  });

  it("runs in the requested cwd", async () => {
    const r = await executeBashStep("pwd", { cwd: "/tmp" });
    expect(r.ok).toBe(true);
    expect(r.result).toMatch(/\/tmp$/);
  });

  it("treats env-bound params as DATA — a param value cannot inject shell", async () => {
    // This is the shape workflow_execute produces: the command references the
    // param via "$VAR"; the value lives in env. A value that looks like a
    // command substitution must be echoed literally, never executed.
    const r = await executeBashStep('echo "$KEYOKU_PARAM_0"', {
      env: { KEYOKU_PARAM_0: "$(echo PWNED)" },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("$(echo PWNED)"); // literal, not "PWNED"
  });

  it("kills grandchildren on timeout (process-group teardown)", async () => {
    const marker = join(tmpdir(), `keyoku-gc-${process.pid}.txt`);
    rmSync(marker, { force: true });
    // A backgrounded grandchild sleeps then writes a marker; the parent waits.
    const r = await executeBashStep(`( sleep 1; echo alive > ${marker} ) & wait`, { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.result).toContain("timed out");
    // If only the direct `sh` were killed, the grandchild would survive and
    // write the marker at ~1s. With process-group teardown it never does.
    await wait(1500);
    expect(existsSync(marker)).toBe(false);
    rmSync(marker, { force: true });
  }, 10_000);
});
