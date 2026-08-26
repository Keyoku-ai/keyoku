import { describe, expect, it } from "vitest";

import { detectPatterns, enrichWithEntities, redactSecrets } from "../src/activity.js";
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

describe("routing (automation vs practice)", () => {
  it("classifies command chains as automation", () => {
    const events: ActivityEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(ev("Bash: npm test", "Bash", "npm test"));
      events.push(ev("Bash: git push", "Bash", "git push"));
      events.push(ev(`Read: /tmp/x-${i}.md`, "Read"));
    }
    const [s] = detectPatterns(events, 3);
    expect(s.kind).toBe("automation");
  });

  it("classifies edit clusters as practice, not run buttons", () => {
    const events: ActivityEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(ev("Edit: /proj/src/hook.mjs", "Edit"));
      events.push(ev("Write: /proj/src/hud.mjs", "Write"));
      events.push(ev(`Read: /tmp/sep-${i}.md`, "Read"));
    }
    const [s] = detectPatterns(events, 3);
    expect(s).toBeTruthy();
    expect(s.kind).toBe("practice");
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

describe("redactSecrets", () => {
  it("masks credential assignments and bearer tokens", () => {
    expect(redactSecrets("export GITHUB_TOKEN=ghp_abc123def && git push")).toBe( // gitleaks:allow -- synthetic redaction fixture
      "export GITHUB_TOKEN=«redacted» && git push",
    );
    expect(redactSecrets("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y'")).toContain( // gitleaks:allow -- synthetic redaction fixture
      "Bearer «redacted»",
    );
    expect(redactSecrets('{"api_key": "sk-live-12345678"}')).toContain("«redacted»"); // gitleaks:allow -- synthetic redaction fixture
    expect(redactSecrets("password: hunter22")).toBe("password: «redacted»");
  });

  it("masks Basic-auth credentials without leaking the token", () => {
    const out = redactSecrets("curl -H 'Authorization: Basic dXNlcjpzM2NyZXRwYXNz'"); // gitleaks:allow -- synthetic redaction fixture
    expect(out).toContain("Basic «redacted»");
    expect(out).not.toContain("dXNlcjpzM2NyZXRwYXNz"); // the actual credential is gone
  });

  it("masks the password in a DB/URL connection string, keeping scheme+user+host", () => {
    const out = redactSecrets("DATABASE_URL=postgres://appuser:s3cr3tp4ss@db.internal:5432/prod");
    expect(out).not.toContain("s3cr3tp4ss");
    expect(out).toContain("postgres://appuser:«redacted»@db.internal");
  });

  it("masks the password in the EMPTY-username URL form (redis://:pass@, mongodb+srv://:pass@)", () => {
    const redis = redactSecrets("REDIS_URL=redis://:s3cr3tRedisPass@cache.internal:6379/0");
    expect(redis).not.toContain("s3cr3tRedisPass");
    expect(redis).toContain("redis://:«redacted»@cache.internal");
    const mongo = redactSecrets("mongodb+srv://:m0ngoPass@cluster0.example.net");
    expect(mongo).not.toContain("m0ngoPass");
  });

  it("leaves benign text and plain host:port URLs untouched", () => {
    const benign = "git commit -m 'update key layout docs' && npm test";
    expect(redactSecrets(benign)).toBe(benign);
    const url = "curl http://localhost:8080/health";
    expect(redactSecrets(url)).toBe(url); // a port is not a password
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
