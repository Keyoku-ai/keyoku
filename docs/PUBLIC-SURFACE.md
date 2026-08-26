# Keyoku v3 public surface

This document is a release boundary, not a roadmap. The executable inventory in
[`src/public-surface.ts`](../src/public-surface.ts) drives the public CLI help and
MCP registration. Tests compare the built entrypoint with that inventory.

## CLI

| Command | Bounded responsibility |
|---|---|
| `keyoku proof …` | Create, run, review, accept, and present proof for one repository-owned outcome |
| `keyoku factfile inspect …` | Validate and explain one content-bound Factfile |
| `keyoku factfile verify …` | Also require the current Git head and worktree to match the Factfile |
| `keyoku factfile assess …` | Evaluate one neutral evidence envelope without running commands or changing caller state |
| `keyoku factfile publish …` | Explicitly publish a verified Factfile to an optional Engine endpoint |
| `keyoku pulse …` | Ingest lifecycle events, verify checkpoints, plan dispatch, and render projections without sending |
| `keyoku serve` | Serve the bounded MCP tool set over stdio |
| `keyoku doctor` | Report installation, project, optional Engine, and authority boundaries |
| `keyoku version` / `keyoku help` | Discovery only |

`proof review` and `proof accept` require an identified human on the local CLI.
They are deliberately absent from MCP. Any source change makes the prior
Factfile stale and requires a new proof run before review or acceptance.

## MCP

The v3 server exposes thirteen tools:

- Proof-session coordination: `contribution_report_work`,
  `contribution_request_decision`, `contribution_next_instruction`,
  `contribution_ack_instruction`, and `contribution_gate`.
- Assurance: `evidence_evaluate`.
- Pulse: `pulse_event_ingest`, `pulse_checkpoint_publish`,
  `pulse_work_event_ingest`, `pulse_work_event_list`, `pulse_status`,
  `pulse_dispatch_plan`, and `pulse_projection_render`.

There is no MCP tool that accepts human review, runs an agent, changes delivery
authority, sends a message, manages connectors, executes a learned workflow, or
operates the v2 memory/goal system.

The optional assurance adapter is not a runtime-neutral agent standard. Callers
retain work orchestration and choose `none`, `basic`, or
`keyoku_high_assurance` in their own policy. That profile is not required by or
encoded in the neutral evidence envelope.

The human or local workflow opens the contribution with `keyoku proof run` and
passes its id to the coding harness. MCP deliberately cannot create a free-form
goal or silently choose the repository's definition of done.

## Compatibility boundary

The v2 goal, workflow, connector, activity, memory, and execution implementation
remains in source for regression and migration work. Its test entrypoint is not
listed in `package.json` files and is not part of the v3 npm archive. Until the
owner approves a v3 release, npm `latest` remains on the v2 release line. The
explicit rollback for a future v3 alpha is `npm install keyoku@2`.

The bounded v3 verifier runs repository command and HTTP criteria. Command
criteria run sequentially in fresh disposable checkouts from one exact source
capsule and must not write to that checkout. This is evidence isolation, not an
OS sandbox: arbitrary commands still have the caller's user and network
authority, and daemonizing or process-group-escaping commands are outside the
trusted repository-command support boundary. A legacy MCP
criterion fails closed because connector management is not shipped or registered
in the v3 entrypoint; migrate that observation behind a repository-owned command
or HTTP check before adopting v3.
