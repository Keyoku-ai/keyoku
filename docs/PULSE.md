# Keyoku Pulse

Status: `v1alpha1` local thin slice
License: MIT
Scope: harness-neutral progress across exact-source Factfiles

A **Factfile** is proof for one bounded checkpoint. **Pulse** is trusted progress across checkpoints.

Pulse is not an agent transcript, a cron digest, a task tracker, or permission to send a message. It consumes typed lifecycle events from any harness, promotes only Factfile-bound checkpoints, deterministically decides whether an update is reportable, and renders several audiences from one content-bound snapshot.

## Local path

No Engine account or service is required:

```bash
# Inspect the contract with a generic JSONL fixture.
keyoku pulse fixture generic --out /tmp/pulse.jsonl
mkdir -p /tmp/pulse-project
keyoku pulse ingest --root /tmp/pulse-project --file /tmp/pulse.jsonl
keyoku pulse status --root /tmp/pulse-project --json
keyoku pulse plan --root /tmp/pulse-project --now 2026-08-24T16:05:00.000Z --debounce-ms 0 --json
keyoku pulse render --root /tmp/pulse-project --now 2026-08-24T16:05:00.000Z --debounce-ms 0 --audience timeline --out /tmp/pulse.html
```

The append-only ledger is `.keyoku/pulse/events.jsonl`. Replaying the same event id and digest is idempotent. Reusing an id with different content fails. Replay canonicalizes a valid event set by timestamp, lifecycle dependency rank, and event id, so arrival-order permutations produce the same state. Same-lease events that still have an ambiguous timestamp/rank fail closed rather than inheriting JSONL order.

## Adapter contract

Codex, Claude Code, GitHub Actions/CI, a webhook, or a generic process may write the same `keyoku.dev/pulse-event/v1alpha1` JSONL. ChatGPT or any other thread internals are never the canonical protocol.

Lifecycle types are:

- `started`
- `heartbeat`
- `verification_started`
- `checkpoint_published`
- `blocked`
- `failed`
- `completed`
- `abandoned`

Each lease names its harness, project, run, agent, canonical source root, bounded task/outcome, heartbeat, current state, source digest, and latest checkpoint. Every event and source identity has an exact SHA-256 content digest.

## Checkpoint promotion

A verified checkpoint contains one or more Factfile references, exact source, verification methods, a change story, visible assets, limitations, next task, and an optional human decision request.

For local Factfiles, do not hand-author a `checkpoint_published` event. Use:

```bash
keyoku pulse checkpoint publish --root /path/to/project --file checkpoint-draft.json --json
```

The command reads every Factfile, recomputes its canonical digest and bytes digest, and checks its Git head and worktree digest against the checkpoint source before appending the event. `adapter_attested` checkpoints must explicitly name the adapter and its responsibility. `fixture` bindings are demonstrations, never live evidence.

Visual assets follow the same rule. An asset without a resolved digest renders as **Evidence asset unresolved**, not as a working image or video. A live adapter must resolve and digest the real file before delivery.

## Deterministic dispatch

The planner returns exactly one outcome:

| Outcome | Meaning |
|---|---|
| `send` | One material verified checkpoint is ready for a separately authorized adapter |
| `defer` | Fresh work/verifying activity or the coalescing window is still open |
| `deduplicate` | The content-bound snapshot was already delivered |
| `suppress` | No material checkpoint exists, or source/project/future-state conflict fails closed |
| `coalesce` | Multiple compatible checkpoints share project and source ancestry |
| `stale_no_send` | An active lease is stale; freeze the last trusted checkpoint and send no normal update |

Partial uncheckpointed work never becomes a report. Future-dated events fail closed. Conflicting canonical roots or unconnected source ancestry fail closed. Cron may wake the planner to catch up an undelivered checkpoint, but time alone is not a material event.

Material triggers are limited to a verified checkpoint, owner decision, stopped regression, confirmed deployment incident, or recovery.

## Audience projections

The same snapshot digest renders:

- founder/stakeholder Markdown;
- developer evidence Markdown;
- accessible control-room timeline HTML;
- email-safe HTML;
- plain text;
- canonical JSON for API or MCP use.

Friendly model-written copy may be added only after the deterministic planner has selected a reportable snapshot. It must not change source, materiality, freshness, or dispatch decisions.

## Delivery authority

`planPulseDelivery` supports email, Slack, Teams, webhook, and MCP adapter plans. It returns a payload only when a current authority matches the channel and project. Fixture-bound checkpoints always return `no_send`, even with authority. The planner still does not perform the send. External delivery, retries, provider receipts, and permission storage belong to an explicit adapter or the optional Engine service.

## Processyard fixture

`keyoku pulse fixture processyard` provides a truthful M0–M6 integration fixture across Codex, Claude Code, and GitHub Actions identities. It includes:

- a long-running development lease blocked on an owner decision;
- prior checkpoint digests so M5 and M6 can coalesce while fresh;
- a later `stale_no_send` planning instant;
- unresolved Economy Theatre poster/video paths, labeled as fixture bindings because the media bytes are not present in this repository.

The fixture establishes the portable contract and deterministic story. It does not establish a production Processyard integration, a deployed service, a Gmail authority grant, or a sent founder email.
