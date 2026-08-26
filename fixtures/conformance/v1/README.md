# Keyoku Pulse conformance vectors · v1

These files are the stable cross-implementation contract for Keyoku Pulse v1alpha1. They are deterministic fixtures, not live product or deployment evidence.

- `manifest.json` defines canonical JSON, exact byte digests, replay expectations, source-conflict behavior, and dispatch outcomes.
- `events/*.jsonl` contains the exact lifecycle inputs, including reversed input, a deliberately ambiguous same-time event set, and incompatible source roots.
- `factfiles/verified.json` is a complete digest-valid Factfile used to bind the raw-file `bytesDigest` vector.
- `assets/demo-bytes.bin` and `assets/poster.svg` bind `digest` and `posterDigest` to exact fixture bytes. The `.bin` file is intentionally not playable media.

Regenerate and verify from repository source:

```bash
npm run fixtures:conformance
npx vitest run tests/conformance.test.ts
```

Changing any vector is a protocol change: update the conformance version or explicitly reconcile every consuming implementation.
