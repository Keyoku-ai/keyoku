# Keyoku eval — muscle-memory retrieval quality

Deterministic (no model/network). Regenerate: `npm run eval`.

Seeded 3 converged families (each with a step + a pitfall), then assessed
3 similar and 2 dissimilar query goals.

| query | expected | top suggestion | precision@1 | pitfall surfaced |
|---|---|---|---|---|
| deploy-prod-k8s | deploy-staging-k8s | deploy-staging-k8s | ✓ | ✓ |
| migrate-pg-newschema | migrate-postgres-schema | migrate-postgres-schema | ✓ | ✓ |
| fix-flaky-e2e | fix-flaky-tests | fix-flaky-tests | ✓ | ✓ |
| market-report | (none) | (none) | ✓ | – |
| buy-furniture | (none) | (none) | ✓ | – |

## Metrics

| metric | value | threshold | verdict |
|---|---|---|---|
| precision@1 (similar) | 100% | ≥ 100% | ✓ |
| pitfall-surface rate (similar) | 100% | ≥ 100% | ✓ |
| false-positive rate (dissimilar) | 0% | ≤ 0% | ✓ |

**Verdict: PASS ✓** — muscle memory is captured AND reused (steps + pitfalls), with no false suggestions on unrelated goals.
