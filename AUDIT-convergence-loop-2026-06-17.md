# Keyoku audit — convergence-loop "build-then-verify" gap (2026-06-17)

Written by an agent (Claude Opus 4.8) after using Keyoku live to drive a feature build in
the `headroom` project. This is an audit + repro for **another agent to verify, test, and
fix**. The harness worked; one real friction made it fail to *learn* from a very common
workflow shape.

## How Keyoku was used this session

Goal: ship a feature in `~/Development/headroom` (a continuity handoff doc + skill reframe).
Flow exercised: `goal_create` (8 machine-checkable command probes with JMESPath asserts) →
implement the whole feature → `goal_assess` → (attempted) `goal_record`.

## What worked well ✅

- **`goal_create`** accepted command probes + JMESPath assertions cleanly; criteria were
  expressive enough to encode "tests pass" (`exitCode eq 0`), "tool registered"
  (`grep -c … gte 1`), "dogfood artifact exists" (`ls … | wc -l gte 1`), etc.
- **`goal_assess`** ran all 8 probes deterministically and detected convergence correctly
  in ~11s (it actually runs `npm test`, greps, etc. — real verification, not self-report).
  This is the strongest part: the assessment is grounded in machine truth.

## The gap ⚠️ — build-then-verify produces a HOLLOW promoted workflow

**Symptom.** I implemented the entire feature *before* the first `goal_assess`. On that
first assess the goal went straight `active → converged` with **`iterationsUsed: 0`**.
Keyoku then auto-promoted the action trace to a "reusable workflow" — but the trace was
**empty** (no `goal_record` calls had happened). So the promoted workflow has no steps and
teaches nothing.

**Made worse by:** calling `goal_record` *after* convergence is refused:

```
goal_record → {"error":"Goal '…' is already converged — there is nothing to act on.
Run goal_assess first; if the state drifted, the goal reactivates and recording resumes."}
```

So there is **no supported way to capture the actions that achieved convergence** if you
assess once, after doing the work. The loop assumes `assess → act → record` cycles strictly
*before* convergence. But "do the work, then verify it converged" is an extremely common —
arguably the default — agent workflow. Keyoku currently cannot learn from it.

## Why it matters

The headline value prop is "converged goals become reusable workflows suggested for similar
goals." A whole class of real runs (build-then-verify, and any run that converges on the
first assess) yields an **empty** workflow, silently. The library of learned workflows will
be biased toward slow/iterative goals and miss clean one-shot builds.

## Repro (deterministic)

1. `goal_create` a goal whose criteria already-or-soon pass.
2. Do all the work to satisfy the criteria **without** calling `goal_record`.
3. `goal_assess` once → observe `converged: true`, `iterationsUsed: 0`, and a promoted
   workflow.
4. Inspect the promoted workflow (`workflow_list` / template) → it has no action steps.
5. `goal_record` → rejected ("already converged").

## Proposed fixes (for the implementing agent to weigh)

1. **Allow retroactive `goal_record` on a just-converged goal** (e.g. within N minutes or
   until the workflow is finalized) so the achieving actions can be attached. Lowest-risk.
2. **Don't promote a zero-action trace to a workflow** — or mark it `provisional` and prompt
   for a post-hoc summary of what was done. Prevents silent hollow workflows.
3. **At `goal_create`, surface the contract**: "record actions *before* the final assess, or
   the learned workflow will be empty." Cheap guard-rail; documents the assumption.
4. **Optional, higher-effort:** auto-capture state deltas between assessments (changed files
   / commands from the session) as inferred actions, so learning doesn't depend on the agent
   remembering to `goal_record`.

## Test to add

- A test that a goal converging on the first assess with zero `goal_record` calls does NOT
  emit a hollow workflow (per whichever fix is chosen), and that retroactive record (fix 1)
  attaches to the converged goal's trace.

## Meta-note (does the harness explain its own usage?)

Yes — the Keyoku MCP server ships a clear protocol description (goal_create → assess → act →
record → repeat, with autonomy levels and connector gating). An agent can self-drive it from
that text alone; I did. The only protocol ambiguity is the one above: the docs imply the
act/record step always precedes convergence, which isn't true for build-then-verify. Fixing
that (or documenting it) closes the loop.
