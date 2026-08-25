# Pulse integration fixtures

- `generic.jsonl` is the harness-neutral JSONL/stdin contract.
- `processyard-m0-m6.jsonl` is the Processyard M0–M6 multi-harness story.
- `processyard-coalesced.json` is the deterministic M5+M6 coalescing decision while the long-running lease is freshly blocked on an owner decision.
- `processyard-stale-no-send.json` is the later fail-closed decision after that lease becomes stale.
- `processyard-timeline.html` is the audience projection from the coalesced snapshot.

These are generated fixtures, not live customer evidence. The Economy Theatre media paths intentionally remain unresolved because the corresponding bytes are not present in this repository; the HTML labels that state and renders no broken image.

Regenerate after building:

```bash
npm run build
npm run fixtures:pulse
```
