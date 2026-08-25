# Security review — contribution gate pivot

Reviewed: 2026-08-09
Scope: the new repository-local contribution, gate, review, Factfile rendering, publishing, and shared-ledger paths in `keyoku` and `keyoku-engine`.

## Result

No known reachable dependency vulnerability or unaddressed high-severity issue was found in the new trust boundaries. The review changed the implementation rather than only documenting risks.

## Threat boundaries

- Outcome command probes execute inside the local repository/CI trust boundary. Adopting a project’s outcome contract is equivalent to trusting its test scripts; Keyoku tells MCP clients to inspect unfamiliar contracts first.
- Factfiles are designed to leave the repository. Probe output is recursively redacted before JSON, Markdown, or HTML is written.
- Publishing is explicit. It accepts HTTPS or loopback HTTP, rejects credentials embedded in URLs, disables redirects, times out, and verifies that the repository still matches the Factfile before upload.
- The shared engine validates and stores evidence but never executes uploaded probes.
- A passing gate is not acceptance. Only an identified human can append acceptance, and stale Git/worktree snapshots are rejected.

## Controls verified

| Area | Control |
|---|---|
| Input validation | Zod schemas locally; the optional registry validates the stable envelope, enforces a 20 MB body limit, rejects duplicate JSON keys, and rejects unredacted credential-shaped fields |
| Output safety | Contextual HTML escaping and a restrictive CSP in local Factfile reports; registry retrieval returns the original JSON only |
| Evidence integrity | Base SHA, head SHA, uncommitted-work digest, append-only snapshot history, SHA-256 Factfile digest, append-only review log, and registry conflicts when one digest is reused for different bytes |
| Authentication | The registry requires a bearer token for non-loopback binding and compares it in constant time |
| Network exposure | The registry binds to loopback by default; remote binding is explicit and token-gated |
| HTTP hardening | Header/body limits, read/header/write/idle timeouts, `nosniff`, frame denial, no-referrer, permissions policy |
| Storage | SQLite-backed immutable receipts, idempotent retry for identical bytes, and `409 Conflict` for changed content under an existing digest |
| CI permissions | GitHub proof workflow uses read-only repository permissions and uploads the generated receipt as an artifact |

## Dependency evidence

- `npm audit`: **0 vulnerabilities** after upgrading Vitest/transitive packages and pinning a fixed `esbuild` through package overrides.
- `govulncheck ./...`: **0 reachable vulnerable symbols** and **0 vulnerable imported packages** after upgrading gRPC, OpenTelemetry, `x/net`, `x/crypto`, and related Go modules.
- The Go scanner reports one module-level advisory for the unmaintained `golang.org/x/crypto/openpgp` subpackage. It has no fixed version, and this codebase does not import or call it. This should remain visible in future scans rather than being mislabeled as resolved.

## Residual limits

- A project can define a malicious command probe. Review outcome contracts before running them and use normal CI isolation for untrusted forks.
- Redaction is defense in depth, not a replacement for keeping secrets out of test output.
- Factfile digests provide tamper evidence inside the record and the registry prevents digest reuse with different bytes. The registry does not yet independently reproduce Keyoku's cross-language canonical digest algorithm, and digests are not cryptographic signatures tied to a verified external identity.
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
