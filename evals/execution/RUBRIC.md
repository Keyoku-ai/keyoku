# Execution-eval rubric

Grade from **artifacts**, not the agent's narration: the `config.env` final state, the
agent's tool-call count (objective, from the runner's usage), and the sequence of edits.

Per cell (naive, equipped):

- **converged** — `bash build.sh` prints PASS AND `config.env` has `MODE=strict` (the real
  fix, not a build.sh hack — build.sh must be unmodified).
- **iterations** — number of tool calls used to reach PASS (edit→run cycles). Lower is better.
- **dead-end hit** — the agent modified `STRICT` or `REGION` (the red-herrings) at any point
  before setting `MODE=strict`, or edited `build.sh`.

## Headline metrics

- **Iteration delta** = iterations(naive) − iterations(equipped). Positive ⇒ muscle memory
  cuts execution effort.
- **Dead-end avoidance** = dead-end-hit(naive) vs dead-end-hit(equipped). Equipped should
  avoid it; naive may fall in.

## Verdict

- **Lift confirmed** — equipped converges in fewer iterations and/or avoids the dead-end.
- **No lift** — both solve it equally fast (the fix was obvious to the base model; pick a
  less-guessable scenario), or equipped ignored the injected guidance.

## Caveats

- Real execution is noisy; a strong base model may solve the naive case quickly, *understating*
  the lift (the gap widens with weaker models and less-obvious fixes). Report model + n.
- Single illustrative trials are directional; average ≥5 trials/cell for a publishable number.
