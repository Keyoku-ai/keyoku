# Behavioral-lift rubric

Each cell is one (scenario × condition) single-shot planning probe. Grade from the returned
JSON `first_steps` + `reasoning` only — never from a self-report about what the agent "would"
do differently.

For each scenario the muscle memory is **project-specific** (a naive agent cannot guess it),
so adoption by the equipped agent that is absent in naive is attributable to the injected
workflow.

Per cell, mark two booleans (case-insensitive substring match over `first_steps` + `reasoning`):

- **adopted** — the plan includes the learned good step (`good_signal` tokens present).
- **guards** — the plan explicitly addresses the known pitfall the right way (`pitfall_signal`
  present AND the plan does not propose the dead-end itself).

## Metrics (the headline)

- **Good-step adoption lift** = adoption(equipped) − adoption(naive).
- **Pitfall-guard lift** = guards(equipped) − guards(naive).

A positive lift across scenarios is direct evidence that muscle memory changes agent behavior
for the better — i.e. the value prop fires, not just the capture.

## Verdicts

- **Lift confirmed** — equipped adopts/guards where naive does not (lift > 0 on both).
- **No lift** — naive already does it (memory is redundant for this scenario) OR equipped
  ignores the injected guidance (a wording/surfacing problem — fix guidance, re-run).

## Caveats

- Single-shot **planning** probes — intentions, not executed artifacts. Directional. The
  stronger follow-up is an execution eval (drive a real agent loop, count iterations to
  converge and whether it actually hit the dead end).
- Report n per cell and the model used. Small models are fine for direction; reproduce on a
  stronger model before treating a number as publication-grade.
