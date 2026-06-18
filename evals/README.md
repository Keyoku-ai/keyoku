# evals/ — quality validation for the learning loop

Tests prove **correctness** (pass/fail). Evals prove **quality** — that the harness
actually delivers on its promise, with metrics you can watch over time.

## Run

```bash
npm run eval        # deterministic; writes evals/REPORT.md, exits non-zero on a miss
```

It is also run in CI (`.github/workflows/ci.yml`), so a regression in retrieval quality
fails the build, not just a code bug.

## `muscle-memory.eval.ts` — retrieval quality

Validates the core promise: *converged goals become reusable workflows suggested for
similar goals.* Deterministic (no model, no network), so it gates CI safely. It seeds
converged "families" (each with a successful step **and** a failed approach → pitfall),
then assesses query goals and measures:

| metric | what it catches |
|---|---|
| **precision@1** (similar queries) | the *right* workflow is the top suggestion |
| **pitfall-surface rate** (similar) | failed approaches are re-surfaced as "avoid (failed before): …" |
| **false-positive rate** (dissimilar) | unrelated goals are NOT handed irrelevant muscle memory |

Latest run: see [`REPORT.md`](./REPORT.md).

## Extending — behavioral (model-driven) eval

The deterministic eval validates *retrieval*. To validate *behavioral lift* — does an
agent equipped with the suggested workflow + pitfalls converge in fewer iterations / avoid
the dead end vs. a naive agent? — add a model-driven harness:

1. Build matched prompts (naive vs. equipped-with-muscle-memory) for a fixed scenario.
2. Run each through a fresh agent (subagent / `claude -p`), small model fine for direction.
3. Grade from artifacts (iterations to converge, did it repeat the pitfall?), not
   self-reports. Write a dated file under `evals/results/`.

Keep model-driven evals OUT of the CI gate (non-deterministic); run them on demand and
record directional results, like the deterministic one records exact ones.
