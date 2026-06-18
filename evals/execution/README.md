# evals/execution/ — does muscle memory reduce *execution* effort?

The planning eval (`../behavioral/`) shows agents *intend* to use muscle memory. This one
shows the **outcome**: an agent that actually executes a task converges in **fewer
iterations** and **avoids the known dead-end** when equipped with a learned workflow +
pitfall, vs. a naive agent working cold. Model-driven, so run on demand (not CI-gated).

## Scenario

A broken "build gate": `bash build.sh` fails until `config.env` has `MODE=strict`. The
config is salted with red-herrings (`STRICT`, `REGION`) that look like the fix but aren't —
the **dead-end** a naive agent burns turns on. Fix is `MODE=strict`; build.sh must not be
edited.

```bash
node evals/execution/setup-scenario.mjs /tmp/exec-naive
node evals/execution/setup-scenario.mjs /tmp/exec-equipped
```

## Run

Give each scenario dir to a fresh agent **with Bash**, told to make `bash build.sh` print
PASS by editing `config.env` only:

- **naive** — task only.
- **equipped** — task + exactly what keyoku's `goal_assess` guidance injects:
  > Learned workflow 'fix-build-gate' (converged 3x): set `MODE=strict` in config.env.
  > avoid (failed before): toggling `STRICT=true` or changing `REGION` — the gate only checks `MODE`.

## Metrics (RUBRIC.md)

- **iterations to PASS** — tool calls the agent used (proxy for edit→run cycles). Lower = better.
- **dead-end hit** — did it change `STRICT`/`REGION` before `MODE`? Equipped should not.

Latest run: see `results/`.
