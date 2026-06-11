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
  let hint = event.summary.slice(0, 60);
  // Strip absolute paths — keep filename + extension
  hint = hint.replace(/(?:\/[^/\s]+)+\/([\w.-]+)/g, "*/$1");
  // Strip git commit messages
  hint = hint.replace(/"[^"]{15,}"/, '"..."');
  // Strip long hex hashes
  hint = hint.replace(/\b[0-9a-f]{7,}\b/g, "<hash>");
  return `${tool}:${hint}`.slice(0, 60);
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
  if (recent.length < 4) return [];

  const keys = recent.map(eventKey);
  const counts = new Map<string, { count: number; exemplar: ActivityEvent[] }>();

  for (let seqLen = 2; seqLen <= 4; seqLen++) {
    for (let i = 0; i <= recent.length - seqLen; i++) {
      const seq = keys.slice(i, i + seqLen);
      const key = seq.join(" → ");
      const existing = counts.get(key);
      if (existing) {
        existing.count++;
      } else {
        counts.set(key, { count: 1, exemplar: recent.slice(i, i + seqLen) });
      }
    }
  }

  const results: ActivitySuggestion[] = [];
  for (const [key, { count, exemplar }] of counts) {
    if (count < minCount) continue;

    const draftSteps: WorkflowStepTemplate[] = exemplar.map((ev) => {
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

    const parts = key.split(" → ");
    const firstTool = exemplar[0]?.tool ?? "workflow";
    const slug = `auto-${firstTool.toLowerCase().replace(/[^a-z0-9]/g, "")}-${results.length + 1}`;

    results.push({
      slug,
      name: `Auto: ${parts[0].split(":")[0]} → ${parts[parts.length - 1].split(":")[0]}`,
      description: `Detected ${count}× in recent activity (${parts.length} steps): ${parts.join(" → ")}`,
      count,
      draftSteps,
    });
  }

  // Sort by count desc, prefer longer sequences as tiebreaker
  results.sort((a, b) => b.count - a.count || b.draftSteps.length - a.draftSteps.length);

  // Deduplicate: skip suggestions that are subsequences of a higher-ranked one
  const seen = new Set<string>();
  return results
    .filter((s) => {
      const key = s.draftSteps.map((st) => st.summary.slice(0, 30)).join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

export function enrichWithEntities(event: ActivityEvent): ActivityEvent {
  if (event.entities && event.entities.length > 0) return event;
  return { ...event, entities: extractEntities(event) };
}
