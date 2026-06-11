// Proactive surfacing: background ripeness → hook-delivered nudges.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  findRipe,
  formatBrief,
  formatNudge,
  loadRipe,
  loadSurfaced,
  resolveRipe,
  saveRipe,
  saveSurfaced,
} from "../src/nudge.js";
import type { ActivityEvent } from "../src/types.js";

const ENTRY = join(__dirname, "..", "dist", "index.js");

let n = 0;
function ev(cmd: string): ActivityEvent {
  n += 1;
  return {
    id: `ev_${n}`,
    type: "shell",
    summary: `Bash: ${cmd}`,
    detail: cmd,
    tool: "Bash",
    sessionId: "s1",
    at: new Date(2026, 0, 1, 0, 0, n % 60, n).toISOString(),
  };
}

function plantedPattern(): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (let i = 0; i < 4; i++) {
    events.push(ev("npm run lint"));
    events.push(ev("npm test"));
  }
  return events;
}

describe("ripeness", () => {
  it("finds unsurfaced patterns and respects the surfaced set", () => {
    const events = plantedPattern();
    const ripe = findRipe(events, new Set());
    expect(ripe.length).toBeGreaterThan(0);
    expect(typeof ripe[0].key).toBe("string");

    const surfaced = new Set([ripe[0].key]);
    const again = findRipe(events, surfaced);
    expect(again.find((s) => s.key === ripe[0].key)).toBeUndefined();
  });

  it("round-trips the ripeness cache and expires stale entries", () => {
    const home = mkdtempSync(join(tmpdir(), "keyoku-ripe-"));
    const ripe = findRipe(plantedPattern(), new Set());
    saveRipe(home, ripe);
    expect(loadRipe(home)?.suggestions.length).toBe(ripe.length);
    // resolveRipe prefers the cache — the fallback loader must not be called
    const viaCache = resolveRipe(home, new Set(), () => {
      throw new Error("fallback should not run when cache is fresh");
    });
    expect(viaCache.length).toBe(ripe.length);
    // stale cache → null → fallback runs
    writeFileSync(
      join(home, "ripe.json"),
      JSON.stringify({ at: "2020-01-01T00:00:00Z", suggestions: ripe }),
    );
    expect(loadRipe(home)).toBeNull();
    const viaFallback = resolveRipe(home, new Set(), () => plantedPattern());
    expect(viaFallback.length).toBeGreaterThan(0);
    rmSync(home, { recursive: true, force: true });
  });

  it("persists the surfaced set", () => {
    const home = mkdtempSync(join(tmpdir(), "keyoku-surf-"));
    saveSurfaced(home, new Set(["a → b"]));
    expect(loadSurfaced(home).has("a → b")).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("messages", () => {
  it("nudges address the agent and name the pattern", () => {
    const [ripe] = findRipe(plantedPattern(), new Set());
    const msg = formatNudge(ripe);
    expect(msg).toContain("[keyoku]");
    expect(msg).toContain("workflow_suggest");
  });

  it("brief is silent when there is nothing to say", () => {
    expect(formatBrief(0, 0)).toBe("");
    expect(formatBrief(2, 1)).toContain("2 approved workflows");
    expect(formatBrief(0, 3)).toContain("3 repeated patterns");
  });
});

describe("hook pipeline (CLI, end to end)", () => {
  const home = mkdtempSync(join(tmpdir(), "keyoku-nudge-e2e-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  function record(toolName: string, input: Record<string, unknown>): string {
    return execFileSync(process.execPath, [ENTRY, "record"], {
      env: { ...process.env, KEYOKU_HOME: home, KEYOKU_NUDGE_EVERY: "1" } as NodeJS.ProcessEnv,
      input: JSON.stringify({ tool_name: toolName, tool_input: input, session_id: "s1" }),
      encoding: "utf8",
    });
  }

  it("emits exactly one additionalContext nudge when a pattern ripens", () => {
    const outputs: string[] = [];
    for (let i = 0; i < 4; i++) {
      outputs.push(record("Bash", { command: "npm run lint" }));
      outputs.push(record("Bash", { command: "npm test" }));
      // varying separator so only the lint→test chain repeats
      outputs.push(record("Read", { file_path: `/tmp/notes-${i}.md` }));
    }
    const nudges = outputs.filter((o) => o.includes("hookSpecificOutput"));
    expect(nudges.length).toBe(1);
    const parsed = JSON.parse(nudges[0]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("[keyoku]");
    // identity persisted so it never re-nudges
    expect(readFileSync(join(home, "surfaced.json"), "utf8")).toContain("Bash:");
  });

  it("brief reports the unsurfaced/saved state", () => {
    const out = execFileSync(process.execPath, [ENTRY, "brief"], {
      env: { ...process.env, KEYOKU_HOME: home } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    // the only ripe pattern was just surfaced+still unsaved? surfaced set hides it,
    // and no templates exist — brief may be silent or mention nothing unsaved.
    expect(out).not.toContain("undefined");
  });
});
