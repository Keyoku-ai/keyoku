# Security review — contribution gate pivot

Reviewed: 2026-08-25
Scope: the new repository-local contribution, gate, review, Factfile rendering, publishing, and shared-ledger paths in `keyoku` and `keyoku-engine`.

## Result

The bounded local-alpha trust paths below have direct regression coverage.
Command probes now execute sequentially in fresh disposable Git checkouts made
from one content-addressed source capsule rather than in the mutable caller
checkout. This closes the prior source-binding blocker; it is still not a
general OS sandbox or a claim that arbitrary repository commands are safe.

## Threat boundaries

- Outcome command probes are trusted repository code. Adopting a project’s outcome contract is equivalent to trusting its test scripts. The disposable checkout protects evidence integrity, but the command retains the caller's user permissions, process, network, and external-filesystem access; inspect unfamiliar contracts and use ordinary CI isolation for untrusted forks.
- Factfiles are designed to leave the repository. Probe output is recursively redacted before JSON, Markdown, or HTML is written.
- Publishing is explicit. It accepts HTTPS or loopback HTTP, rejects credentials embedded in URLs, disables redirects, times out, and verifies that the repository still matches the Factfile before upload.
- The shared engine validates and stores evidence but never executes uploaded probes.
- A passing gate is not acceptance. Only an identified human can append acceptance, and stale Git/worktree snapshots are rejected.

## Controls verified

| Area | Control |
|---|---|
| Input validation | Zod schemas locally; the optional registry validates the stable envelope, enforces a 20 MB body limit, rejects duplicate JSON keys, and rejects unredacted credential-shaped fields |
| Output safety | Contextual HTML escaping and a restrictive CSP in local Factfile reports; registry retrieval returns the original JSON only |
| Evidence integrity | Fail-closed Git identity, NUL-delimited paths, a SHA-256 full-tree capsule containing tracked plus non-ignored untracked bytes and executable/symlink modes, fresh checkout per command criterion, mutation and mutate-restore rejection, original-tree revalidation, base/head/worktree binding, append-only snapshot history, canonical Factfile digest, and stale-proof rejection |
| Pulse promotion | Project/outcome/source binding for local Factfiles; adapter and fixture checkpoints remain attested and nondispatchable; public adapter ingress cannot self-claim local verification |
| Artifact containment | Lexical plus realpath containment, symbolic-link rejection, byte digests, size limits, and PNG/JPEG/WebP/MP4/WebM signature checks before portable embedding |
| Adapter authority | The neutral evaluator consumes submitted results only; it cannot execute a shell, accept human review, mutate caller state, choose a caller's assurance profile, or control an agent runtime |
| Authentication | The registry requires a bearer token for non-loopback binding and compares it in constant time |
| Network exposure | The registry binds to loopback by default; remote binding is explicit and token-gated |
| HTTP hardening | Header/body limits, read/header/write/idle timeouts, `nosniff`, frame denial, no-referrer, permissions policy |
| Storage | SQLite-backed immutable receipts, idempotent retry for identical bytes, and `409 Conflict` for changed content under an existing digest |
| CI permissions | GitHub proof workflow uses read-only repository permissions and uploads the generated receipt as an artifact |
| Secret scanning | Whole-history gitleaks scanning; fingerprint-scoped ignores cover only reviewed synthetic credential-redaction fixtures and model identifiers already present in public history, so new findings and all other locations still fail |

## Dependency evidence

- `npm audit`: **0 vulnerabilities** after upgrading Vitest/transitive packages and pinning a fixed `esbuild` through package overrides.
- `govulncheck ./...`: **0 reachable vulnerable symbols** and **0 vulnerable imported packages** after upgrading gRPC, OpenTelemetry, `x/net`, `x/crypto`, and related Go modules.
- The Go scanner reports one module-level advisory for the unmaintained `golang.org/x/crypto/openpgp` subpackage. It has no fixed version, and this codebase does not import or call it. This should remain visible in future scans rather than being mislabeled as resolved.

## Residual limits

- A malicious command can still use the caller's OS authority outside its disposable checkout. Keyoku is not a container, VM, syscall sandbox, network sandbox, or secret broker. Use an isolated CI job or stronger sandbox when the repository or probe contract is not trusted.
- Command criteria must be observational. Any write, add, delete, executable-mode change, or mutate-restore inside the disposable checkout rejects the proof. Build or test tools that write caches or generated outputs into the source tree need a read-only mode or a separately declared external work directory.
- The capsule contains tracked and non-ignored untracked Git source. Generated
  `.keyoku/contributions`, `.keyoku/pulse`, and `.keyoku/runtime` state is
  excluded so proof bookkeeping cannot self-invalidate; project, policy,
  outcome, and architecture contracts remain included. Git-ignored
  dependencies/build caches are environment inputs, not claimed source bytes.
  Escaping symlinks, submodules, invalid UTF-8 paths, FIFOs/sockets/devices,
  and cwd paths outside the capsule fail closed.
- Pulse dispatch planning accepts local checkpoints only when their current Factfile, source, and artifact bytes have been reverified through the filesystem adapter. Fixture and unauthenticated adapter attestations remain visible but nondispatchable.
- Redaction is defense in depth, not a replacement for keeping secrets out of test output.
- Factfile digests provide tamper evidence, not an externally authenticated signature. The versioned conformance manifest freezes numeric/Unicode canonicalization, strict UTF-8 and surrogate rejection, duplicate-key rejection, and the shared redaction marker for cross-language implementations.
- “Passed” covers only declared criteria. It does not prove absence of undeclared bugs or vulnerabilities.

## Reproduction

```bash
# keyoku
npm audit
npm run typecheck
npm test -- --run
npm run eval
npm run preflight

# keyoku-engine
go test ./...
go test -race ./factfile ./cmd/keyoku-registry
go vet ./...
go run golang.org/x/vuln/cmd/govulncheck@latest -show verbose ./...
```
