import type { ActivityEvent, WorkflowStepTemplate } from "./types.js";

export interface ActivitySuggestion {
  slug: string;
  name: string;
  description: string;
  count: number;
  draftSteps: WorkflowStepTemplate[];
  /** Stable identity of the underlying sequence — used to surface each
   * detected pattern to the user exactly once. */
  key: string;
  /** Routing: "automation" = runnable, suggest/nudge it as a workflow;
   * "practice" = a real pattern in the wrong vocabulary (e.g. files that
   * change together) — file it as knowledge, never as a run button. */
  kind: "automation" | "practice";
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

  // Mine WITHIN each session, count ACROSS sessions. Concurrent sessions
  // interleave in the global log — without partitioning, an edit in project A
  // followed by an edit in project B reads as a false adjacency and the
  // detector stitches unrelated work into "patterns".
  const bySession = new Map<string, ActivityEvent[]>();
  for (const e of recent) {
    const k = e.sessionId ?? "_";
    const group = bySession.get(k);
    if (group) group.push(e);
    else bySession.set(k, [e]);
  }

  // Count candidate sequences of length 2–6. Two rules keep counts honest:
  // occurrences never overlap (A,B,A,B,A,B is three A→B's, not five), and
  // sequences whose events are all identical are skipped — a formatter
  // rewriting the same file ten times is one action repeating, not a workflow.
  interface Candidate {
    count: number;
    exemplar: ActivityEvent[];
    seq: string[];
  }
  const counts = new Map<string, Candidate>();
  for (const group of bySession.values()) {
    if (group.length < 2) continue;
    const keys = group.map(eventKey);
    for (let seqLen = 2; seqLen <= 6; seqLen++) {
      const nextAllowed = new Map<string, number>();
      for (let i = 0; i <= group.length - seqLen; i++) {
        const seq = keys.slice(i, i + seqLen);
        if (new Set(seq).size === 1) continue;
        const key = seq.join(" → ");
        if (i < (nextAllowed.get(key) ?? 0)) continue;
        nextAllowed.set(key, i + seqLen);
        const existing = counts.get(key);
        if (existing) existing.count++;
        else counts.set(key, { count: 1, exemplar: group.slice(i, i + seqLen), seq });
      }
    }
  }

  // A workflow must DO something. Sequences made entirely of inspection
  // (ls, cat, grep, git status, Reads…) are how people look around, not how
  // they work — they repeat constantly and mean nothing. Requiring at least
  // one action step kills coincidence patterns without hurting real ones.
  const qualified = [...counts.values()].filter(
    (c) => c.count >= minCount && c.exemplar.some(isActionEvent),
  );

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
    const draftSteps: WorkflowStepTemplate[] = c.exemplar.map(draftStep);

    const first = c.exemplar[0].summary.slice(0, 40);
    const last = c.exemplar[c.exemplar.length - 1].summary.slice(0, 40);
    const firstTool = c.exemplar[0].tool ?? "workflow";

    // Routing: a pattern is runnable automation only if executable steps
    // (bash / mcp_call) carry it. Edit/Write clusters are real patterns in
    // the wrong vocabulary — they become practice knowledge instead.
    const executable = draftSteps.filter((s) => s.type === "bash" || s.type === "mcp_call").length;
    const kind: "automation" | "practice" =
      executable >= 2 || executable / draftSteps.length >= 0.5 ? "automation" : "practice";

    return {
      slug: `auto-${firstTool.toLowerCase().replace(/[^a-z0-9]/g, "")}-${idx + 1}`,
      name: `Auto: ${first} → ${last}`,
      description: `Detected ${c.count}× in recent activity (${c.seq.length} steps): ${c.seq.join(" → ")}`,
      count: c.count,
      draftSteps,
      key: c.seq.join(" → "),
      kind,
    };
  });
}

// Secrets must never enter the activity log — they would propagate into
// drafts, baked skills (committed to repos!), and the engine mirror. Redact
// at record time: key=value/key: value assignments whose key smells like a
// credential, and bearer tokens. Conservative by design — losing a file path
// to over-redaction is fine; leaking a token is not.
const SECRET_ASSIGNMENT_RE =
  /([\w-]*(?:token|secret|passwd|password|api[_-]?key|access[_-]?key|credential|auth)[\w-]*["']?\s*[:=]\s*)(["']?)(?!bearer\b)(?!«redacted»)[^\s"']{4,}\2/gi;
const BEARER_RE = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

export function redactSecrets(text: string): string {
  // Bearer first: in "Authorization: Bearer <jwt>" the assignment rule must
  // not consume the word "Bearer" as the value.
  return text.replace(BEARER_RE, "$1«redacted»").replace(SECRET_ASSIGNMENT_RE, "$1«redacted»");
}

/** Map one observed event to a draft workflow step. Shared by pattern
 * detection and on-demand capture so both produce identical drafts. */
export function draftStep(ev: ActivityEvent): WorkflowStepTemplate {
  if (ev.tool === "Bash" && ev.detail) {
    return {
      type: "bash" as const,
      summary: ev.summary.slice(0, 100),
      command: ev.detail.slice(0, 500),
    };
  }
  if (ev.tool === "connector_call" && ev.detail) {
    try {
      const parsed = JSON.parse(ev.detail) as { connector?: string; tool?: string; args?: Record<string, unknown> };
      if (parsed.connector && parsed.tool) {
        return {
          type: "mcp_call" as const,
          summary: ev.summary.slice(0, 100),
          connector: parsed.connector,
          tool: parsed.tool,
          ...(parsed.args ? { args: parsed.args } : {}),
        };
      }
    } catch { /* fall through to agent_prompt */ }
  }
  return {
    type: "agent_prompt" as const,
    summary: ev.summary.slice(0, 100),
    prompt: `Perform: ${ev.summary}`,
  };
}

const INSPECTION_RE =
  /^(ls|cat|grep|rg|find|head|tail|pwd|which|wc|tree|echo|man|type|stat|du|df|env|printenv|git (status|diff|log|show|branch|blame|remote)|npm (ls|view|outdated|info)|docker (ps|images)|kubectl (get|describe))\b/;

/** Does this event change anything, or is it just looking around? */
function isActionEvent(ev: ActivityEvent): boolean {
  if (ev.type === "file_change") return true;
  if (ev.tool === "connector_call") return true;
  if (ev.tool === "Bash" || ev.type === "shell" || ev.type === "git") {
    const cmd = (ev.detail ?? ev.summary.replace(/^Bash: /, "")).trim();
    return cmd !== "" && !INSPECTION_RE.test(cmd);
  }
  return false;
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
