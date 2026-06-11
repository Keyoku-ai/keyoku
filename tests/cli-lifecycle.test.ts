// pause/resume privacy switch, doctor, and AGENTS.md baking — CLI surface.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Store } from "../src/store.js";

const ENTRY = join(__dirname, "..", "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "keyoku-cli-life-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

function cli(args: string[], input?: string): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [ENTRY, ...args], {
      env: { ...process.env, KEYOKU_HOME: home, KEYOKU_NUDGE_EVERY: "0" } as NodeJS.ProcessEnv,
      ...(input !== undefined ? { input } : {}),
      encoding: "utf8",
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { out: e.stdout ?? "", code: e.status ?? 1 };
  }
}

const recordInput = JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hi" }, session_id: "s" });

describe("pause / resume", () => {
  it("pause stops recording; resume restores it", () => {
    cli(["record"], recordInput);
    expect(readFileSync(join(home, "activity.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);

    expect(cli(["pause"]).out).toContain("paused");
    cli(["record"], recordInput);
    expect(readFileSync(join(home, "activity.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(cli(["brief"]).out.trim()).toBe("");

    expect(cli(["resume"]).out).toContain("resumed");
    cli(["record"], recordInput);
    expect(readFileSync(join(home, "activity.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });
});

describe("doctor", () => {
  it("runs all checks and reports activity state", () => {
    const { out } = cli(["doctor"]);
    expect(out).toContain("keyoku doctor");
    expect(out).toContain("activity log: 2 events");
    expect(out).toContain("SLM tier:");
  });
});

describe("export --agents-md", () => {
  it("writes a managed block and updates it in place on re-export", () => {
    new Store(home).saveTemplate({
      id: "tmpl_a",
      slug: "ship-it",
      name: "Ship it",
      description: "Build and deploy",
      steps: [{ type: "bash", summary: "build", command: "make build" }],
      trigger: { type: "on_demand" },
      approvedAt: "2026-06-11T00:00:00Z",
      createdAt: "2026-06-11T00:00:00Z",
      updatedAt: "2026-06-11T00:00:00Z",
      timesRun: 6,
    });
    const target = join(home, "AGENTS.md");

    cli(["export", "ship-it", "--agents-md", target]);
    const doc1 = readFileSync(target, "utf8");
    expect(doc1).toContain("<!-- keyoku:workflows -->");
    expect(doc1).toContain("### keyoku:ship-it — Ship it");
    expect(doc1).toContain('workflow_execute { "slug": "ship-it" }');

    cli(["export", "ship-it", "--agents-md", target]);
    const doc2 = readFileSync(target, "utf8");
    expect(doc2.match(/### keyoku:ship-it/g)).toHaveLength(1);
    expect(existsSync(join(home, ".claude"))).toBe(false); // agents-md mode skips skills dir
  });
});
