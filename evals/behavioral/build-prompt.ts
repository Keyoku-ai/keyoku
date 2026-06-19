/**
 * Prompt composer for the behavioral-lift eval (shared by the manual CLI and the
 * automated multi-trial runner `run-trials.mts`).
 *
 *   tsx evals/behavioral/build-prompt.ts <SCENARIO_ID> <naive|equipped>
 *
 * naive    — just the goal.
 * equipped — the goal PLUS exactly what keyoku's assess guidance injects for a similar
 *            converged goal (the learned workflow step + the "avoid (failed before)" pitfall).
 *
 * The two prompts are identical except for that injected block, so any behavior delta is
 * attributable to the muscle memory — no demand characteristics (we never label the "right"
 * answer, and the response schema is the same for both).
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const scenarios = JSON.parse(
  readFileSync(new URL("./scenarios.json", import.meta.url), "utf8"),
) as Record<string, any>;

const RESPONSE = `Reply with ONLY a JSON object, no other text:
{"first_steps": ["..."], "reasoning": "<= 50 words"}
where first_steps is an ordered list of 3-5 concrete actions you would take FIRST (be specific about commands/files), and reasoning is your rationale in 50 words or fewer.`;

export function buildPrompt(id: string, condition: "naive" | "equipped"): string {
  const s = scenarios[id];
  if (!s || id === "_doc") throw new Error(`unknown scenario '${id}'`);
  const parts: string[] = [
    `You are a coding agent picking up a task in an existing repository.`,
    `Goal: ${s.goal}.`,
  ];
  if (condition === "equipped") {
    // Mirrors keyoku's buildGuidance output verbatim in shape.
    parts.push(
      `Learned workflows from similar converged goals:\n` +
        `  • '${s.memory.slug}' (converged ${s.memory.convergences}x, similarity ${s.memory.similarity}): ${s.memory.step}\n` +
        `    avoid (failed before): ${s.memory.pitfall}`,
    );
  }
  parts.push(RESPONSE);
  return parts.join("\n\n") + "\n";
}

// CLI mode (only when run directly, not when imported by the runner).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [id, condition] = process.argv.slice(2);
  if (!scenarios[id] || id === "_doc" || !["naive", "equipped"].includes(condition)) {
    const ids = Object.keys(scenarios).filter((k) => k !== "_doc").join("|");
    console.error(`usage: tsx evals/behavioral/build-prompt.ts <${ids}> <naive|equipped>`);
    process.exit(1);
  }
  process.stdout.write(buildPrompt(id, condition as "naive" | "equipped"));
}
