/**
 * Automated, multi-trial behavioral-lift eval (#54).
 *
 * For every scenario, prompts a model to plan its first steps under TWO identical
 * conditions except for keyoku's injected muscle memory (naive vs equipped), N
 * trials each, across one or more models (a strong + a weaker row). It scores
 * whether the plan ADOPTED the learned step (good_signal) — the lift muscle
 * memory buys — and emits a tracked metric + markdown report.
 *
 *   GEMINI_API_KEY=… tsx evals/behavioral/run-trials.mts
 *   KEYOKU_EVAL_MODELS=gemini-3.1-flash-lite,gemini-2.5-flash-lite \
 *   KEYOKU_EVAL_TRIALS=3 tsx evals/behavioral/run-trials.mts
 *
 * Model-driven and non-deterministic by nature → run on demand, not in CI.
 */
import { writeFileSync } from "node:fs";
import { buildPrompt, scenarios } from "./build-prompt.js";
import { createSlm } from "../../src/slm.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Set GEMINI_API_KEY to run the behavioral trials.");
  process.exit(1);
}
const MODELS = (process.env.KEYOKU_EVAL_MODELS ?? "gemini-3.1-flash-lite,gemini-2.5-flash-lite")
  .split(",").map((m) => m.trim()).filter(Boolean);
const TRIALS = Math.max(1, Number(process.env.KEYOKU_EVAL_TRIALS ?? 3));
const ids = Object.keys(scenarios).filter((k) => k !== "_doc");

const adopted = (text: string, signals: string[]): boolean => {
  const t = text.toLowerCase();
  return signals.some((sig) => t.includes(String(sig).toLowerCase()));
};

interface Cell { adopt: number; total: number; }
const results: Record<string, { naive: Cell; equipped: Cell }> = {};

for (const model of MODELS) {
  const slm = createSlm({ provider: "gemini", apiKey, model });
  const row = { naive: { adopt: 0, total: 0 }, equipped: { adopt: 0, total: 0 } };
  for (const cond of ["naive", "equipped"] as const) {
    for (const id of ids) {
      const s = scenarios[id];
      for (let t = 0; t < TRIALS; t++) {
        row[cond].total++;
        try {
          const raw = await slm.complete(buildPrompt(id, cond), { json: true, maxTokens: 400 });
          if (adopted(raw, s.good_signal)) row[cond].adopt++;
        } catch { /* a failed call counts as non-adoption */ }
      }
    }
  }
  results[model] = row;
  const pct = (c: Cell) => (c.total ? Math.round((c.adopt / c.total) * 100) : 0);
  console.log(`${model}: naive ${pct(row.naive)}%  equipped ${pct(row.equipped)}%  lift +${pct(row.equipped) - pct(row.naive)}pp`);
}

const pct = (c: Cell) => (c.total ? Math.round((c.adopt / c.total) * 100) : 0);
const lines = [
  "# Behavioral-lift eval — automated multi-trial",
  "",
  `Scenarios: ${ids.length} · trials/condition/scenario: ${TRIALS} · metric: % of plans that adopted the learned step (good_signal).`,
  "",
  "| model | naive adopt | equipped adopt | lift |",
  "|---|---|---|---|",
  ...MODELS.map((m) => {
    const r = results[m];
    return `| ${m} | ${r.naive.adopt}/${r.naive.total} (${pct(r.naive)}%) | ${r.equipped.adopt}/${r.equipped.total} (${pct(r.equipped)}%) | **+${pct(r.equipped) - pct(r.naive)}pp** |`;
  }),
  "",
  "Positive lift = muscle memory changed the plan toward the proven step. The weaker-model row checks the lift holds when the base reasoner is worse.",
];
const out = new URL("./results/auto-trials.md", import.meta.url);
writeFileSync(out, lines.join("\n") + "\n");
console.log(`\nReport → evals/behavioral/results/auto-trials.md`);
