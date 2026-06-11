import { describe, expect, it } from "vitest";

import { executeBashStep } from "../src/executor.js";

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
    const r = await executeBashStep("sleep 5", undefined, 200);
    expect(r.ok).toBe(false);
    expect(r.result).toContain("timed out");
  }, 10_000);

  it("truncates huge output to 2000 chars", async () => {
    const r = await executeBashStep("yes x | head -c 10000");
    expect(r.ok).toBe(true);
    expect(r.result.length).toBeLessThanOrEqual(2000);
  });

  it("runs in the requested cwd", async () => {
    const r = await executeBashStep("pwd", "/tmp");
    expect(r.ok).toBe(true);
    expect(r.result).toMatch(/\/tmp$/);
  });
});
