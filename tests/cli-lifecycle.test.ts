// pause/resume privacy switch, doctor, and AGENTS.md baking — CLI surface.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("CLI Omnigent drive respects the connector autonomy ladder", () => {
  const seedOmnigent = (h: string, autonomy: "approve" | "autonomous") => {
    const store = new Store(h);
    store.saveConnector({
      name: "omnigent",
      transport: { type: "openapi", specUrl: "http://127.0.0.1:1/openapi.json", baseUrl: "http://127.0.0.1:1", allowMutating: true, auth: { kind: "none" } },
      autonomy,
      addedAt: new Date().toISOString(),
    } as any);
  };
  const run = (h: string, args: string[]): { out: string; err: string; code: number } => {
    try {
      const out = execFileSync(process.execPath, [ENTRY, ...args], {
        env: { ...process.env, KEYOKU_HOME: h } as NodeJS.ProcessEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { out, err: "", code: 0 };
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string; status?: number };
      return { out: x.stdout ?? "", err: x.stderr ?? "", code: x.status ?? 1 };
    }
  };

  it("`keyoku converge` refuses when the omnigent connector is not autonomous", () => {
    const h = mkdtempSync(join(tmpdir(), "keyoku-cli-conv-"));
    seedOmnigent(h, "approve");
    const r = run(h, ["converge", "--goal", "ship-it", "--session", "sess_abc"]);
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toContain("autonomy is 'approve'");
    rmSync(h, { recursive: true, force: true });
  });

  it("`keyoku guardrails` refuses when the omnigent connector is not autonomous", () => {
    const h = mkdtempSync(join(tmpdir(), "keyoku-cli-guard-"));
    seedOmnigent(h, "approve");
    const r = run(h, ["guardrails", "--goal", "ship-it", "--session", "sess_abc"]);
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toContain("autonomy is 'approve'");
    rmSync(h, { recursive: true, force: true });
  });
});

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

  const doctorWithHome = (fakeHome: string): string => {
    try {
      return execFileSync(process.execPath, [ENTRY, "doctor"], {
        env: { ...process.env, HOME: fakeHome, KEYOKU_HOME: join(fakeHome, ".keyoku") } as NodeJS.ProcessEnv,
        encoding: "utf8",
      });
    } catch (err) {
      return (err as { stdout?: string }).stdout ?? "";
    }
  };

  it("does NOT false-green a hook check on a decoy ' record' substring (structural parse)", () => {
    const fake = mkdtempSync(join(tmpdir(), "keyoku-doctor-decoy-"));
    mkdirSync(join(fake, ".claude"), { recursive: true });
    // A foreign hook whose command merely CONTAINS the word "record" — not
    // keyoku's `node …/index.js record` — must be reported as missing.
    writeFileSync(
      join(fake, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo about to record something" }] }] } }),
    );
    const out = doctorWithHome(fake);
    expect(out).toContain("✗ PostToolUse hook (recording)");
    rmSync(fake, { recursive: true, force: true });
  });

  it("greens the hook checks on a real keyoku wiring", () => {
    const fake = mkdtempSync(join(tmpdir(), "keyoku-doctor-real-"));
    mkdirSync(join(fake, ".claude"), { recursive: true });
    const cmd = (verb: string) => ({ hooks: [{ type: "command", command: `node ${ENTRY} ${verb}` }] });
    writeFileSync(
      join(fake, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [cmd("record")], SessionStart: [cmd("brief")], UserPromptSubmit: [cmd("context")] } }),
    );
    writeFileSync(join(fake, ".claude.json"), JSON.stringify({ mcpServers: { keyoku: { type: "stdio", command: "node", args: [ENTRY] } } }));
    const out = doctorWithHome(fake);
    expect(out).toContain("✓ PostToolUse hook (recording)");
    expect(out).toContain("✓ SessionStart hook (brief)");
    expect(out).toContain("✓ UserPromptSubmit hook (practice injection)");
    expect(out).toContain("✓ MCP server registered in ~/.claude.json");
    rmSync(fake, { recursive: true, force: true });
  });

  it("greens a LEGACY bare 'keyoku <verb>' hook (v1.x form) — no false-red on upgrade", () => {
    const fake = mkdtempSync(join(tmpdir(), "keyoku-doctor-legacy-"));
    mkdirSync(join(fake, ".claude"), { recursive: true });
    const cmd = (verb: string) => ({ hooks: [{ type: "command", command: `keyoku ${verb}` }] });
    writeFileSync(
      join(fake, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [cmd("record")], SessionStart: [cmd("brief")], UserPromptSubmit: [cmd("context")] } }),
    );
    const out = doctorWithHome(fake);
    expect(out).toContain("✓ PostToolUse hook (recording)");
    expect(out).toContain("✓ SessionStart hook (brief)");
    expect(out).toContain("✓ UserPromptSubmit hook (practice injection)");
    rmSync(fake, { recursive: true, force: true });
  });

  it("does NOT claim a FOREIGN hook that merely passes 'keyoku record' as a data argument", () => {
    const fake = mkdtempSync(join(tmpdir(), "keyoku-doctor-foreign-"));
    mkdirSync(join(fake, ".claude"), { recursive: true });
    // `echo keyoku record` runs echo, not keyoku — doctor must report the hook
    // missing (and init must never delete such a hook as if it were keyoku's).
    writeFileSync(
      join(fake, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo keyoku record" }] }] } }),
    );
    const out = doctorWithHome(fake);
    expect(out).toContain("✗ PostToolUse hook (recording)");
    rmSync(fake, { recursive: true, force: true });
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

describe("inspect", () => {
  it("summarizes the store and scans for secrets", () => {
    const { out } = cli(["inspect"]);
    expect(out).toContain("keyoku inspect");
    expect(out).toContain("Activity:");
    expect(out).toContain("Privacy:");
    expect(out).toContain("mode 600"); // credential-grade perms reported
    expect(cli(["inspect", "--secrets"]).out).toContain("secrets scan");
  });
});

describe("refine", () => {
  it("collapses a raw workflow into a clean template; --apply saves it", () => {
    const store = new Store(home);
    store.saveWorkflow({
      id: "wf_demo",
      slug: "demo-refine",
      objective: "demo objective",
      steps: [
        { summary: "Bash: npm run build", tool: "Bash", detail: "npm run build", result: "success", source: "activity" },
        { summary: "Bash: npm run build", tool: "Bash", detail: "npm run build", result: "success", source: "activity" }, // consecutive dup → collapsed
        { summary: "… 3 intermediate steps omitted …", result: "success", source: "activity" }, // marker → dropped
        { summary: "Edit: src/x.ts", tool: "Edit", result: "success", source: "activity" },
      ],
      criteria: [],
      stats: { convergences: 1, totalActions: 4 },
      createdAt: "2026-06-18T00:00:00Z",
      updatedAt: "2026-06-18T00:00:00Z",
    });

    const dry = cli(["refine", "demo-refine"]); // no model in test env → deterministic
    expect(dry.out).toContain("raw steps →");
    expect(dry.out).toContain("npm run build");
    expect(dry.out).not.toContain("intermediate step"); // omission marker dropped
    expect(store.getTemplate("demo-refine")).toBeUndefined(); // dry-run does not save

    const applied = cli(["refine", "demo-refine", "--apply"]);
    expect(applied.out).toContain("Saved template 'demo-refine'");
    const tmpl = store.getTemplate("demo-refine");
    expect(tmpl).toBeTruthy();
    expect(tmpl!.steps.length).toBeGreaterThan(0);
    expect(tmpl!.steps.some((s) => s.command === "npm run build")).toBe(true);

    expect(cli(["refine", "nope"]).code).toBe(1); // unknown slug fails cleanly
  });
});
