# Production readiness

Honest status of keyoku as a product other people depend on. The convergence
engine is production-grade; this tracks the **operational shell** around it.
Grouped by who can close each item: ✅ done · 🟡 needs maintainer (one-time,
out of code) · 🔵 next in code.

## Tier 1 — table stakes

### ✅ Release integrity (done — 2.8.0)
- `npm run preflight` + a CI step in `release.yml` verify, before any tag ships:
  valid semver, CHANGELOG entry present, `VERSION` single-sourced from
  package.json (the 2.7.1 "0.1.0" drift can't recur), the **built artifact
  reports the right version**, and `dist` is in the tarball.
- The release workflow already runs typecheck → test → eval → preflight.

### 🟡 npm Trusted Publishing (maintainer, ~2 min, one-time)
CI **cannot publish** today — there is no `NPM_TOKEN` and no Trusted Publishing
configured, so every release so far went out via the maintainer CLI
(`npm publish`), with **no provenance**. The workflow is already OIDC-ready
(`id-token: write`, npm upgraded). Close it once:

> npmjs.com → package **`keyoku`** → Settings → **Trusted Publishing** → add
> repository **`Keyoku-ai/keyoku`**, workflow **`release.yml`**.

After that, pushing a `vX.Y.Z` tag publishes automatically, tokenless, with
provenance. (Full detail in `docs/PUBLISHING.md`.)

### 🟡 Repo consolidation (maintainer)
Two working trees clone the same repo: `~/Development/Keyoku/keyoku-harness`
(the one the **live MCP server runs** — `dist/index.js`) and
`~/Development/Keyoku Harness/keyoku-harness` (used for site deploys). Editing
the wrong one ships nothing. Pick one canonical checkout; it's a foot-gun for
any contributor. See `docs/REPO-MAP.md`.

### ✅ Store growth bounds (done, pre-existing)
`activity.jsonl` self-caps (trims at ~2.5 MB → last 8k events, `store.ts`);
observations cap per goal (500 → 400). A large file on disk just means the
*old* global install (pre-cap) was writing it — the current build trims it.
Remaining minor gaps (🔵): `audit.jsonl` and `knowledge.jsonl` are unbounded
(both small today); add the same size-cap if they grow.

### 🔵 Store concurrency
The JSON store is synchronous, atomic (tmp+rename), cacheless, last-writer-wins
per entry — fine for one machine / a few sessions. Team or heavy multi-session
use wants real atomic ops or a SQLite backend (the `Store` interface is already
the seam for that swap). Documented in `store.ts`.

## Tier 2 — the product promise (learning that compounds)

### ✅ Self-pruning (done — 2.8.0)
Suggestions now rank by `similarity × precision`, where precision is learned
from whether a workflow's steps actually recur in later converged goals. A
workflow that only ever word-matches sinks. This is the first real
**outcome-grounded** signal in retrieval. (`recordSuggestionOutcomes` +
`suggestWorkflows` in `engine.ts`.)

### 🔵 Semantic retrieval
Recall is still jaccard (token overlap) — the lite-model re-rank layers on top
but needs a key. Embeddings via the BSL engine/brain would finish the
"no-heuristics" path for the offline/no-key case.

### 🔵 Validation depth
Lift is proven directionally (behavioral planning 1/3→3/3, one execution run,
both n=1). A production claim wants multi-trial runs, a weaker-model row, and a
behavioral metric tracked over time — today only the deterministic retrieval
eval gates CI (`npm run eval`); the value evals are manual.

## Tier 3 — trust & adoption

### 🔵 Data trust (it reads your activity)
Secret redaction exists at record time (`activity.ts`). Still wanted: a
retention policy, scoping/opt-out controls, and a `keyoku inspect` that shows
exactly what's in `~/.keyoku`. For a tool that ingests computer activity (and
the basis for Lar's onboarding), this is make-or-break before broad promotion.

### 🔵 Docs / site currency
2.2→2.8 shipped a lot (goal_focus, pitfalls, re-rank, self-pruning). Per the
ship-propagation rule, the site/README/quickstart should teach the new
flagship (`goal_focus`) and land a <5-min "wow".

---

**One-liner:** the engine is production-grade; Tier 1 is now mostly closed
(release integrity ✅, growth bounds ✅) with two small **maintainer** toggles
left (Trusted Publishing, repo consolidation). Tier 2's differentiator
(self-pruning) has its first version shipped. Tiers 2–3 remaining are roadmap,
not blockers.
