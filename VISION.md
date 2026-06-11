# Keyoku Vision

**Keyoku maintains a living model of how you work — and keeps it runnable.**

The end state is not automation that fires uninvoked. It is *competence*: an
agent that knows how things are done here — your way — and acts well by
default. The workflow library is the agent's learned practice.

## Three laws

1. **Ground truth is immutable; meaning is layered.** Raw events are never
   rewritten. Intelligence stacks on top: raw events → episodes (task arcs
   with intent + outcome) → episode-types (what you repeatedly do) →
   workflows (what's runnable). Decay applies at every rung.
2. **Every workflow is a versioned hypothesis under evidence review.** After
   approval, new episodes keep matching against it: conforming runs add
   evidence, variants accumulate until a drift diff is proposed ("your
   release-prep gained a lint step — accept?"), absence decays it toward
   retirement, and repeated failures at one step trigger a research brief to
   the coding agent to self-heal it.
3. **Intelligence is additive and budgeted, never blocking.** Heuristics give
   recall for free. A native SLM (local Ollama, any OpenAI-compatible
   endpoint, Gemini, Anthropic) digests logs into episodes and intent labels.
   The coding agent does frontier-grade refinement and internet research.
   Every tier down degrades gracefully; every tier up gets smarter.

## The loop

```
observe → digest → living workflows → practice → bake → better agent → observe
```

- **Observe**: hooks record every command, edit, and MCP tool call locally.
- **Digest**: the SLM segments raw events into episodes and tags intent.
- **Living workflows**: mining over episodes; shadow matching; drift diffs;
  decay; self-healing. The library stays true without being maintained.
- **Practice**: workflows are consulted, not just invoked — injected at
  task time (UserPromptSubmit hook), published as MCP prompts (native slash
  commands), exported as agent skills.
- **Bake**: stabilized workflows graduate into the agent's own harness — the
  agent writes its own SKILL.md / CLAUDE.md / AGENTS.md entries from keyoku's
  guidance, with provenance headers and two-way sync (hand-edits are read
  back as evidence).

## Context layer

Pattern shapes alone are syntax. The knowledge store grounds them: MCP tool
self-descriptions (captured at connector_add), agent research briefs
(knowledge_submit), and accumulated annotations. Grounding unifies operations
across surfaces — `gh pr create` and `mcp__github__create_pr` are the same
operation — which is what lets workflows survive tool changes.
keyoku-engine (Go) is the brain this graduates into: storage, context graph,
decay, trigger scan. The harness's JSON files are the zero-dependency
fallback; engine present = brain on.

## Success criteria

1. **Time-to-first-truth**: minutes after install (transcript import),
   keyoku says something true about how you work that you never articulated.
2. **Earned attention**: ≥80% of surfaced suggestions are approved or
   acknowledged real. Precision over recall at the surfacing boundary.
3. **Workflows stay true**: drift is proposed by the system before the user
   notices staleness.
4. **Shrinking instructions**: correction/re-instruction rate falls over
   time — measurable from the activity stream itself.
5. **Never speaks mid-flow**: suggestions arrive at episode boundaries.

## Discipline

The vision is a map, not a backlog. Launch thin (trace → suggest → approve →
execute, plus transcript import and the prompts catalog); let real usage
re-order everything else. Every layer ships with the house method: simulate
realistic inputs, observe what the system actually does, fix what the
evidence shows, keep the simulation as a regression fixture.
