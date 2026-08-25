# Changelog

## 3.0.0-alpha.1 — 2026-08-16

Keyoku's open-source V1 is now a local, Git-native proof session between humans and coding agents.

### Added

- A durable provider-neutral session protocol for agent work, structured human decisions, queued instructions, acknowledgements, and leased presence.
- A token-scoped loopback UI with **Agent work**, **Needs you**, **Review first**, and claim-by-claim **Proof** surfaces.
- Active contribution reuse per branch and outcome, plus content binding for the exact outcome contract.
- Annotated screenshot and timestamped video evidence in portable Factfiles.
- `keyoku proof serve`, four MCP coordination tools, and a Marketplace-compatible composite GitHub Action.

### Changed

- Factfiles now present claim → observation → meaning → limits → reproduction → relevant code and artifacts; raw assertions remain audit detail.
- The launch promise is intentionally narrow: Keyoku coordinates proof and human attention without replacing GitHub, coding harnesses, or project-management systems.

## Unreleased

### Added
- **Behavior iteration: `keyoku iterate` plus four MCP tools.** A provider-neutral,
  bounded prove → repair → re-prove protocol now turns failed repository-owned
  claims into deterministic agent instructions and re-evaluates only at an
  idempotent checkpoint. Each round records the exact Git/worktree identity,
  Factfile digest, passing/failing/regressed claim indexes, declared human-review
  state, explicitly sourced token/cost usage, and stop reason in a hash-chained
  append-only ledger. The controller stops on success, human judgment, failed
  human review, no source progress, or configured round/time/token/cost limits.
  It deliberately does not run an agent, infer billing, fill human decisions,
  accept a contribution, push, or deploy. See `docs/ITERATION.md`.

