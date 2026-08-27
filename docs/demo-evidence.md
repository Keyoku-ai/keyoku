# Demo evidence: record → watch → gate

`keyoku demo` turns a scripted product demo into a recorded, agent-watched,
machine-checkable piece of evidence — usable in **any** project, not just
Keyoku itself.

## Why

Humans digest a demo instantly: open the app, click through the flow, look
at what's on screen. That's exactly the evidence a reviewer actually trusts
— more than a green test suite, because it shows the thing the user will
see. But a demo is normally a one-off, unrecorded, unverifiable act: someone
clicked through it once, said "looks good," and that moment is gone.

Coding agents can watch a demo the same way a human does — by looking at
screenshots and checking them against stated expectations. `keyoku demo`
makes that watching step first-class:

1. **`keyoku demo record`** drives a real browser through a scripted walk of
   the running app and captures one screenshot ("frame") per stop, plus a
   manifest of what each frame is supposed to show.
2. **`keyoku demo watch`** has an agent actually look at each frame, check
   it against the stated expectations, and also run a general UI/UX audit
   across the whole demo — then write a structured verdict.
3. **`keyoku demo watch --assert`** turns that verdict into a pass/fail exit
   code, so `keyoku demo record && keyoku demo watch --assert` can be pasted
   straight into an outcome's `criteria[].probe.run` — the watched demo
   becomes part of the proof, not a claim about the proof.

Keyoku's evidence model (`EvidencePresentationSchema` in `src/contribution.ts`)
already supports `artifacts[].kind: "screenshot"` / `"video"` in a Factfile.
`keyoku demo` is the workflow that actually *produces* those artifacts and
validates them before they're presented, instead of leaving it to whoever
proposed the change to attach (or not attach) a screenshot by hand.

## The `demo.yaml` schema

`keyoku demo init` writes `.keyoku/demo.yaml` (never overwrites an existing
one) with a commented template. Full shape:

```yaml
baseUrl: http://localhost:3000       # required — where the app is running

viewport:                            # optional, default 1440x900
  width: 1440
  height: 900

settleMs: 2500                       # optional, default 2500 — wait after
                                      # navigating/acting, before the shot

fullPage: true                       # optional, default true — can be
                                      # overridden per-stop

auth:                                # optional — runs ONCE, before stop 1
  url: /login                        # relative to baseUrl, or absolute
  steps:                             # same Action union as stops[].actions
    - fill: { selector: "#email", value: "demo@example.com" }
    - fill: { selector: "#password", value: "demo-password" }
    - click: "button[type=submit]"
    - waitMs: 1000

stops:                               # required, at least one
  - id: dashboard                    # required, slug (lowercase/digits/-._)
    title: Dashboard                 # optional, shown to the watching agent
    url: /dashboard                  # optional — relative to baseUrl or
                                      # absolute; omit to stay on the current
                                      # page (e.g. after a click from a
                                      # previous stop)
    actions:                         # optional, run in order after goto
      - click: "#nav-settings"
      - waitMs: 500
    fullPage: false                  # optional, overrides the global default
    expect:                          # REQUIRED, at least one — plain
                                      # language assertions about what must
                                      # be VISIBLE in this frame
      - "The main navigation is visible"
      - "At least one summary metric card is rendered with a non-empty value"
    caption: "Landing view after login"   # optional, shown in the report
```

`Action` (used in both `auth.steps` and `stops[].actions`) is one of:

```ts
type Action =
  | { goto: string }
  | { click: string }
  | { fill: { selector: string; value: string } }
  | { select: { selector: string; label: string } }
  | { press: string }
  | { waitMs: number };
```

## Recording

`keyoku demo record`:

