<div align="center">

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
    <img alt="Keyoku" src="assets/banner-light.svg" width="800">
  </picture>

  <p><strong>Proof your coding agent's work—not its confidence.</strong><br>
  <sub>One repository-owned outcome. Exact-revision evidence. A clear human decision.</sub></p>

  [![npm](https://img.shields.io/npm/v/keyoku?label=keyoku&style=flat-square&color=3159d9)](https://www.npmjs.com/package/keyoku)
  [![CI](https://img.shields.io/github/actions/workflow/status/Keyoku-ai/keyoku/ci.yml?style=flat-square&label=CI)](https://github.com/Keyoku-ai/keyoku/actions/workflows/ci.yml)
  [![License: MIT](https://img.shields.io/badge/License-MIT-166a4a?style=flat-square)](LICENSE)

</div>

Keyoku is a free, local-first proof session between humans and coding agents. It turns a repository-owned definition of done into a live working view and a shareable **Factfile**: meaningful evidence, agent provenance, explicit limits, and an exact Git scope.

**Factfile proves one checkpoint. Keyoku Pulse carries trusted progress across checkpoints.** Command claims run from one exact, content-addressed source capsule in fresh disposable checkouts; any source write rejects the proof. Pulse accepts typed events from any agent harness, reports only exact-source verified checkpoints, and renders founder, developer, timeline, email-safe, text, and JSON views from one digest. It never silently sends a message.

**Keyoku is an optional assurance adapter, not an agent protocol or control plane.** A caller may submit a neutral, content-digested evidence envelope and receive a deterministic accepted, rejected, stale, or human-review-required result. The caller chooses whether to use no assurance, basic assurance, or Keyoku high assurance; the neutral work contract does not require Keyoku. See the [adapter contract](docs/ASSURANCE-ADAPTER.md).

It works with Codex, Claude Code, Copilot, Cursor, OpenHands, custom agents, CI, or no agent at all. Keyoku does not run your agent and does not ask you to move source code off GitHub.

> GitHub shows the diff. Keyoku shows whether the intended outcome is supported—and where a human still has to decide.

## Try the v3 source alpha

```bash
git clone https://github.com/Keyoku-ai/keyoku.git
cd keyoku
npm ci
npm link

# Run the complete evidence-gap → human-review → stale-proof demo
keyoku proof demo --open

cd /path/to/your-project
keyoku proof init
```

`keyoku proof demo` creates a disposable Git repository and uses the real Keyoku
pipeline. It first records a failing evidence state, fixes the sample defect,
produces an exact-revision Factfile, and proves that review is rejected after
the source changes. It needs no account, model key, hosted service, or prepared
video. Pass `--dir <empty-directory>` if you want a predictable location to
inspect afterward.

The npm `latest` tag still points to the v2 muscle-memory product during this
alpha cutover. The generated GitHub workflow pins `keyoku@3.0.0-alpha.1` and is
staged—not runnable from npm—until that exact candidate is separately approved
and published to the `next` dist-tag. Local source evaluation works now.

Customize the outcome without learning the full YAML schema:

```bash
keyoku proof customize review-ready-change \
  --objective "A user can complete checkout without losing their cart"

keyoku proof customize review-ready-change \
  --check "npm run test:checkout" \
  --claim "Checkout completes end to end" \
  --why "This is the behavior being shipped"
```

Run `keyoku proof customize review-ready-change` with no edit flags to see the current claims, human decisions, and copyable customization recipes. Outcome YAML remains portable and Git-owned; each meaningful customization increments its revision.

Keyoku detects Node.js, Python, Rust, Go, or a generic Git repository and creates:

```text
.keyoku/
├── project.yaml
└── outcomes/
    └── review-ready-change.yaml   # repository-owned definition of done
.github/workflows/
└── keyoku-proof.yml               # read-only PR proof check
```

Review the generated outcome contract, replace starter checks with behavior that matters to your project, and run it locally:

```bash
keyoku proof run review-ready-change
```

The command prints a contribution id. Open its live session while an agent works:

```bash
keyoku proof serve <contribution-id>
```

The token-scoped loopback link opens automatically. It keeps four surfaces deliberately separate:

- **Agent work** — reported task status; useful for coordination, never treated as proof.
- **Needs you** — only decisions that genuinely block safe progress, with options, recommendation, and the cost of no response.
- **Direct** — optional, context-aware next directions with their expected outcome effect, deeper context, tradeoffs, and a custom path.
- **Review first** — deterministic risk and attention signals, not another model verdict.
- **Proof** — claim → observation → meaning → limits → reproduction → relevant code and content-bound artifacts.

A choice in **Needs you** or **Direct** writes a durable instruction. Any MCP-connected agent can receive and acknowledge it; if no agent is online, it stays queued. “Copy instruction” remains the universal fallback for any harness. The portable artifact is dark-first with a local light/dark toggle; the chosen appearance never changes canonical proof.

On a pull request, GitHub gets a reviewer-first Check summary and a downloadable Factfile artifact. The job executes with `contents: read`; untrusted PR code never receives a write token merely so Keyoku can post a comment.

The repository also contains a Marketplace-compatible composite action for the
future stable `v3` tag. During alpha, use `proof init`; its generated workflow
pins the source alpha and detects each project's dependencies safely. No `v3`
action tag is claimed until that release exists.

## What a reviewer sees

The Factfile answers these questions in order:

1. What are agents doing, and which are currently connected?
2. Does anything genuinely need my decision?
3. Where should I review first?
4. Which declared claims are supported by evidence?
5. Which files and code areas changed?
6. Which person, agent, harness, and model contributed?
7. Which exact base, head, worktree, and Factfile digests does this cover?

Raw observations are collapsed audit detail. An exit code is never presented as the explanation. Visible behavior can attach screenshots; runtime claims can attach tests or traces; security claims can attach scanner output; architecture claims can attach code tours and the generated SVG projection.

“Review this first” is deterministic—not another model verdict. Failed claims, declared scope violations, security/data/workflow/dependency-sensitive paths, broad changes, and pending human decisions are ordered with their reasons and source paths.

## One outcome is one review unit

Keyoku does not encourage one enormous PR. A contribution may contain several commits, but it should deliver one coherent reviewer outcome. Unrelated outcomes should become separate or stacked PRs.

An optional path boundary can fail closed when a contribution strays outside its declared scope:

```yaml
scope:
  include:
    - src/auth/**
    - tests/auth/**
  exclude:
    - docs/**
  maxChangedFiles: 30
```

Path checks cannot prove semantic coherence, so the generated contract also keeps that question as an explicit human judgment.

Graphite and GitHub can own PR stacking. Keyoku owns the outcome and its proof.

## Outcome history belongs in Git

Outcome contracts are normal versioned repository files. Change the meaning or acceptance criteria, increment `revision`, and commit the file. Anyone can inspect its canonical history without a Keyoku account:

```bash
git log -- .keyoku/outcomes/review-ready-change.yaml
```

Each contribution also keeps append-only coordination events and Factfile snapshots:

```text
.keyoku/contributions/<id>/
├── manifest.yaml
├── events.jsonl           # work, decisions, instructions, acknowledgements, presence
├── reviews.jsonl          # human judgments and exact-snapshot acceptance
├── snapshots/<factfile-id>.json
├── factfile.json          # canonical machine record
├── factfile.github.md     # concise GitHub reviewer surface
├── factfile.md            # portable detailed Markdown
└── factfile.html          # human-readable evidence and code tour
```

Projects can keep snapshots local, upload them as CI artifacts, or commit accepted receipts. Generating a receipt does not change its own source digest.

## The state model tells the truth

| State | Meaning |
|---|---|
| `evidence_gaps` | A declared machine claim failed, timed out, or could not be observed |
| `human_review_required` | Machine evidence passed; a named human question remains |
| `review_blocked` | A required human judgment failed |
| `ready_for_review` | Declared automated and required human criteria passed |
| `accepted` | An identified human accepted that exact snapshot |

“Passing” means only that the repository's declared checks passed for the shown revision. It never means universally secure, correct, maintainable, or fit for purpose. Any source change makes the Factfile stale and requires re-evaluation.

## Example outcome

```yaml
schemaVersion: keyoku.dev/outcome/v1alpha1
id: working-release
revision: 1
title: The release can be reviewed and shipped
objective: A maintainer can build the release and confirm its visible behavior.
owner:
  kind: human
  id: maintainer@example.com
  name: Project maintainer
constraints:
  - One contribution represents one coherent outcome.
criteria:
  - description: The release build succeeds
    probe:
      kind: command
      run: npm run build
      timeoutMs: 120000
    assert:
      path: exitCode
      op: eq
      value: 0
    evidence:
      summary: The production build completed for this exact revision.
      whyItMatters: A broken build cannot produce a releasable artifact.
      code:
        - path: src/build.ts
          purpose: Produces the release bundle.
      artifacts: []
humanCriteria:
  - id: visible-behavior
    description: The maintainer confirms the user-facing result matches the request
    guidance: Open the preview and inspect the attached screenshots before accepting.
createdAt: 2026-08-15T00:00:00Z
updatedAt: 2026-08-15T00:00:00Z
```

## CLI

```text
keyoku proof demo                    Run the real fail → repair → stale-proof scenario
keyoku proof init                    Detect the project and install a proof workflow
keyoku proof customize <outcome>     Edit common proof fields without schema knowledge
keyoku proof run <outcome>           Evaluate the outcome and generate a local Factfile
keyoku proof serve <contribution>    Open the token-scoped human ↔ agent session
keyoku proof review <contribution>   Record an identified human criterion decision
keyoku proof accept <contribution>   Accept one exact passing snapshot as a human
keyoku factfile inspect <id>         Validate and explain a content-bound Factfile
keyoku factfile verify <id>          Also require the current source to match it
keyoku factfile publish <id>         Explicitly publish to an optional Engine
keyoku pulse help                    Inspect the event, checkpoint, planner, and renderer path
keyoku pulse fixture generic        Emit a harness-neutral JSONL integration fixture
keyoku pulse ingest --file F        Append strict, idempotent lifecycle events
keyoku pulse plan --json            Decide send/defer/dedupe/suppress/coalesce/stale_no_send
keyoku pulse render --audience A    Render one content-bound audience projection
keyoku serve                         Serve the bounded MCP surface over stdio
keyoku doctor --json                 Inspect install, project, and authority boundaries
```

`proof run` reuses the active contribution for the current branch and outcome,
so fail, repair, and re-proof checkpoints remain one inspectable history. Pass
`--new` only for a genuinely separate attempt. The v2 goals, workflows,
connectors, activity recorder, memory, and execution commands are not v3 public
entrypoints. See the checked [v3 public surface](docs/PUBLIC-SURFACE.md).

## Different tools, different jobs

| Product | Primary job | Keyoku's boundary |
|---|---|---|
| GitHub Copilot agents | Run and track GitHub agent sessions | Keyoku remains harness-neutral and evaluates a repository-owned outcome |
| Entire | Capture prompts, transcripts, and session checkpoints in Git | Keyoku records bounded result evidence; raw transcripts are optional |
| Graphite | Split and navigate stacked pull requests | Keyoku evaluates each coherent outcome in the stack |
| CodeRabbit | AI review and defect suggestions | Keyoku reports the project's own deterministic proof and human decisions |
| CI/test tools | Execute specialized checks | Keyoku explains their relevance and binds results into one portable receipt |

Keyoku should complement these tools, not recreate them.

## Two repositories, one product

| Repository | Free responsibility |
|---|---|
| [`keyoku`](https://github.com/Keyoku-ai/keyoku) | CLI, open Factfile and Pulse schemas, local verifier/ledger/planner/renderers, GitHub workflow, harness adapters |
| [`keyoku-engine`](https://github.com/Keyoku-ai/keyoku-engine) | Optional durable multi-run Factfile/Pulse registry and dispatcher service plus the retained embedded-memory library |

The CLI repository is the product wedge and source of truth. The engine is an optional registry—not a required memory backend and not a duplicate control plane. Managed team views, retention policy, RBAC, and cross-repository search are possible hosted extensions; they are not presented as finished open-source features. Both repositories remain usable for public or private repositories.

## Trust and privacy

- Project proof lives in `.keyoku/`; ephemeral evaluator state lives in `.keyoku/runtime/`.
- Credential-shaped observations are redacted before JSON, Markdown, HTML, or publication.
- Factfile publication is explicit and accepts HTTPS or loopback HTTP only.
- GitHub proof execution is read-only and does not post privileged PR comments from untrusted code.
- Agent identity is provenance. A human or organization remains accountable.

Read the [Factfile standard](docs/FACTFILE-STANDARD.md), [v3 public surface](docs/PUBLIC-SURFACE.md), [Pulse contract](docs/PULSE.md), [GitHub integration guide](docs/GITHUB.md), and [security review](docs/SECURITY-REVIEW.md).

## Status

The Factfile and Pulse schemas are `v1alpha1`. The local evaluator, exact Git binding, repeated proof history, durable two-way instruction protocol, token-scoped live session, JSON/Markdown/HTML renderers, annotated visual evidence, scope boundary, outcome history, GitHub Check workflow, deterministic Pulse planner, and audience renderers are implemented and tested. Keyoku does not run an agent or deliver a Pulse update. Schema meaning may still evolve during alpha; incompatible changes receive a new schema version.

## License

MIT — see [LICENSE](LICENSE).
