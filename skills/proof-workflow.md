# Proof workflow
Bind work to a versioned outcome, keep status current, and close with a fail-closed evidence gate — the Keyoku contribution flow.

## Flow
1. `project_inspect` / `outcome_list` (MCP) or `keyoku project init` — find or create
   the project contract.
2. Author/select an **outcome**: objective, constraints, `criteria` (each with an
   executable probe + assert + evidence prose: summary and whyItMatters), and
   `humanCriteria` for judgments that stay with the accountable owner. Probes must
   assert BEHAVIOR (build passes, live endpoint reconciles, verdict fresh) — never
   file presence.
3. `contribution_start` — bind actors (agent includes harness, model, ownerId).
4. `contribution_report_work` — one item per requirement; status done/blocked with a
   detail that names the evidence. Activity is coordination, never proof.
5. `contribution_propose_directions` — 1–4 evidence-grounded next moves before gating.
6. `contribution_gate` — executes every probe fail-closed, binds the snapshot,
   renders the Factfile (json/md/html). Passing probes + pending human judgments ⇒
   `human_review_required`: correct, not a failure.

## Invariants (learned the hard way)
- **Changing an outcome file requires a revision bump + a new contribution** — the
  gate refuses a silently-drifted contract. Plan criteria before gating.
- Freshness matters: a verdict/evidence artifact must postdate what it judges.
- Multi-repo workspaces without a root git repo lose baseSha binding — add a probe
  that pins each subrepo's PR head SHA == local HEAD.
- Write probes as committed scripts (`.keyoku/probes/*.sh`), each with a comment
  saying what it PROVES; every Factfile row then carries its reproduce command.