- **Demo evidence: `keyoku demo <init|record|watch>`.** A generic, project-agnostic
  "record -> watch -> gate" workflow that makes a recorded product demo
  first-class Keyoku evidence (the existing `EvidencePresentationSchema`
  `artifacts` already supported `kind: "screenshot"/"video"`; this adds the
  workflow that actually produces and validates them). `keyoku demo init`
  writes a commented `.keyoku/demo.yaml` template (won't overwrite an
  existing one) plus a ready-to-paste outcome criterion snippet. `keyoku demo
  record` reads/validates that config, launches Chromium via Playwright
  resolved from the *target* project (not a keyoku dependency — clear error
  if `playwright` isn't installed there), walks each declared "stop"
  (optional auth once, then goto -> actions -> settle -> screenshot), and
  writes `.keyoku/demo/frames/*.jpeg` + `.keyoku/demo/manifest.json`. `keyoku
  demo watch [--assert]` composes a prompt from the manifest's frames and
  per-stop `expect` assertions, spawns `claude -p ... --permission-mode
  acceptEdits` to review the frames and run a UI/UX audit, validates the
  resulting `.keyoku/demo/verdict.json` against a zod contract, and with
  `--assert` exits 0 only when `overall.verdict === "pass"` AND the verdict
  is newer than the manifest — usable directly as an outcome criterion probe
  (`keyoku demo record && keyoku demo watch --assert`) in any project. See
  `docs/demo-evidence.md`.

- **ADR-35: `Goal.project`/`Goal.cwd` — the keyoku side of belay's cross-project
  scoping fix.** belay's loop portfolio/proposals now scope by project to stop
  goals bleeding across unrelated repos sharing one `~/.keyoku`; that read a
  `project`/`cwd` off the goal row, but the goal record had no such field —
  this adds it.
  - **What cwd context is actually available to an MCP tool handler** (the
    key finding): MCP does not hand a tool call the client's cwd — there is
    no protocol-level "caller's cwd" param. The only two reliable signals are
    (a) an explicit `cwd` argument the calling agent chooses to pass, and (b)
    `process.cwd()` of the long-lived stdio server process itself, fixed at
    the moment Claude Code spawned it (typically the project dir the session
    started in). `goal_focus` already leaned on exactly this — `cwd` optional,
    defaulting to `process.cwd()` — so that's the established, trusted
    convention this change follows for `goal_create` too, rather than
    inventing a new mechanism.
  - **`goal_create` gains an optional `cwd` param**, defaulting to the
    server's `process.cwd()` when omitted — so every newly created goal is
    stamped going forward, not just focused ones. Stored as two fields:
    `Goal.cwd` (the raw dir) and `Goal.project` (the git repo root of that
    dir, or the dir itself outside a repo — `never-throw`, via
    `projectForCwd()` in `engine.ts`) — repo-root normalization means a goal
    created from any subdir of a monorepo checkout lands on the same
    `project` value.
  - **`goal_focus` backfills `project`/`cwd`** on a goal that doesn't have
    them yet, from the focus `cwd` (itself already optional-with-a-
    `process.cwd()`-default on that tool). **First stamp wins** — focusing an
    already-stamped goal from a different directory never reassigns it, so a
    shared/portfolio goal can't get bounced between projects by whoever
    focuses it next.
  - **Surfaced** in `goal_get` (full goal object) and `goal_list`/`goal_create`
    responses (`goalSummary`, `project` only, when set) — as well as directly
    in `goals.json`, which is how belay itself reads it.
  - **Backward compat, stated plainly:** the ~97 goals that existed before
    this field shipped have neither `project` nor `cwd` and are **NOT**
    retroactively scoped — there is no backfill migration, because inferring
    a project from a goal's free-text objective/activity would produce false
    positives that are worse than "unscoped." An old goal becomes scopeable
    only once it is re-focused (`goal_focus`) from a real cwd, or recreated.
    belay-side scoping logic must treat an absent `project`/`cwd` as
    "unknown," not "global."
- **B2: edit a goal's criteria in place.** `goal_update` gains `addCriteria` /
  `removeCriteriaIds` / `editCriteria`, so a wrong or incomplete criterion no
  longer forces creating a whole new goal (which was fragmenting the loop
  portfolio into duplicate `-v2`-style goals with their own, disconnected
  learned workflow). `addCriteria` appends new criteria (ids continue the
  goal's `c<N>` sequence, never colliding with survivors after a removal);
  `removeCriteriaIds` drops criteria by id; `editCriteria` patches an
  existing criterion's `description`/`probe`/`assert` by id — fields left
  out of the patch are preserved. Criteria not referenced by any of the three
  pass through completely unchanged (verified by identity-equality in tests,
  not just value equality). Backward compatible: a `goal_update` call with
  none of the three new params behaves byte-for-byte as before (same patch
  application, same response shape — the redacted `criteria` array is only
  added to the response when a criteria edit actually happened).
  - **Re-validated on every edit**, through the same gate `goal_create` uses:
    at least one criterion must remain, and any `mcp` criterion (added or
    edited-in) must reference a connector that's actually registered. A
    rejected edit never partially applies — the goal's criteria are left
    exactly as they were.
  - **Converged-goal guard, safe default (no force flag):** editing criteria
    on a `converged` goal reopens it — to `active`, or to `blocked` if its
    iteration budget is already exhausted — mirroring the existing
    drift-detection auto-reactivation in `assess()`. Rationale: a
    `converged` status is a proof that criteria held; changing the criteria
    invalidates that proof, so leaving the status untouched would be a
    second silent-false-convergence hole right next to the one closed in
    2.18.0. No flag is needed to opt into the safe behavior — the harness
    never leaves a goal claiming a convergence it hasn't re-verified.
  - **The edit lands in the goal's trace/history** (visible via `goal_get`)
    as a new `source:"system"` `ActionRecord` — distinct from `"recorded"`
    (an explicit `goal_record` corrective action) and `"activity"` (live
    capture). It does NOT spend the corrective-action iteration budget, and
    it is excluded from workflow-step promotion and the `totalActions` stat
    — a criteria edit is bookkeeping about the goal's definition of done, not
    a reusable action toward it, so it must not pollute a learned workflow's
    steps.
  - Server instructions (`PROTOCOL`) and `goal_update`'s tool description
    updated — the old "criteria are IMMUTABLE after goal_create... make a
    NEW goal to change them" guidance is now actively wrong and has been
    replaced with guidance to refine in place instead.

### Changed
- **Command probe `timeoutMs` cap raised from 5 minutes to 15 minutes
  (300,000ms -> 900,000ms)** in `CommandProbeSchema`/`HttpProbeSchema`
  (`src/types.ts`) — real frontend production builds (and the new demo
  record/watch pipeline) routinely exceed 5 minutes, and the old cap made
  those outcome checks structurally unable to declare an honest timeout.

## 2.18.0 — 2026-07-02

Security + correctness hardening. A full-codebase adversarial validation
(28 confirmed findings) fixed **27**, each with a regression test and driven to
convergence through three rounds of independent adversarial re-verification.
Test suite 290 → 321.

### Convergence correctness
- **Silent false convergence closed (the "one unforgivable bug").** `goal_assess`
  could report a goal converged while its probe did not actually verify the
  property — a down HTTP service satisfied `status ne 500`, a timed-out or
  failed command satisfied vacuous/tautological transport assertions. Rebuilt
  around what the probe *produced*: a probe that did not COMPLETE (command
  timeout/signal sentinel, HTTP no-response, unparseable output, mcp error) can
  never satisfy a criterion, and a completed-but-FAILED probe (nonzero exit,
  non-2xx HTTP — `runHttp` now marks these) satisfies a criterion only via an
  EXACT `exitCode`/`status` match. Uniform across command / HTTP / mcp probes.
- **Retroactive `goal_record` no longer inflates a workflow's convergence count**,
  and **re-promotion preserves self-pruning stats** (suggested/helped) instead
  of wiping the precision signal. Failure-only traces surface their pitfalls on
  similar goals without a false "workflow promoted" claim.

### Security / trust
- **Workflow `{{param}}` values can no longer inject shell.** Params are bound as
  environment variables the command references (quote-state aware), so a value
  like `$(rm -rf ~)` is always data, in every quoting context, while normal
  substitution still works.
- **Omnigent drive respects the autonomy ladder** on the MCP tools *and* the
  `keyoku converge` / `keyoku guardrails` CLI subcommands (was ungated on the CLI).
- **Approval-gated workflow steps can't be hand-completed without approval** —
  the step is linked to its approval and requires it decided+executed.
- **Secret redaction** now covers Basic-auth, DB/URL connection-string passwords,
  and the empty-username URL form (`redis://:pass@`); `activity_record` /
  `goal_record` MCP tools redact before storing (previously only the hook path did).
- **`keyoku pause` stops all server-side recording** — including `connector_call`
  activity and `goal_assess` observations (previously leaked while paused).

### Reliability / correctness
- Bash workflow steps run in their own process group, so a timeout or shutdown
  kills grandchildren too; the SIGKILL escalation timer no longer fires post-exit.
- `listAudit` tolerates a torn/corrupt line instead of crashing the audit trail;
  `executions.json` is now growth-bounded; `deleteGoal` removes orphaned
  observations; nudge/marker files are written `0600`.
- `keyoku doctor` / `init` identify keyoku's own hooks structurally (no
  false-green on a decoy substring, no duplicate/foreign-hook deletion, legacy
  `keyoku <verb>` recognized); `export` writes valid YAML frontmatter even when
  the description contains `:`; `init` heals a stale Codex path.
- Backfill prefers the goal-owning session (focus / bookkeeping, whole-token
  match) over raw event volume when attributing build-then-verify work.

### Docs
- Corrected the package name in `HARNESS.md` (`keyoku`, not `@keyoku/harness`)
  and the growth-bound status in `PRODUCTION-READINESS.md`.

## 2.17.0 — 2026-07-02

- **Record-before-assess learning contract surfaced.** `goal_create` now states
  that the recorded trace is what becomes the promoted workflow, and that
  retroactive `goal_record` is accepted after convergence (spending no
  iteration budget); the served protocol no longer implies act/record must
  precede convergence. Closes fix 3 of the convergence-loop audit
  (`AUDIT-convergence-loop-2026-06-17.md`), with regression locks: first-assess
  convergence with `iterationsUsed 0` promotes no hollow workflow and guides
  honestly.
- **Clean typecheck.** Cleared the 12 outstanding `tsc --noEmit` errors (typed
  test mocks, `ReadonlySet` handler set, `--max-rounds` guard uses the parsed
  value). Behavior-neutral.

## 2.16.0 — 2026-06-26

- **Model-driven Omnigent dispatch.** `keyoku run <goalSlug> --on omnigent`
  and MCP `goal_run` now list available Omnigent agents and ask the configured
  SLM to choose the best-fit agent with a rationale when no explicit agent is
  provided. Explicit `omnigent:<agentName>` runs still bypass dispatch. The
  result includes `dispatch`, CLI output prints the chosen agent and rationale,
  and no regex/keyword heuristic is used. When no model is configured, dispatch
  falls back deterministically to `codex-native-ui` and marks the choice
  degraded.

## 2.15.0 — 2026-06-26

- **One-command Omnigent convergence runs.** Added `keyoku run <goalSlug> --on
  omnigent[:agentName]` and MCP `goal_run` to auto-connect the Omnigent preset,
  create a session, install compiled constraint policies, post the goal objective
  with current unmet criteria, and reuse the existing convergence driver until
  the goal passes. Added mocked orchestration tests and a live Omnigent run e2e
  proof script.

## 2.14.0 — 2026-06-26

- **Convergence Guardrails for Omnigent.** Added a Keyoku convergence-gate
  policy that denies Omnigent `response` events until the goal's success
  criteria actually pass, plus `driveToConvergence()` to keep a dispatched
  session alive with continuation messages until `goal_assess` converges. Added
  model-driven constraint-to-policy compilation for Omnigent built-in policies
  with a clearly logged degraded offline fallback, `keyoku converge`,
  `keyoku guardrails`, MCP `goal_converge` / `goal_guardrails`, unit coverage,
  and a real Omnigent guardrail e2e proof script.

## 2.13.0 — 2026-06-26

- **Built-in Omnigent connector preset.** Added `keyoku connect omnigent` to
  discover the local Omnigent server, register its OpenAPI connector
  idempotently, and persist it with approval-gated autonomy. `keyoku connect
  --list` shows available presets.

## 2.12.2 — 2026-06-20

- **Agent-awareness in the served MCP instructions.** The `PROTOCOL` string the
  MCP server hands every connected agent now states *when to reach for Keyoku*
  (multi-step goals with a verifiable end state — migrations, "make X
  production-ready", get-CI-green, deploys, refactors with a clear
  done-condition; not one-shot edits or pure Q&A) and the **discipline** that
  makes the loop work: behavioral (not file-presence) criteria, criteria
  immutable after `goal_create`, `goal_record` every action honestly *including
  failures* (they become pitfalls in future suggestions), never fudge an
  env-blocked criterion, always honor the autonomy level. Also nudges agents to
  query existing knowledge/goals/workflows first so learned work gets reused.

## 2.12.1 — 2026-06-18

- **Bounded the audit log.** `audit.jsonl` now self-caps at ~1 MB (keeps the most
  recent ~2000 entries) — the last unbounded log. Every persistent log is now
  bounded (activity → ~8k events, observations → 400/goal, audit → ~2000);
  `knowledge.jsonl` is intentionally kept (it's data, not a log). Regression test
  in `tests/store.test.ts`. Final storage-stability hardening before stable.

## 2.12.0 — 2026-06-18

- **`keyoku inspect` — data-trust visibility (#53).** Shows exactly what keyoku
  has stored in `KEYOKU_HOME`: goals/workflows/patterns/templates/executions/
  knowledge counts, connectors + autonomy, activity span + recording state, every
  stored file's size and **permission mode** (flags anything not `600`), and the
  privacy posture. `keyoku inspect --secrets` scans the activity log for known
  secret patterns (AIza…/sk-…/ghp_…/xox…) as a tripwire confirming write-time
  redaction held. Read-only; documents how to scope (`keyoku pause`) and wipe.
- **`keyoku refine <slug>` — raw learned steps → clean, runnable template (#48).**
  Backfilled workflows carry noisy raw activity steps; `refine` collapses dups,
  drops omission markers, and (when a lite model is configured) names them,
  de-noises, and replaces run-specific values with `{{placeholders}}` — then
  prints a reviewable draft. `--apply` saves it as a template runnable via
  `workflow_execute`. Verified on a real workflow: 31 raw steps → 7 clean,
  parameterized steps. Deterministic floor when no model; fail-safe.
- **Pattern mining clarified (#49).** Diagnosed the "0 patterns" report: the
  heuristic floor only mines sequences shared across ≥2 converged goals (correct
  to yield 0 for distinct one-off goals); the **SLM miner** generalizes and, with
  a key configured, `keyoku learn` now mines real patterns. Not a detection bug.

## 2.11.0 — 2026-06-18

- **The agent is the final judge in the MCP path; the lite model is demoted to
  headless-only.** A head-to-head on real goals showed `gemini-3.1-flash-lite`
  *over-matching* — it flagged two `lar-*` workflows as relevant to an unrelated
  generative-art goal (`wonder-drop`), i.e. false positives, while a frontier
  agent judging the same candidate pool correctly rejected them AND recalled more
  true matches elsewhere (3/3 vs the model's 2/3). So `goal_assess` (the
  interactive MCP path) now keeps `suggestedWorkflows` as the **conservative
  deterministic** list (high precision, zero model false-positives) and lets the
  **agent** judge `candidateWorkflows` — better precision *and* recall, zero
  dependency. The lite model still judges in **headless** contexts (`keyoku
  assess`/`watch`/cron, where no agent is present) via the new
  `assess(ref, { agentJudges })` flag (default false = headless behavior, so the
  CLI and existing callers are unchanged). The MCP server passes
  `agentJudges: true`. Regression test asserts the model is **not consulted** in
  the agent path (`calls === 0`) and is in the headless path.

## 2.10.0 — 2026-06-18

- **Agent-as-judge recall — reuse works with NO internal model (zero
  dependency).** keyoku is driven by a frontier coding agent, which is a far
  stronger reasoner than any lite model — so instead of *requiring* an internal
  model to decide which learned workflows are relevant, `goal_assess` now also
  returns `candidateWorkflows`: a small, overlap-ranked pool (sharing ≥1 token,
  capped by `KEYOKU_WF_CANDIDATES`, default 5) for the **agent** to judge. The
  guidance frames it explicitly: *"YOU judge relevance — apply the steps of any
  that genuinely fit, ignore the rest."* This lets reuse fire on verbose,
  differently-worded goals that lexical overlap (max ~0.08 jaccard on real goals)
  can never match — **with no API key and no internal model**. The deterministic
  `suggestedWorkflows` (jaccard floor) is unchanged, so the offline path and the
  CI eval are untouched; an optional lite model still pre-filters when configured
  (best of all three: deterministic floor + agent judgment + optional model).
- **Refine keyoku's own memory.** When a candidate is relevant but its learned
  steps are noisy/raw (e.g. backfilled activity), the assess guidance now nudges
  the agent to clean it up via the existing `workflow_update` tool — so the agent
  sharpens keyoku's brain as a side effect of using it. New
  `Harness.candidateWorkflows()`; `ConvergenceReport.candidateWorkflows`;
  regression test (candidates surface with no model). The convergence core stays
  deterministic.

## 2.9.1 — 2026-06-18

- **Fix: default Gemini model silently broke every SLM feature.** The default was
  `gemini-3.5-flash`, a *thinking* model — keyoku's calls request small JSON with
  a tight `maxTokens`, which the model spends entirely on internal reasoning,
  returning HTTP 200 with **empty text** (`finishReason: MAX_TOKENS`). So
  semantic recall, re-rank, and refine all silently no-op'd (fell back to
  lexical) even with a valid key. Default is now `gemini-2.5-flash-lite`, which
  answers within the budget. Verified end-to-end: a live call now surfaces the
  right workflows where lexical returns nothing. Override via `KEYOKU_SLM_MODEL`.

## 2.9.0 — 2026-06-18

- **`keyoku backfill` — repair hollow muscle memory.** A real-data audit found
  every learned workflow was hollow (0 steps) despite 74–351 logged action
  events per goal: the work was in the activity log but, under builds predating
  activity-backfill, was never lifted into steps. `keyoku backfill` (alias
  `repair`; `--dry-run` to preview) re-runs the current capture (recorded trace
  if any, else activity-backfill) over every converged goal whose workflow is
  empty, and populates its steps **without** bumping the convergence count.
  Applied to the maintainer's store it recovered 23–31 steps per workflow across
  all 5 hollow ones. New `Harness.repairWorkflows()`; regression tests.
- **Semantic recall — reuse fires on differently-worded goals.** Lexical overlap
  (jaccard) maxed at ~0.08 between real goals and relevant workflows — below any
  sane floor — so suggestions never surfaced for verbose, natural-language
  objectives. When a lite model is configured, the engine now hands it a WIDE
  overlap-ranked candidate pool (no hard lexical floor) and lets it filter by
  MEANING — the no-heuristics principle applied to recall, not just re-ranking.
  Strictly additive and fail-safe: no model / `KEYOKU_SLM_SUGGEST=0` / any model
  error ⇒ the deterministic lexical result, so the offline path never regresses.
  New `Harness.suggestRelevant()` + overlap-coefficient recall; the assess loop
  now routes through it. `KEYOKU_WF_RECALL_POOL` (default 12) bounds pool size.
  Note: semantic recall needs `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` in the
  server env; without one, recall stays lexical (and can't match paraphrase).
  Regression test with an injected fake model.

## 2.8.0 — 2026-06-18

- **Self-pruning muscle memory — workflows that never recur sink** (retrieval
  lane). Until now a learned workflow ranked purely on token overlap (jaccard),
  so one that happened to share words with many goals kept getting surfaced even
  if its steps never actually applied. The engine now learns from **outcomes**:
  at each fresh convergence it scores the workflows that were *relevant* to the
  goal (`stats.suggested`) against whether the goal's actual trace *overlapped*
  their steps (`stats.helped`), and `suggestWorkflows` ranks by
  `similarity × precision` (`helped/suggested`). A chronically word-matching but
  never-recurring workflow is **downranked, not hidden** — a floor keeps it
  available when nothing better matches — and the effect only kicks in once a
  workflow has enough signal (`KEYOKU_WF_PRECISION_MIN_SIGNAL`, default 3). The
  **recall gate stays pure deterministic jaccard**; precision only reorders.
  Knobs: `KEYOKU_WF_PRECISION_FLOOR` (0.25), `KEYOKU_WF_HELP_OVERLAP` (0.3),
  `KEYOKU_WF_SELF_PRUNE=0` to disable. The convergence core is untouched.
  Regression test in `tests/engine.test.ts`.
- **Release preflight — version drift can't ship again.** `npm run preflight`
  (and a CI step in `release.yml`) builds, then verifies: package.json is valid
  semver, the CHANGELOG documents it, `VERSION` is **single-sourced** from
  package.json (not a hardcoded literal — the exact 2.7.1 regression), the
  **built artifact actually reports that version**, and `dist` ships in the
  tarball. Fails the release loudly before a bad tag goes out.
- **Production-readiness assessment** captured in `docs/PRODUCTION-READINESS.md`
  (what's done, what's user-only, what's next), so the path to "product-grade"
  is auditable rather than tribal knowledge.

## 2.7.1 — 2026-06-18

- **Honest version reporting.** `VERSION` (used by `keyoku version` and the MCP
  `serverInfo`) is now single-sourced from `package.json` instead of a hardcoded
  `"0.1.0"` that had drifted from the release. Falls back gracefully if unreadable.

## 2.7.0 — 2026-06-18

- **Replayable muscle memory — learned steps carry the command** (capture lane).
  `WorkflowStep` gained `detail`, and both the backfill and the recorded/live
  paths now carry the action's actual command into the learned step instead of
  dropping it. A learned workflow used to read "Bash: npm run build" (a
  description); it now also carries `"npm run build"` (the thing to run), so the
  step is **replayable**, and the command flows into the structured
  `suggestedWorkflows` an agent receives.
- **Focus session-pinning — concurrency hardening** (capture lane). Live capture
  (`goal_focus`) now treats the session as authoritative once known: the first
  matching action **pins** the focus to that session, and later events from a
  different session are rejected even if they share the project dir. This stops a
  second session working in the same project on one shared `~/.keyoku` from
  bleeding its actions into another goal's trace.
  Regression tests in `tests/engine.test.ts`.

## 2.6.0 — 2026-06-18

- **Live muscle memory — `goal_focus` + auto-record** (capture lane). Until now a
  build-then-verify run only became a workflow at convergence (via activity
  backfill). Now you can declare intent up front: `goal_focus { goal }` (MCP) or
  `keyoku focus <goal>` (CLI) marks a goal as the live-capture target, and from
  then on every **real action** (Bash/Edit/Write/connector — never inspection or
  the harness's own `mcp__keyoku__*` calls) is appended to that goal's trace **as
  it happens**, labeled `source:"activity"`, **without** spending the corrective
  iteration budget. Capture is **scoped** to the focus's session/cwd-subtree so
  concurrent work on one `~/.keyoku` never bleeds in, deduped against the previous
  action, and **auto-clears on convergence** (or `goal_unfocus` / `keyoku focus
  --clear`). An explicit `goal_record` still wins; backfill remains the safety net
  when nothing was focused. New `goal_focus`/`goal_unfocus` MCP tools, `keyoku
  focus` CLI, `ActionRecord.source`, focus persistence in the store. Regression
  tests in `tests/engine.test.ts`.

## 2.5.0 — 2026-06-18

- **Backfill attribution + long-build fidelity** (capture lane, follow-up to the
  v2.2.0 activity-backfill). Two refinements:
  - **cwd-subtree scoping** on top of the existing dominant-session scoping — one
    session can touch several projects, so within the dominant session the
    backfill now keeps only the dominant cwd's subtree (monorepo subdirs stay,
    sibling projects drop). Events with no cwd are kept (unattributable, not noise).
  - **Head + tail capping** — instead of keeping only the most recent
    `MAX_BACKFILL_STEPS`, keep the first `KEYOKU_BACKFILL_HEAD_STEPS` (default 8,
    the setup) plus the recent tail, with an omission marker between, so a long
    build doesn't lose how it was set up.
  Both stay deterministic and synchronous; the convergence core is untouched.
  Regression tests in `tests/engine.test.ts`.

## 2.4.0 — 2026-06-18

- **Lite-model re-rank is now ON by default (cached).** Supersedes 2.3.0's opt-in: when a
  lite model is configured, suggestion re-ranking runs automatically (a relevance decision is
  a model call, per the no-heuristics principle) — set `KEYOKU_SLM_SUGGEST=0` to force the
  deterministic jaccard order. To keep `assess` cheap (the protocol says assess often), results
  are **cached per goal + candidate-set**, so the model is called at most once per distinct set
  (a changed candidate set re-ranks). No model / `=0` / `<2` candidates / any error ⇒ jaccard
  order unchanged. Convergence core stays 100% deterministic.

## 2.3.0 — 2026-06-18

- **Lite-model relevance re-ranking for workflow suggestions** (no-heuristics path). Jaccard
  stays as fast, deterministic recall; when a lite model is configured **and** you opt in with
  `KEYOKU_SLM_SUGGEST=1`, the model judges which candidate workflows are genuinely relevant to
  the goal (paraphrase-aware, no token-overlap false matches) and re-ranks/filters them. Strictly
  additive and fail-safe: no model, not opted in, fewer than 2 candidates, or any error → the
  deterministic jaccard order is returned unchanged, so the offline path is always intact. The
  convergence core remains 100% deterministic. (`Harness` gains an optional `slm`; wired from
  `resolveSlmFromEnv()`; covered by an injected-fake-SLM test.)

## 2.2.0 — 2026-06-18

- **Muscle memory fills itself — activity-backfilled workflows.** Builds on 2.1.0:
  a goal that converges build-then-verify with **nothing recorded** no longer learns
  nothing. When the action trace is empty, the engine now infers the workflow steps
  from the **activity log** over the window `[createdAt − lookback, convergedAt]`,
  keeping only real *action* events — mutating Bash / Edit / Write / connector calls,
  never inspection (`ls`, `cat`, Reads…) or the harness's own `mcp__keyoku__*`
  bookkeeping — collapsed and capped. Two refinements proven against real data:
  a **lookback** (default 45 min, `KEYOKU_BACKFILL_LOOKBACK_MIN`) catches work done
  *just before* the goal was declared (build-then-verify goals can have 2–4 s
  lifetimes — all the work precedes `goal_create`); and **dominant-session scoping**
  keeps a goal from inheriting a concurrent project's edits (the global log
  interleaves sessions). Inferred steps are labeled `source: "activity"` so the
  trace stays honest about provenance; an explicit `goal_record` always wins over
  inference. This closes the real-world gap the audit found: every one of a heavy
  user's converged goals had `steps: 0` because `goal_record` wasn't called mid-run.
  Fully back-compat (no activity ⇒ no workflow, exactly as before). Deterministic and
  synchronous — the convergence core is untouched; the SLM-backed `workflow_suggest`
  / `harness_learn` passes can still refine the draft. (engine; regression tests in
  `tests/engine.test.ts`.)
- **Configurable workflow-suggestion relevance.** The Jaccard similarity floor and
  result count for surfacing a learned workflow on a new goal are now knobs, not
  magic numbers: `KEYOKU_WF_MIN_SIMILARITY` (default `0.2`) and
  `KEYOKU_WF_SUGGEST_LIMIT` (default `2`). Recall is a tunable decision; the
  pass/fail convergence check remains purely deterministic.
- **Docs**: `docs/REPO-MAP.md` names the one canonical, published package and what
  every neighbouring repo is; `docs/PUBLISHING.md` documents the one-time Trusted
  Publishing toggle the release workflow expects.

## 2.1.0 — 2026-06-18

- **Muscle memory for build-then-verify runs** (closes a gap vs. the "converged
  goals become reusable workflows" promise): `goal_record` is now **accepted on a
  converged goal** — retroactively capturing the trace that *achieved* convergence
  (the common do-the-work-then-assess-once pattern). Retroactive records don't spend
  the iteration budget, don't change status, and re-promote the workflow. A goal that
  converges with **no** recorded actions no longer promotes a **hollow (stepless)
  workflow**, and the converged guidance is honest about it — nudging `goal_record`
  so the run still becomes a reusable workflow. Stepless workflows are never
  suggested. (engine + guidance; regression test in `tests/engine.test.ts`.)
- **Pitfalls — negative muscle memory.** Workflows now capture the approaches that
  **failed** on the way to convergence (`result: "failure"` records), accumulated and
  deduped across re-convergences. When a similar goal is assessed, the guidance surfaces
  them as `avoid (failed before): …` alongside the steps to follow — so an agent doesn't
  repeat a known dead end. Verified end-to-end through the MCP server (capture → reuse).
- **Built-in quality validation.** A protocol-level e2e regression test
  (`tests/mcp-e2e.test.ts`) drives the real MCP server over stdio through the whole
  build-then-verify → reuse → pitfalls loop. A deterministic, CI-gating **eval**
  (`npm run eval`, `evals/`) measures muscle-memory retrieval quality —
  precision@1, pitfall-surface rate, and false-positive rate — and fails the build on a
  regression, with a generated `evals/REPORT.md`.

- **Codex out of the box**: `keyoku import` reads `~/.codex/sessions`
  rollouts (both line shapes, cwd-aware, redacted); `keyoku init` wires the
  MCP server into `~/.codex/config.toml`; `keyoku export --agents-md` bakes
  workflows into an AGENTS.md managed block.
- **Proactive intelligence**: background ripeness in the server; PostToolUse
  nudges, SessionStart brief, and prompt-time practice injection — the agent
  offers workflows, nobody has to ask. Each pattern surfaces exactly once.
- **Engine integration v1**: knowledge mirrors into keyoku-engine via
  `/api/v1/seed` (`KEYOKU_ENGINE_URL`); `knowledge_query` upgrades to
  semantic search with silent local fallback.
- **Context layer**: `knowledge_submit`/`knowledge_query`, connector tool
  descriptions captured at registration, CLAUDE.md conventions ingested on
  import, knowledge grounds SLM refinement.
- **Capture & lifecycle**: `workflow_capture` ("save what I just did"),
  `workflow_update`, `execution_cancel`, run-milestone bake hints,
  `keyoku pause`/`resume`, `keyoku doctor`.
- **Accuracy**: session-partitioned mining, automation-vs-practice routing,
  secret redaction at record time, real `{{placeholder}}` params on execute,
  native SLM via any OpenAI-compatible endpoint (Ollama, LiteLLM, Groq, …).

## 0.1.0 — 2026-06-10 (relaunch)

Keyoku is reinvented as an always-on activity tracer and workflow automation
layer for Claude Code and other MCP coding agents.

- **Activity tracing**: PostToolUse hook records every Bash/Edit/Write/Read to
  `~/.keyoku/activity.jsonl`; `keyoku init` wires hook + MCP server in one step.
- **Pattern detection**: non-overlapping sliding-window mining of repeated
  sequences; identical-run suppression; longest-chain collapsing.
- **Model-assisted suggestions**: with an SLM key configured, drafts are
  filtered, named, and parameterized by the model; heuristic-only otherwise.
- **Workflow execution**: bash and mcp_call steps run directly (per-step cwd,
  timeouts); agent_prompt steps pause and hand off to the connected coding
  agent; human_review steps wait for sign-off; executions persist step-by-step.
- **Goal convergence** (carried forward): machine-checkable criteria, probes,
  watch loop, approvals queue, audit trail, MCP connector manager.
- **Transcript import**: `keyoku import` backfills months of activity from
  Claude Code session transcripts — workflows are minable minutes after
  install instead of days.
- **MCP prompts catalog**: approved workflows publish as MCP prompts (native
  slash commands in Claude Code), kept current as templates change.
- **Skill baking**: `keyoku export <slug>` writes a workflow into the repo as
  a `.claude/skills` SKILL.md with provenance — reviewable and team-shareable.
- 205 tests including end-to-end MCP lifecycle, connector gating, import, and
  export suites; CI on every PR.

The previous incarnation of this repository (an OpenClaw memory plugin,
versions ≤ 1.6.x) is preserved in git history and tags.
