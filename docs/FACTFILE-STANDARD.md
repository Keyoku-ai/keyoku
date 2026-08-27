# Keyoku Factfile Standard

Status: `v1alpha1`
License: MIT
Scope: any Git repository, public or private

A Factfile is a portable, human-readable receipt for a software contribution. It connects a versioned intended outcome to accountable actors, relevant artifacts, deterministic observations, review history, and the exact repository snapshot those observations cover.

A Factfile proves one bounded checkpoint. [Keyoku Pulse](PULSE.md) is the separate temporal layer that carries trusted progress across multiple Factfile-bound checkpoints and agent harnesses. Pulse activity never changes what a Factfile establishes.

For command-backed claims, Keyoku captures the complete Git-visible source tree
(tracked plus non-ignored untracked bytes, paths, symlinks, and executable
modes) into one SHA-256 content-addressed capsule. Each command runs
sequentially in a fresh disposable checkout. A write, add, delete, mode change,
mutate-restore, original-tree race, or unsupported source entry rejects the
proof. The capsule isolates evidence bytes; it does not sandbox arbitrary code
from the caller's operating-system, network, or external-file authority. A probe
that deliberately daemonizes or escapes its process group is outside the trusted
repository-command support boundary.

It is not an AI-generated claim that a project is “good.” The canonical JSON records bounded facts. HTML and Markdown explain those facts at the level of detail a recipient needs.

## The standard method

1. **Declare the outcome.** Write one human-owned objective, its constraints, automated criteria, and any required human judgment criteria under `.keyoku/outcomes/`.
2. **Open a contribution.** Bind work to an outcome revision and base Git SHA. Record the responsible human and any contributing agents, harnesses, or models.
3. **Work in any harness.** Keyoku does not prescribe Claude Code, Codex, Cursor, CI, a custom agent, or human-only development.
4. **Coordinate without pretending activity is proof.** Agents report work, request only material human decisions, and poll for durable instructions. These events remain separate from evidence.
5. **Evaluate continuously.** Reuse one active contribution per branch and outcome; run the gate after meaningful iterations. Failed and incomplete probes fail closed.
6. **Render the receipt.** Store canonical JSON and generate Markdown and HTML views from the same record.
7. **Review as a human.** Automated proof can move work only to `human_review_required` when judgments remain. Named people record those verdicts; only after all required gates pass can the snapshot be accepted.
8. **Re-evaluate after change.** A later Git head or worktree digest is a different proof scope. Old evidence remains history, never silently applies to new code.

## Canonical hierarchy

```text
Project
└── Outcome (versioned definition of done)
    └── Contribution (bounded attempt)
        ├── Actors (human, agent, organization)
        ├── Session events (work, decisions, instructions, presence)
        ├── Repository snapshot (base, head, worktree digest)
        ├── Automated evidence (claim + explanation + artifact + audit trail)
        ├── Human criteria (named judgment + guidance + verdict)
        ├── Reviews (human decisions and comments)
        └── Factfile snapshots (append-only history)
```

## Repository layout

```text
.keyoku/
├── project.yaml
├── policy.yaml
├── outcomes/
│   └── <outcome-id>.yaml
├── contributions/
│   └── <contribution-id>/
│       ├── manifest.yaml
│       ├── events.jsonl
│       ├── reviews.jsonl
│       ├── snapshots/<factfile-id>.json
│       ├── factfile.json
│       ├── factfile.github.md
│       ├── factfile.md
│       └── factfile.html
├── pulse/
│   └── events.jsonl         # optional harness-neutral progress ledger
└── runtime/                 # local evaluator state; never canonical proof
```

Projects normally commit the project, policy, and outcome files. A project decides whether to commit contribution receipts or attach them to pull requests/releases. The local runtime is implementation state and should not be published.

## Required records

### Project

- Stable `id`, display `name`, and plain-language `summary`
- Optional repository URL and default branch
- Creation and update timestamps

### Outcome

- Stable `id` and explicit positive `revision`
- Human-readable `title` and `objective`
- Accountable `owner`
- Constraints that bound acceptable work
- One or more automated criteria
- Zero or more required human judgment criteria with stable ids and review guidance

Editing meaning, constraints, or criteria requires a new revision. A contribution never silently moves to a newer revision.

The outcome file is repository-owned. Its canonical revision history is the Git history of `.keyoku/outcomes/<id>.yaml`; inspect it directly with `git log -- .keyoku/outcomes/<id>.yaml` without creating a second source of truth.

An outcome may declare a deterministic path boundary with `scope.include`, `scope.exclude`, and `scope.maxChangedFiles`. Paths outside that boundary fail the gate. This catches mechanical scope drift but does not claim that a change is semantically coherent; projects should keep coherence as a human criterion.

### Actor

- `kind`: `human`, `agent`, or `organization`
- Stable `id` and display `name`
- Optional role
- Agent provenance may include `harness` and `model`
- An agent should identify a human or organization `ownerId`

Agent identity is provenance, not personhood or legal accountability.

### Evidence contract

Every machine-evaluated claim uses the same reading order:

1. **Claim** — the bounded behavior or property being evaluated
2. **What this shows** — the result in language a maintainer can explain
3. **Why it matters** — its relevance to the requested outcome
4. **Artifacts** — screenshots, short recordings, traces, reports, logs, or other inspectable output when appropriate
5. **Code context** — the paths that deliver the behavior and what each one is responsible for
6. **Audit details** — the probe, observed value, assertion rule, duration, and error

The Factfile stores a safe reproduction description for each observation. Repository commands are shown directly; HTTP and MCP probes are represented without publishing request credentials. Referenced artifacts must exist inside the project and are SHA-256 content-bound before they are presented as available evidence. A screenshot or short MP4/WebM recording may additionally be embedded in the portable HTML view within the documented size limit. Screenshots may carry percentage-based callouts; recordings may carry timestamped callouts. An annotation explains what a reviewer should notice but remains a demonstration, not an independent verifier.