1. Reads and zod-validates `.keyoku/demo.yaml`.
2. Launches Chromium via `playwright`, resolved from **the target project**
   (via `createRequire` against that project's own `package.json`) — not
   from keyoku's own dependencies. If `playwright` isn't installed there,
   the command exits with a clear message: `npm i -D playwright`.
3. Runs `auth` once, if present.
4. For each stop, in order: `goto` (if `url` given) → run `actions` → wait
   `settleMs` → screenshot to
   `.keyoku/demo/frames/<NN>-<stop-id>.jpeg` (JPEG, quality 80, animations
   disabled, full-page unless overridden).
5. Writes `.keyoku/demo/manifest.json`:

```json
{
  "recordedAt": "2026-08-23T12:00:00.000Z",
  "baseUrl": "http://localhost:3000",
  "stops": [
    {
      "id": "dashboard",
      "order": 1,
      "frame": ".keyoku/demo/frames/01-dashboard.jpeg",
      "title": "Dashboard",
      "expect": ["The main navigation is visible", "..."],
      "caption": "Landing view after login"
    }
  ]
}
```

A stop that throws (bad selector, navigation failure, timeout, ...) is
recorded and reported by id, and the command exits non-zero — but every
*other* stop still gets attempted and included in the manifest.

## Watching — the verdict contract

`keyoku demo watch` reads the manifest, builds one prompt covering every
frame plus its `expect` list, and runs it through an agent. The default
runner is the `claude` CLI:

```
claude -p "<prompt>" --permission-mode acceptEdits
```

run with `cwd` set to the project root. If `claude` isn't on `PATH`, the
command exits with code `2` and names the contract below, so **any other
agent runner can be substituted** — the only requirement is that it writes
`.keyoku/demo/verdict.json` matching this shape:

```json
{
  "watched_at": "2026-08-23T12:05:00.000Z",
  "frames": [
    {
      "id": "dashboard",
      "requirement_met": true,
      "evidence_seen": "Top nav with 4 links is visible; 3 metric cards show non-empty values.",
      "concerns": []
    }
  ],
  "overall": {
    "frames_pass": 1,
    "frames_partial": 0,
    "frames_fail": 0,
    "verdict": "pass",
    "summary": "Dashboard renders as expected; no missing elements."
  },
  "uiux_audit": {
    "findings": [
      { "severity": "low", "description": "Metric card labels truncate on narrow viewports.", "suggested_fix": "Wrap instead of truncating, or shorten labels." }
    ],
    "top_priorities": ["Fix metric card label truncation"]
  }
}
```

- `requirement_met` is `true`, `false`, or `"partial"` per frame.
- `overall.verdict` is `"pass"` **if and only if** no frame has
  `requirement_met === false`.
- `uiux_audit` is a separate, cross-frame pass — visual hierarchy, density,
  truncation, empty/broken charts, color semantics, cross-page consistency —
  independent of whether the per-stop `expect` assertions held.

After the run, `keyoku demo watch` validates `verdict.json` against this
contract with zod and prints a summary (pass/partial/fail counts, failing
frames, top UI/UX findings).

## Gating: `--assert`

`keyoku demo watch --assert` exits:

- **`0`** only if `overall.verdict === "pass"` **and**
  `verdict.watched_at` is strictly newer than `manifest.recordedAt` (i.e.
  the verdict is actually about the demo that was just recorded, not a
  stale one from a previous run).
- **`1`** otherwise, printing which frames failed/partialed or why the
  verdict was considered stale.
- **`2`** for setup problems (no manifest, no `claude` CLI, a verdict that
  doesn't match the contract).

This makes `keyoku demo record && keyoku demo watch --assert` a valid
`command` probe for an outcome criterion — `keyoku demo init` prints a
ready-to-paste snippet:

```yaml
- description: "The recorded product demo passes agent review"
  probe:
    kind: command
    run: "keyoku demo record && keyoku demo watch --assert"
    timeoutMs: 900000
  assert:
    path: exitCode
    op: eq
    value: 0
  evidence:
    summary: "An agent watched the recorded demo frames against their stated expectations and ran a UI/UX audit."
    whyItMatters: "The demo is recorded evidence, not a claim about it — the same frames a human would watch are what the agent checked."
    code: []
    artifacts:
      - kind: screenshot
        path: ".keyoku/demo/frames/*.jpeg"
        label: "Recorded demo frames"
        caption: "One frame per stop, captured by keyoku demo record"
```

`timeoutMs: 900000` (15 minutes) matches the raised `CommandProbeSchema` /
`HttpProbeSchema` cap in `src/types.ts` — a real record → launch-agent →
watch round trip, on a real frontend build, routinely exceeds the old
5-minute cap.
