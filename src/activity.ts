import type { ActivityEvent, WorkflowStepTemplate } from "./types.js";

export interface ActivitySuggestion {
  slug: string;
  name: string;
  description: string;
  count: number;
  draftSteps: WorkflowStepTemplate[];
}

function eventKey(event: ActivityEvent): string {
  const tool = event.tool ?? event.type;
  // Normalize on the FULL summary, then truncate — truncating first leaves
  // unterminated quotes/paths that defeat every rule below.
  let hint = event.summary;
  // Drop the duplicated tool prefix ("Bash: …" recorded under tool=Bash)
  if (hint.startsWith(`${tool}: `)) hint = hint.slice(tool.length + 2);
  // git commit messages are run-specific, never part of the pattern shape
  hint = hint.replace(/(git commit)\b.*/, "$1 <msg>");
  // Edits/Writes to different files in the same loop are the same kind of
  // step — keep only the extension so the chain survives file variation
  if (tool === "Edit" || tool === "Write") {
    hint = hint.replace(/(?:\/[^/\s]+)+\/[\w.-]+?(\.[A-Za-z0-9]+)?\b/g, (_m, ext) => `*${ext ?? ""}`);
  } else {
    // Elsewhere keep the filename — which file you Read is signal
    hint = hint.replace(/(?:\/[^/\s]+)+\/([\w.-]+)/g, "*/$1");
  }
  // Strip quoted strings, including ones left unterminated by upstream caps
  hint = hint.replace(/"[^"]{8,}("|$)/g, '"…"').replace(/'[^']{8,}('|$)/g, "'…'");
  // Strip long hex hashes
  hint = hint.replace(/\b[0-9a-f]{7,}\b/g, "<hash>");
  return `${tool}:${hint.slice(0, 60)}`;
}

function extractEntities(event: ActivityEvent): string[] {
  const entities: string[] = [];
  // File extensions from paths
  const extMatches = event.summary.match(/\.(ts|js|go|py|json|yaml|yml|md|sh|sql|tf)\b/g);
  if (extMatches) entities.push(...extMatches.map((e) => e.slice(1)));
  // Common CLI keywords
  const cliKeywords = ["git", "npm", "pnpm", "docker", "kubectl", "terraform", "go", "node", "python"];
  for (const kw of cliKeywords) {
    if (event.summary.toLowerCase().includes(kw)) entities.push(kw);
  }
  // Service names from connector calls
  if (event.tool === "connector_call" && event.detail) {
    const m = event.detail.match(/connector:\s*"?([a-z0-9-]+)"?/i);
    if (m) entities.push(m[1]);
  }
  return [...new Set(entities)];
}

export function detectPatterns(
  events: ActivityEvent[],
  minCount = 3,
  windowSize = 300,
): ActivitySuggestion[] {
  const recent = events.slice(-windowSize);
  if (recent.length < 2) return [];

  const keys = recent.map(eventKey);

  // Count candidate sequences of length 2–4. Two rules keep counts honest:
  // occurrences never overlap (A,B,A,B,A,B is three A→B's, not five), and
  // sequences whose events are all identical are skipped — a formatter
  // rewriting the same file ten times is one action repeating, not a workflow.
  interface Candidate {
    count: number;
    exemplar: ActivityEvent[];
    seq: string[];
  }
  const counts = new Map<string, Candidate>();
  for (let seqLen = 2; seqLen <= 6; seqLen++) {
    const nextAllowed = new Map<string, number>();
    for (let i = 0; i <= recent.length - seqLen; i++) {
      const seq = keys.slice(i, i + seqLen);
      if (new Set(seq).size === 1) continue;
      const key = seq.join(" → ");
      if (i < (nextAllowed.get(key) ?? 0)) continue;
      nextAllowed.set(key, i + seqLen);
      const existing = counts.get(key);
      if (existing) existing.count++;
      else counts.set(key, { count: 1, exemplar: recent.slice(i, i + seqLen), seq });
    }
  }

  const qualified = [...counts.values()].filter((c) => c.count >= minCount);

  // Prefer the longest chain that still clears minCount — it automates the
  // most — then drop anything contained in (or containing) an accepted one,
  // so A→B→C→D doesn't also surface as A→B, B→C, A→B→C, ...
  qualified.sort((a, b) => b.seq.length - a.seq.length || b.count - a.count);
  const accepted: Candidate[] = [];
  for (const c of qualified) {
    if (accepted.some((a) => containsSeq(a.seq, c.seq) || containsSeq(c.seq, a.seq))) continue;
    accepted.push(c);
    if (accepted.length === 5) break;
  }

  return accepted.map((c, idx) => {
    const draftSteps: WorkflowStepTemplate[] = c.exemplar.map((ev) => {
      if (ev.tool === "Bash" && ev.detail) {
        return {
          type: "bash" as const,
          summary: ev.summary.slice(0, 100),
          command: ev.detail.slice(0, 500),
        };
      }
      return {
        type: "agent_prompt" as const,
        summary: ev.summary.slice(0, 100),
        prompt: `Perform: ${ev.summary}`,
      };
    });

    const first = c.exemplar[0].summary.slice(0, 40);
    const last = c.exemplar[c.exemplar.length - 1].summary.slice(0, 40);
    const firstTool = c.exemplar[0].tool ?? "workflow";

    return {
      slug: `auto-${firstTool.toLowerCase().replace(/[^a-z0-9]/g, "")}-${idx + 1}`,
      name: `Auto: ${first} → ${last}`,
      description: `Detected ${c.count}× in recent activity (${c.seq.length} steps): ${c.seq.join(" → ")}`,
      count: c.count,
      draftSteps,
    };
  });
}

/** True if `haystack` contains `needle` as a contiguous run. */
function containsSeq(haystack: string[], needle: string[]): boolean {
  if (needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

export function enrichWithEntities(event: ActivityEvent): ActivityEvent {
  if (event.entities && event.entities.length > 0) return event;
  return { ...event, entities: extractEntities(event) };
}
