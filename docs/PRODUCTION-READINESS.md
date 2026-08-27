# Production-readiness gate

Status: **unreleased v3 candidate — not approved for publication**
Updated: 2026-08-25

This document describes the narrow v3 assurance product. It supersedes the old
v2 claim that Keyoku's memory/convergence engine was production-grade. The
public npm `latest` and public website remain on v2 until the owner approves one
exact, immutable replacement candidate.

## Product boundary

Keyoku is an independent proof, attention, and stakeholder-presentation layer
around autonomous work. It does not run agents, schedule work, own a control
plane, or mutate an orchestrator's state. A neutral system may select no
assurance, basic receipt checks, or Keyoku high assurance through the optional
EvidenceProvider and WorkEvent interfaces.

The MIT package provides local Factfiles, Pulse planning/rendering, the CLI,
MCP tools, schemas, fixtures, and adapters. The separately licensed Engine is
optional durable multi-project storage/API infrastructure. The local path must
remain fully useful without Engine.

## Declared candidate matrix

| Surface | Candidate target | Current evidence | Release position |
|---|---|---|---|
| Local CLI/library/MCP | Node.js 20 and 22 on Linux and macOS, Git repositories using regular files, internal relative symlinks, and tracked/nonignored untracked source | Full local tests and clean-package runs have passed during integration; Ubuntu CI is configured but has not run on an immutable v3 commit | Candidate only |
| Source capsule probes | Reviewed repository commands, executed sequentially in fresh disposable checkouts | Dirty bytes, odd paths, executable modes, internal symlinks, mutation, mutate-restore, isolation, source races, unsupported entries, and timeout cleanup have regression coverage | Candidate only; not an OS sandbox |
| Pulse local ledger | One repository-local installation with cooperative same-user writers | Canonical event validation, replay/idempotency, conflict rejection, linked-path rejection, exclusive write lock, bounded descriptor-anchored append, and fsync | Candidate only; not a distributed queue or malicious same-user containment boundary |
| Engine | Supported Go toolchain and SQLite on Linux/macOS | Unit, race, vet, lint, semantic Factfile checks, corpus conformance, and backup/restore rehearsal passed during integration | Candidate only; hosted operations not proven |
| Website | Current evergreen Chrome/WebKit-class browsers, keyboard, reduced motion, mobile reflow | Local lint/build/browser checks and original-resolution review passed during integration | Private replacement deployment still pending |
| Windows | Not declared for v3 alpha | No exact-candidate Windows execution evidence | Unsupported until proven; fail reports are requested |

## Required release gates

The release candidate is publishable only when all of the following evidence is
bound to committed revisions and exact archives:

- Public CLI, API, Factfile, Pulse, decision, replay, export, and adapter flows
  pass from clean install, including failure, stale proof, recovery, and upgrade
  boundaries.
- Generated JSON, JSONL, Markdown, HTML, manifests, receipts, and reports parse
  and execute in their native consumers; tampering and semantic mismatches fail
  closed.
- Harness and Engine consume the same conformance corpus byte for byte and
  produce the same canonical outcomes.
- Dependency, secret, path, permission, concurrency, race, canonicalization,
  and supply-chain checks pass for the exact candidate.
- Human UX, terminal UX, keyboard operation, screen-reader semantics, contrast,
  reduced motion, 200% zoom, narrow mobile layout, long evidence, and recovery
  messages receive direct review.
- Engine backup/restore, migrations, rollback, health checks, resource budgets,
  and deployment runbooks are rehearsed against the final revision if Engine is
  included in the release.
- Exact archives install on clean Node 20 and 22 environments; checksums, SBOMs,
  version mapping, release notes, migration guidance, and rollback instructions
  agree across all repositories.
- A fresh agent and a human independently exercise the exact final archives and
  interactive product journey. Any source change invalidates that evidence.

## Open publication blockers

- Harness, Engine, and site now have local integration commits, but public CI has
  not run those unpublished revisions and independent exact-archive acceptance
  is still pending. The external evidence packet must record their final mapping.
- Private owner-only deployment of the corrected interactive site is pending.
- No verified private vulnerability intake exists. Enable GitHub private
  vulnerability reporting or approve and verify a monitored security contact.
- Engine licensing/licensor and repository-ownership posture require an explicit
  owner decision before the public v3 sequence.
- Final exact-revision archive, SBOM, release notes, migration, rollback, and
  independent acceptance packets have not yet been issued.
- npm Trusted Publishing and the release candidate itself have not been approved.

## Rollback boundary

Do not move npm `latest`, replace the public website, merge protected branches,
or delete the v2 line while v3 is under review. A prerelease, if approved, must
use the `next` dist-tag. The public v2 repository/tag/package/site combination is
the rollback boundary until v3 is separately proven and accepted.

## Release verdict

**NO-GO for public release today.** The coherent local product slice is real,
but publication requires exact committed revisions, rerun gates from final
archives, corrected private deployment, independent acceptance, and the owner
decisions listed above.
