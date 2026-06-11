// keyoku import — backfill activity from Claude Code session transcripts.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const ENTRY = join(__dirname, "..", "dist", "index.js");

const home = mkdtempSync(join(tmpdir(), "keyoku-import-home-"));
const transcripts = mkdtempSync(join(tmpdir(), "keyoku-import-src-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(transcripts, { recursive: true, force: true });
});

const emptyCodex = mkdtempSync(join(tmpdir(), "keyoku-no-codex-"));

function runImport(): string {
  return execFileSync(
    process.execPath,
    [ENTRY, "import", "--dir", transcripts, "--codex-dir", emptyCodex],
    {
      env: { ...process.env, KEYOKU_HOME: home } as NodeJS.ProcessEnv,
      encoding: "utf8",
    },
  );
}

describe("keyoku import", () => {
  it("imports tool calls from transcripts, skipping noise and bad lines", () => {
    const asst = (ts: string, name: string, input: Record<string, unknown>) =>
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        sessionId: "sess-1",
        cwd: join(transcripts, "proj-a"),
        message: { content: [{ type: "tool_use", name, input }] },
      });
    mkdirSync(join(transcripts, "proj-a"), { recursive: true });
    writeFileSync(
      join(transcripts, "proj-a", "CLAUDE.md"),
      "# proj-a\n\nIntro.\n\n## Testing\nAlways run npm test before pushing.\n\n## Deploys\nStaging deploys go through make deploy.",
    );
    writeFileSync(
      join(transcripts, "proj-a", "session.jsonl"),
      [
        asst("2026-06-01T10:00:00Z", "Bash", { command: "npm test" }),
        JSON.stringify({ type: "user", message: { content: "just chatting" } }),
        asst("2026-06-01T10:01:00Z", "Edit", { file_path: "/p/src/a.ts" }),
        asst("2026-06-01T10:02:00Z", "mcp__github__create_pr", { title: "x" }),
        asst("2026-06-01T10:03:00Z", "TodoWrite", { items: [] }), // outside trace surface
        "this line is not json",
      ].join("\n"),
    );

    const out = runImport();
    expect(out).toContain("Imported 3 events");

    const events = readFileSync(join(home, "activity.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events).toHaveLength(3);
    expect(events[0].summary).toBe("Bash: npm test");
    expect(events[0].sessionId).toBe("sess-1");
    expect(events[0].cwd).toBe(join(transcripts, "proj-a"));
    expect(events[0].at).toBe("2026-06-01T10:00:00Z");
    expect(out).toContain("convention section(s)");
    const knowledge = readFileSync(join(home, "knowledge.jsonl"), "utf8");
    expect(knowledge).toContain("conventions:proj-a");
    expect(knowledge).toContain("Always run npm test before pushing");
    expect(events[1].summary).toBe("Edit: /p/src/a.ts");
    expect(events[2].summary).toBe("MCP: github.create_pr");
  });

  it("is idempotent — re-running imports nothing new", () => {
    const out = runImport();
    expect(out).toContain("Imported 0 events");
  });

  it("imports Codex rollout sessions (both line shapes) with cwd + redaction", () => {
    const codexDir = mkdtempSync(join(tmpdir(), "keyoku-codex-src-"));
    mkdirSync(join(codexDir, "2026", "06"), { recursive: true });
    writeFileSync(
      join(codexDir, "2026", "06", "rollout-x.jsonl"),
      [
        JSON.stringify({ id: "codex-sess-1", timestamp: "2026-06-02T09:00:00Z" }),
        JSON.stringify({
          timestamp: "2026-06-02T09:00:05Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<environment_context><cwd>/Users/dev/Development/codex-proj</cwd></environment_context>" }],
          },
        }),
        // wrapped shape
        JSON.stringify({
          timestamp: "2026-06-02T09:01:00Z",
          type: "response_item",
          payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "npm run build"] }) },
        }),
        // bare shape, no timestamp (inherits last seen), with a secret
        JSON.stringify({
          type: "function_call",
          name: "shell",
          arguments: JSON.stringify({ command: ["bash", "-lc", "export API_TOKEN=supersecret123 && deploy"] }),
        }),
      ].join("\n"),
    );

    const out = execFileSync(process.execPath, [ENTRY, "import", "--dir", transcripts, "--codex-dir", codexDir], {
      env: { ...process.env, KEYOKU_HOME: home } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(out).toContain("1 Codex transcript file(s)");
    expect(out).toContain("Imported 2 events");

    const events = readFileSync(join(home, "activity.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const codexEvents = events.filter((e) => e.sessionId === "codex-sess-1");
    expect(codexEvents).toHaveLength(2);
    expect(codexEvents[0].summary).toBe("Bash: npm run build");
    expect(codexEvents[0].cwd).toBe("/Users/dev/Development/codex-proj");
    expect(codexEvents[1].at).toBe("2026-06-02T09:01:00Z"); // inherited timestamp
    expect(codexEvents[1].detail).toContain("«redacted»");
    expect(codexEvents[1].detail).not.toContain("supersecret123");
    rmSync(codexDir, { recursive: true, force: true });
  });
});
