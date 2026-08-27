# Demo evidence
Record a product demo with Playwright, have an agent watch and audit it, and gate the result — `keyoku demo record → watch → gate`.

Humans digest demos; exit codes don't persuade. This pipeline makes the demo
itself machine-checkable evidence.

## Pipeline
1. `keyoku demo init` → `.keyoku/demo.yaml`: baseUrl, optional auth steps, and
   **stops** — each with a url/actions and 1+ human-readable `expect` lines stating
   what must be VISIBLE in the frame.
2. `keyoku demo record` → Playwright executes the stops → `.keyoku/demo/frames/*.jpeg`
   + `manifest.json` (and video when configured).
3. `keyoku demo watch` → an agent looks at every frame: per-stop verdict
   (requirement_met true/false/partial + evidence_seen) **plus a UI/UX audit**
   (hierarchy, truncation, broken charts, color semantics) → `.keyoku/demo/verdict.json`.
4. Gate it: add a criterion `run: keyoku demo watch --assert` to the outcome —
   passes only if the verdict is a fresh pass (postdates the frames).

## Rules that make it work
- `expect` lines describe pixels, not intentions ("a TESTING PERIOD column with date
  ranges", not "periods work"). The watcher judges only what it can see.
- Fix rounds re-record BEFORE re-watching; the freshness assert exists to catch
  stale verdicts — never edit a verdict by hand.
- Treat watcher UI/UX findings as real defects with severities; the demo failing on
  a dead button that "worked" in scripted clicks is the pipeline earning its keep.
- After recording, LOOK at every frame yourself before handing to the watcher — a mis-timed capture (popover not yet open, spinner mid-frame) wastes a watch round.
- Keep stops ≈ 8–15; one concept per stop; realistic seeded data (real names, varied
  dates) — placeholder data is a credibility finding, not a shortcut.