The artifact type follows the claim. Visible behavior normally needs a screenshot or rendered capture. Runtime behavior needs a test or trace. Architecture needs a code tour or diff. Security needs the relevant scanner report and scope. A raw exit code by itself is audit data, not a useful human explanation.

Every criterion evaluation therefore records:

- Plain-language description
- Human-facing result summary and relevance
- Zero or more evidence artifacts with labels, captions, paths, and digests where available
- Zero or more code references with an explanation of responsibility
- Observed value
- Expected assertion path, operator, and value
- Pass/fail verdict
- Runtime duration
- Probe or evaluation error, when present

Raw logs may remain private. Published evidence must be enough to understand the verdict without opening the audit details and without exposing credentials, transcripts, customer data, or unrelated source.

### Two-way session protocol

The mutable live session and immutable Factfile snapshot have different jobs. The live session coordinates the next iteration; each gate captures its then-current state into a content-addressed Factfile.

- A work item has a stable id, actor, status (`queued`, `working`, `blocked`, or `done`), detail, and update time. It is agent-reported activity, never completion evidence.
- A decision request states what the agent wants, what blocks it, why a human must decide, bounded options, a recommendation when available, and the consequence of no response.
- A human resolution creates a queued instruction. The choice is not considered delivered until an agent receives and acknowledges that instruction.
- A free-form steering instruction uses the same durable queue. It may target one agent or be available to the next connected agent.
- A heartbeat describes presence only. Keyoku considers it connected for a short lease; absence never discards queued work or instructions.
- Optional steering is separate from **Needs you**. A renderer may derive suggested next directions from attention signals, evidence gaps, architecture, and pending acceptance criteria. Each suggestion explains its expected outcome effect, deep context, and tradeoffs before it becomes an instruction. Custom direction remains available without presenting an empty prompt box as a blocker.

The MCP surface is provider-neutral: `contribution_report_work`, `contribution_request_decision`, `contribution_propose_directions`, `contribution_next_instruction`, and `contribution_ack_instruction`. The working agent proposes contextual next moves before the final gate; the Factfile records the concise evidence-grounded rationale and references, never private chain-of-thought. Hooks may improve immediacy for a particular harness, but the protocol does not require them.

### Human judgment

Not every meaningful property reduces to an exit code. Product fit, visual quality, maintainability, risk acceptance, and contextual correctness can be declared as human criteria. Each verdict records the criterion id, identified human reviewer, pass/fail judgment, reason, time, Factfile digest, and repository snapshot it reviewed. Agents cannot satisfy these criteria.

The portable HTML receipt can copy an instruction but cannot mutate its historical snapshot. A token-scoped local live session may present decision controls. Those controls append decision and instruction events; they never rewrite an earlier snapshot. Exact-snapshot acceptance still rejects a stale Factfile digest.

### Repository snapshot

The proof scope includes:

- Contribution base SHA
- Current Git head SHA
- Whether source is dirty
- Changed paths
- SHA-256 worktree digest over the complete Git-visible source capsule:
  sorted tracked and non-ignored untracked paths, exact bytes, executable modes,
  and internal relative symlink targets

Generated Factfiles, Pulse ledgers, and evaluator runtime are excluded from the
worktree digest so proof bookkeeping cannot invalidate its own source identity.
Project, policy, outcome, and architecture contracts remain included.

## States

| State | Meaning |
|---|---|
| `draft` | Work is open; no current evaluation is claimed |
| `evaluating` | Probes are running |
| `evidence_gaps` | One or more declared criteria did not pass |
| `human_review_required` | Automated evidence passed; one or more required human judgments are pending |
| `review_blocked` | Automated evidence passed; a required human judgment failed |
| `ready_for_review` | Automated and required human criteria passed; the snapshot is ready for acceptance |
| `accepted` | An accountable human or organization accepted that snapshot |

Review events append to `reviews.jsonl` and every rendered Factfile includes the resulting timeline. `keyoku proof review` records an identified human note; `keyoku proof accept` records acceptance only when the current source still exactly matches a passing Factfile. A source change after `ready_for_review` or `accepted` requires re-evaluation.

## Claim language

Allowed:

> 8 of 8 automated checks passed; 1 of 2 required human judgments passed for Git head `abc123` plus worktree digest `def456`. Human review remains required.

Not allowed:

> The AI proved this project is secure and correct.

A security scan, test suite, or sandbox evaluation supports only the property it actually checked. Severe findings may block readiness even when other checks pass, but an absence of findings is never universal safety proof.

## Human views

All views derive from canonical records and answer these maintainer questions first:

- What are agents doing now, and is that status merely reported or actually proven?
- Which decision is truly blocked on me, why, and what happens if I do nothing?
- What was requested?
- What changed?
- What is actually supported, and by which artifacts?
- Who or what did the work, and which human is accountable?
- What does the reviewer need to decide?

Raw assertions, hashes, changed paths, and verifier output remain available as collapsed audit detail. They must not displace the human explanation.

## Interoperability

Keyoku is Git-provider and harness neutral. A GitHub Action may attach the compact `factfile.github.md` summary and full HTML artifact to a pull request. GitLab, Forgejo, CI systems, or an agent runtime can consume the same canonical JSON and exit semantics. `keyoku-engine` may mirror snapshots for shared live views, but the local canonical record must remain usable without it.

## Versioning

Schemas use identifiers such as `keyoku.dev/outcome/v1alpha1`. Additive fields may appear during alpha. Incompatible meaning or required-field changes receive a new schema version. A verifier must reject unsupported versions rather than guessing.
