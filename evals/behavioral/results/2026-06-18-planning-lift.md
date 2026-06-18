# Behavioral-lift eval — 2026-06-18 (planning probes)

**Question:** does muscle memory actually change an agent's behavior, or do we only know it's
captured/retrieved? This is the value-side validation the deterministic eval can't give.

**Method:** 3 scenarios × {naive, equipped}, single-shot planning probes from
`build-prompt.ts`, each given to a fresh agent (Opus-class, the session default), graded per
`RUBRIC.md`. n=1 per cell. Each scenario's good step + pitfall is **project-specific** (a
naive agent can't guess it), so adoption present in equipped but absent in naive is
attributable to the injected workflow.

## Results

| scenario | learned step | naive adopts | equipped adopts | naive guards pitfall | equipped guards |
|---|---|---|---|---|---|
| S-DEPLOY | `make preflight` gate | ✗ | ✓ | ✗ | ✓ |
| S-DB | snapshot → `migrations-backup` first | ✗ (no backup proposed) | ✓ | ✗ | ✓ |
| S-FLAKY | pin clock via FakeClock helper | ~ (generic "deterministic clock") | ✓ (names the helper) | ✗ | ✓ (cites "only masks it") |

## Metrics

- **Good-step adoption:** naive **1/3** (33%, and the one hit was generic, not the project
  helper) → equipped **3/3** (100%). **Lift +2/3 clear, +1/3 specificity.**
- **Pitfall guard:** naive **0/3** → equipped **3/3**. **Lift +3/3.**

## Verdict

**Lift confirmed.** Muscle memory measurably improves the plan — most on **non-obvious,
project-specific** procedures (preflight gate, the backup bucket) and on **avoiding known
dead ends** everywhere. Notably the strong naive agent did **not** propose a backup before a
destructive migration; the equipped one did, because the pitfall was in its memory.

## Caveats (honest)

- **n=1, planning probes, strong model.** Intentions, not executed artifacts. A strong naive
  baseline *understates* the lift — with a weaker/cheaper agent (the realistic at-scale case)
  the gap widens, because more of the good step is non-obvious to it.
- The value is **largest for project-specific / hard-won knowledge** and **smallest where the
  good practice is already common knowledge** (S-FLAKY adoption tied; the win there was
  specificity + pitfall-avoidance). This is the honest shape of the value prop: keyoku pays
  off most on what a base model *doesn't already know*.
- Stronger follow-up (next): an **execution** eval — drive a real agent loop and count
  iterations-to-converge and whether it actually hit the dead end, naive vs equipped.
