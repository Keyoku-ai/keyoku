# Optional assurance adapter

Keyoku can act as an optional evidence provider around a caller's work. It is not an
agent runner, runtime-neutral protocol, scheduler, or control plane. A caller can use
no assurance, its own basic checks, or Keyoku high assurance; that profile is caller
policy and is deliberately absent from the neutral evidence envelope.

## EvidenceProvider

`evidence-provider/v1` accepts a neutral work identity and objective, claims, source
or deployment snapshots, command **results**, artifact digests, limitations,
authority, and a canonical content digest. Keyoku does not execute commands through
this adapter. It deterministically returns `accepted`, `rejected`, `stale`, or
`human_review_required`, with exact reason codes and a canonical result digest.
Evaluation is side-effect free and does not mutate the caller's object.

```sh
keyoku factfile assess --file evidence.json --json
```

MCP exposes the same evaluator as `evidence_evaluate`. It has no shell-execution or
human-acceptance capability.

## Neutral WorkEvent bridge

`work-event/v1` carries only neutral `dispatch`, `checkpoint`, `milestone`,
`decision`, `regression`, `recovery`, `stale`, or `terminal` outcomes. The local sink
stores validated, content-digested events in `.keyoku/pulse/work-events.jsonl` with
idempotent IDs and conflict rejection. The local sink rejects symlinked storage
paths, serializes writers with an exclusive fail-closed lock, appends through
identity-checked descriptors, and fsyncs the ledger and parent directory. A crash
may leave a `.lock` file; inspect it and confirm no writer is alive before removing
it and retrying. This is cooperative same-user process safety, not containment
against a malicious process running as that OS user:

```sh
keyoku pulse work-event ingest --file event.json --root /project --json
keyoku pulse work-event list --root /project --json
```

MCP exposes the same functions as `pulse_work_event_ingest` and
`pulse_work_event_list`. WorkEvents are coordination input: they never promote
themselves into a verified Factfile or dispatchable Pulse snapshot.

An HTTP/webhook integration may wrap these pure functions in caller-owned transport,
authentication, replay protection, and authorization. Keyoku core does not start a
webhook listener, authenticate arbitrary runtimes, send delivery, or prescribe a
neutral agent protocol.

See `fixtures/assurance/v1` for generic synthetic data. The fixture names no agent
product or harness and is not live proof.
