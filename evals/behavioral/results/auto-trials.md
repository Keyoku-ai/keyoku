# Behavioral-lift eval — automated multi-trial

Scenarios: 3 · trials/condition/scenario: 3 · metric: % of plans that adopted the learned step (good_signal).

| model | naive adopt | equipped adopt | lift |
|---|---|---|---|
| gemini-3.1-flash-lite | 0/9 (0%) | 9/9 (100%) | **+100pp** |
| gemini-2.5-flash-lite | 3/9 (33%) | 9/9 (100%) | **+67pp** |

Positive lift = muscle memory changed the plan toward the proven step. The weaker-model row checks the lift holds when the base reasoner is worse.
