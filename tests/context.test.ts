// keyoku context — practice injection at prompt time (UserPromptSubmit wire).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Store } from "../src/store.js";

const ENTRY = join(__dirname, "..", "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "keyoku-context-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

function runContext(input: Record<string, unknown>): string {
  return execFileSync(process.execPath, [ENTRY, "context"], {
    env: { ...process.env, KEYOKU_HOME: home } as NodeJS.ProcessEnv,
    input: JSON.stringify(input),
    encoding: "utf8",
  });
}

describe("keyoku context", () => {
  it("injects a matching saved workflow and project practice", () => {
    const store = new Store(home);
    store.saveTemplate({
      id: "tmpl_ctx",
      slug: "deploy-staging",
      name: "Deploy staging",
      description: "Run tests, build, and deploy the staging environment",
      steps: [{ type: "bash", summary: "deploy", command: "make deploy" }],
      trigger: { type: "on_demand" },
      approvedAt: "2026-06-11T00:00:00Z",
      createdAt: "2026-06-11T00:00:00Z",
      updatedAt: "2026-06-11T00:00:00Z",
      timesRun: 2,
    });
    store.appendKnowledge({
      id: "kn_ctx",
      subject: "practice:demoapp",
      kind: "note",
      fact: "Recurring work pattern (4×): Edit hook.mjs → Edit hud.mjs",
      source: "pattern-mining",
      at: "2026-06-11T00:00:00Z",
    });

    const out = runContext({
      prompt: "can you deploy the staging build like usual",
      cwd: "/Users/dev/Development/demoapp/web",
    });
    const parsed = JSON.parse(out);
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(ctx).toContain("deploy-staging");
    expect(ctx).toContain("House pattern in demoapp");
  });

  it("stays silent on unrelated prompts", () => {
    const out = runContext({ prompt: "what is the weather like", cwd: "/tmp" });
    expect(out.trim()).toBe("");
  });
});
