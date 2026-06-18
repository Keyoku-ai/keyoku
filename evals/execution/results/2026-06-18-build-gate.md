# Execution-eval — 2026-06-18 (build-gate scenario)

Real autonomous agent loops (Bash + edit), Opus-class model, n=1/cell. Each agent had to make
`bash build.sh` print PASS by editing `config.env` only; the gate checks `MODE=strict`, with
`STRICT`/`REGION` as red-herrings (the dead-end).

| cell | converged | final fix | dead-end hit | iterations (tool calls) |
|---|---|---|---|---|
| naive | ✓ | `MODE=strict` | no | 5 |
| equipped | ✓ | `MODE=strict` | no | 4 |

- **Iteration delta:** +1 (equipped fewer). **Dead-end:** neither agent toggled `STRICT`/`REGION`.

## Verdict

**Modest lift, honestly understated.** Equipped went straight to `MODE=strict` (per the
injected workflow) and the gate passed on its first run; naive first *read* `build.sh`, saw
`[ "$MODE" != "strict" ]`, and then applied the same fix — one extra investigation step. Both
converged correctly and **neither fell for the red-herring**, because a strong base model
reads the gate and discovers the fix on its own.

This is the RUBRIC's predicted shape: **a strong model with a readable fix understates the
lift**. The gap widens where it matters — weaker/cheaper models, and fixes that *aren't*
discoverable by reading one file (project-specific gates, non-local causes, the kind of
hard-won knowledge muscle memory exists to carry). The planning eval already showed the
larger signal there (adoption 1/3 → 3/3; pitfall-guard 0/3 → 3/3).

## Next (stronger evidence)

- Average ≥5 trials/cell and add a **cheap-model** row — the realistic at-scale case where
  reading-the-gate isn't free and the red-herring actually catches the naive agent.
- A scenario whose fix is **not** readable from one file (requires cross-file/project
  knowledge), so the naive agent must search — where the workflow's value compounds.
