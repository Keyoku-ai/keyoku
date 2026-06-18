# evals/behavioral/ — does muscle memory change behavior?

The deterministic eval (`../muscle-memory.eval.ts`) proves muscle memory is **captured and
retrieved**. This one proves it is **useful** — that an agent *given* a learned workflow +
pitfall plans/acts better than one without. That is the actual product claim, so it gets its
own validation.

This eval is **model-driven** (an agent is the subject), so it is **not** in the CI gate —
run it on demand and record directional results, the way the deterministic eval records exact
ones.

## Run

Each cell is one (scenario × condition). Generate the prompt and hand it to a fresh agent
(subagent / `claude -p` / any harness):

```bash
tsx evals/behavioral/build-prompt.ts S-DEPLOY naive
tsx evals/behavioral/build-prompt.ts S-DEPLOY equipped
# … for each scenario in scenarios.json × {naive, equipped}
```

`naive` and `equipped` differ only by the injected block — exactly what keyoku's `goal_assess`
guidance surfaces for a similar converged goal (the learned step + `avoid (failed before): …`).
Collect each plan, grade per [`RUBRIC.md`](./RUBRIC.md), and write a dated file under
`results/`.

## Metrics

- **Good-step adoption lift** = adoption(equipped) − adoption(naive)
- **Pitfall-guard lift** = guards(equipped) − guards(naive)

Latest run: [`results/2026-06-18-planning-lift.md`](./results/2026-06-18-planning-lift.md) —
adoption 1/3 → 3/3, pitfall-guard 0/3 → 3/3 (Opus-class, n=1).

## Roadmap (stronger evidence)

- **Execution eval:** drive a real agent loop to convergence; count iterations and whether it
  hit the dead end, naive vs equipped. Planning probes show intent; execution shows outcome.
- **Weaker-model row:** the lift grows as the base agent knows less — run a cheap model to
  show the realistic at-scale gap.
- **Auto-recorded workflows:** once auto-record lands (`feat/auto-record`), seed this eval from
  *real* captured workflows instead of hand-authored memory, closing the loop end to end.
