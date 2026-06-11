import { describe, expect, it } from "vitest";

import { detectPatterns, enrichWithEntities } from "../src/activity.js";
import type { ActivityEvent } from "../src/types.js";

let n = 0;
function ev(summary: string, tool = "Bash", detail?: string): ActivityEvent {
  n += 1;
  return {
    id: `ev_${n}`,
    type: "shell",
    summary,
    ...(detail ? { detail } : {}),
    tool,
    at: new Date(2026, 0, 1, 0, 0, n % 60, n).toISOString(),
  };
}

describe("detectPatterns", () => {
  it("returns [] for fewer than two events", () => {
    expect(detectPatterns([])).toEqual([]);
    expect(detectPatterns([ev("Bash: ls")])).toEqual([]);
  });

  it("detects a sequence repeated 3× and drafts runnable bash steps", () => {
    const events: ActivityEvent[] = [];
    for (let round = 0; round < 3; round++) {
      events.push(ev("Bash: npm test", "Bash", "npm test"));
      events.push(ev("Bash: git add -A", "Bash", "git add -A"));
      events.push(ev("Bash: git push", "Bash", "git push"));
      events.push(ev(`Read: /tmp/notes-${round}.md`, "Read")); // varying separator noise
    }
    const suggestions = detectPatterns(events, 3);
    expect(suggestions).toHaveLength(1);
    const top = suggestions[0];
    expect(top.count).toBe(3);
    expect(top.draftSteps).toHaveLength(3);
    expect(top.draftSteps[0]).toMatchObject({ type: "bash", command: "npm test" });
    expect(top.draftSteps[2]).toMatchObject({ type: "bash", command: "git push" });
  });

  it("does not suggest runs of one identical action", () => {
    const events = Array.from({ length: 12 }, () => ev("Edit: /src/app.ts", "Edit"));
    expect(detectPatterns(events, 3)).toEqual([]);
  });

  it("counts non-overlapping occurrences only", () => {
    const events: ActivityEvent[] = [];
    for (let i = 0; i < 4; i++) {
      events.push(ev("Bash: npm run lint", "Bash", "npm run lint"));
      events.push(ev("Bash: npm test", "Bash", "npm test"));
    }
    const suggestions = detectPatterns(events, 3);
    // lint,test alternating 4× — the A→B chain occurs 4 non-overlapping times
    // (a naive sliding count would report 7 across both directions).
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].count).toBe(4);
    expect(suggestions[0].description).toContain("Detected 4×");
  });

  it("collapses sub-sequences into the longest repeated chain", () => {
    const events: ActivityEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(ev("Bash: step-a", "Bash", "a"));
      events.push(ev("Bash: step-b", "Bash", "b"));
      events.push(ev("Bash: step-c", "Bash", "c"));
      events.push(ev("Bash: step-d", "Bash", "d"));
    }
    const suggestions = detectPatterns(events, 3);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].draftSteps).toHaveLength(4);
    expect(suggestions[0].count).toBe(3);
  });

  it("names suggestions from real summaries, not the tool name twice", () => {
    const events: ActivityEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(ev("Bash: npm test", "Bash", "npm test"));
      events.push(ev("Bash: git push", "Bash", "git push"));
      events.push(ev(`Read: /tmp/x-${i}.md`, "Read"));
    }
    const [top] = detectPatterns(events, 3);
    expect(top.name).toContain("npm test");
    expect(top.name).toContain("git push");
  });
});

describe("session partitioning", () => {
  it("does not stitch interleaved concurrent sessions into false patterns", () => {
    // Session A edits project A, session B edits project B — interleaved in
    // the global log. Cross-session adjacencies must never become patterns.
    const events: ActivityEvent[] = [];
    for (let i = 0; i < 4; i++) {
      events.push({ ...ev("Write: /proj-a/api/handler.go", "Write"), sessionId: "sess-a" });
      events.push({ ...ev("Edit: /proj-b/src/page.tsx", "Edit"), sessionId: "sess-b" });
      events.push({ ...ev("Edit: /proj-b/src/layout.tsx", "Edit"), sessionId: "sess-b" });
    }
    // Within sess-a: only identical Writes (skipped). Within sess-b: only
    // alternating identical-keyed .tsx edits. No real cross-step workflow.
    const cross = detectPatterns(events, 3);
    expect(cross.filter((s) => s.name.includes("handler.go") && s.name.includes("tsx"))).toEqual([]);
  });

  it("counts the same workflow across sessions", () => {
    const events: ActivityEvent[] = [];
    for (const sess of ["s1", "s2", "s3"]) {
      events.push({ ...ev("Bash: npm test", "Bash", "npm test"), sessionId: sess });
      events.push({ ...ev("Bash: git push", "Bash", "git push"), sessionId: sess });
    }
    const found = detectPatterns(events, 3);
    expect(found).toHaveLength(1);
    expect(found[0].count).toBe(3);
  });
});

describe("enrichWithEntities", () => {
  it("extracts CLI keywords and file extensions from summaries", () => {
    const e = enrichWithEntities(ev("Bash: git push && npm run build src/index.ts", "Bash"));
    expect(e.entities).toEqual(expect.arrayContaining(["git", "npm", "ts"]));
  });

  it("leaves pre-populated entities untouched", () => {
    const base = { ...ev("Bash: git push", "Bash"), entities: ["custom"] };
    expect(enrichWithEntities(base).entities).toEqual(["custom"]);
  });
});
