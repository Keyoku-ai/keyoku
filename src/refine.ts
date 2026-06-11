import type { ActivitySuggestion } from "./activity.js";
import type { SlmProvider } from "./slm.js";
import type { ActivityEvent, KnowledgeEntry } from "./types.js";

const STEP_TYPES = new Set(["bash", "agent_prompt", "mcp_call", "human_review"]);

/**
 * Model-assisted refinement of heuristic workflow suggestions. The heuristics
 * are the recall layer — cheap, local, zero-config. The SLM is the precision
 * layer: it drops coincidental sequences, writes real names and descriptions,
 * parameterizes commands that embed run-specific values, and downgrades
 * judgment-heavy steps from bash to agent_prompt. Any model failure falls back
 * to the heuristic drafts — the product never gets worse for lacking a key.
 */
export async function refineSuggestions(
  slm: SlmProvider,
  drafts: ActivitySuggestion[],
  recentEvents: ActivityEvent[],
  knowledge: KnowledgeEntry[] = [],
): Promise<ActivitySuggestion[]> {
  if (drafts.length === 0) return drafts;

  const context = recentEvents.map((e) => `- ${e.summary}`).join("\n");
  const knowledgeBlock =
    knowledge.length > 0
      ? `\nKnown context (operations and connectors the user works with):\n${knowledge
          .map((k) => `- [${k.subject}] ${k.fact}`)
          .join("\n")}\n`
      : "";
  const prompt = `You refine draft workflow automations mined from a developer's activity log.

Recent activity (newest last):
${context}
${knowledgeBlock}

Draft suggestions (heuristically mined, may contain noise):
${JSON.stringify(
    drafts.map(({ slug, name, description, count, draftSteps }) => ({ slug, name, description, count, draftSteps })),
    null,
    2,
  )}

Rules:
- DROP drafts that are coincidental sequences rather than a repeatable workflow.
- Rewrite "name" as a short imperative label and "description" as one helpful sentence.
- Keep "slug" and "count"; keep step order; only remove a step if it is pure noise.
- For bash steps whose command embeds a run-specific value (a branch, file, or message), replace that value with a {{placeholder}} and mention it in the description.
- If a step needs judgment rather than a fixed command, use type "agent_prompt" with a clear prompt.
- Step "type" must be one of: bash, agent_prompt, mcp_call, human_review.

Return ONLY JSON: {"suggestions":[{"slug":"...","name":"...","description":"...","count":3,"draftSteps":[{"type":"bash","summary":"...","command":"..."}]}]}`;

  try {
    const raw = await slm.complete(prompt, { json: true, maxTokens: 2048 });
    const parsed = JSON.parse(raw) as { suggestions?: unknown };
    if (!Array.isArray(parsed.suggestions)) return drafts;
    const valid = parsed.suggestions.filter(isValidSuggestion).slice(0, 5);
    return valid.length > 0 ? valid : drafts;
  } catch {
    return drafts;
  }
}

function isValidSuggestion(s: unknown): s is ActivitySuggestion {
  if (typeof s !== "object" || s === null) return false;
  const v = s as Record<string, unknown>;
  return (
    typeof v.slug === "string" &&
    typeof v.name === "string" &&
    typeof v.description === "string" &&
    typeof v.count === "number" &&
    Array.isArray(v.draftSteps) &&
    v.draftSteps.length > 0 &&
    v.draftSteps.every(
      (st) =>
        typeof st === "object" &&
        st !== null &&
        STEP_TYPES.has(String((st as Record<string, unknown>).type)) &&
        typeof (st as Record<string, unknown>).summary === "string",
    )
  );
}
