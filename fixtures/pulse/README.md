# Pulse integration fixtures

- `generic.jsonl` is the harness-neutral JSONL/stdin contract.
- `processyard-m0-m6.jsonl` is the Processyard M0–M6 multi-harness story.
- `processyard-coalesced.json` retains its historical filename but now records the fail-closed `attested_checkpoint` suppression decision.
- `processyard-stale-no-send.json` is the later fail-closed decision after that lease becomes stale.
- `processyard-timeline.html` explains why no audience projection exists for synthetic attested checkpoints.

These are generated fixtures, not live customer evidence. They are visibly
`attested`, never `verified`, and never dispatchable. The Economy Theatre media
paths intentionally remain unresolved because the corresponding bytes are not
present in this repository.

Regenerate after building:

```bash
npm run build
npm run fixtures:pulse
```
