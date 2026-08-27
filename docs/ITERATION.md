# Keyoku behavior-iteration compatibility contract

> This controller remains implemented and regression-tested as compatibility
> source, but its CLI and MCP verbs are not part of the bounded v3 public
> surface. v3 expresses incremental work through repeated `keyoku proof run`
> checkpoints plus Pulse. See [PUBLIC-SURFACE.md](PUBLIC-SURFACE.md).

Status: `v1alpha1`

Behavior iteration is Keyoku's provider-neutral loop for getting a software product from an observed evidence gap to a bounded, reviewable outcome. Keyoku owns the outcome contract, evidence rounds, stop policy, and receipt. A coding harness owns execution.

## Protocol

1. A human or harness starts a session for one repository-owned outcome.
2. Keyoku opens one contribution and runs every declared probe against the exact source state.
3. If evidence is missing, Keyoku emits a deterministic instruction containing the objective, constraints, failed claims, reproduction commands, regressions, and exact Git/worktree identity.
4. Any MCP-capable harness can fetch that instruction, perform product work, and report one idempotent checkpoint.
5. Keyoku records explicitly sourced usage, reruns the proof, and either emits the next instruction or stops.

The CLI and MCP surfaces use the same implementation:

| CLI | MCP |
|---|---|
| `keyoku iterate start <outcome>` | `iteration_start` |
| `keyoku iterate status <session>` | `iteration_status` |
| `keyoku iterate next <session>` | `iteration_next` |
| `keyoku iterate checkpoint <session> ...` | `iteration_checkpoint` |

## Ledger and idempotency

Events live under `.keyoku/runtime/iterations/<session>/events.jsonl`. This location is intentionally local evaluator state and is excluded from source proof. Every event has a monotonic sequence, the previous event digest, and its own canonical SHA-256 digest. Replay verifies the full chain before returning state.

Checkpoint ids are idempotency keys. Replaying an identical checkpoint returns the existing state without another proof round or another usage charge. Reusing the id with a different summary, usage, or provenance fails closed.

Each proof round records:

- contribution and portable Factfile identity;
- exact Git head, worktree digest, dirty flag, and changed paths;
- automated pass/fail totals;
- pending, passing, and failed human judgments;
- indexes of passing, failing, and newly regressed claims;
- consecutive checkpoints that produced no source change.

## Stop semantics

The controller is bounded by default to five rounds, one hour, and two consecutive no-progress checkpoints. Callers may lower or raise those limits within schema bounds and may add reported-token or reported-cost ceilings.

Terminal states are intentionally specific:

- `ready_for_review`: declared automated and human criteria pass for the exact snapshot; accountable acceptance is still separate.
- `human_review_required`: machine evidence passes, but one or more declared human judgments are pending.
- `review_blocked`: machine evidence passes, but an accountable human judgment failed.
- `stopped_round_limit`, `stopped_time_limit`, `stopped_no_progress`, `stopped_token_limit`, or `stopped_cost_limit`: the named bound ended the loop while evidence remained incomplete.

## Usage boundary

An agent checkpoint may report input, output, and cached-input tokens, tool calls, and cost. It must label the source as `provider_receipt`, `agent_reported`, or `unknown`. These values are operational bounds, not settled billing. Keyoku does not derive them from rendered chat messages or claim a provider receipt when none exists.

## Authority boundary

Keyoku never executes arbitrary agent commands in this protocol. It does not write product source, decide human criteria, accept a Factfile, push Git commits, deploy, or bypass application authorization. Those actions remain with the connected harness and accountable human. This separation lets Keyoku become the iteration layer without turning proof output into an autonomous actor or confusing agent activity with evidence.
