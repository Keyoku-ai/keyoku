/**
 * Keyoku eval — muscle-memory retrieval quality.
 *
 * Validates the product's core promise ("converged goals become reusable workflows
 * suggested for similar goals") with deterministic metrics — no model, no network, so
 * it is reproducible and safe to gate CI. Run: `npm run eval`.
 *
 * It seeds a corpus of converged goals (each with a successful step AND a failed
 * approach → pitfall), then assesses query goals:
 *   - SIMILAR queries should retrieve the right family's workflow as the top suggestion
 *     AND surface its pitfall ("avoid (failed before): …").
 *   - DISSIMILAR queries should retrieve NOTHING (no false positives).
 *
 * Metrics: precision@1, pitfall-surface rate (similar), false-positive rate (dissimilar).
 * Writes evals/REPORT.md and exits non-zero if any threshold is missed.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ConnectorManager } from "../src/connectors.js";
import { Harness } from "../src/engine.js";
import { Store } from "../src/store.js";

const crit = (out: string, val: string) => [
  {
    description: "echo probe",
    probe: { kind: "command" as const, run: `echo ${out}`, parse: "text" as const },
    assert: { op: "contains" as const, value: val },
  },
];

const store = new Store(mkdtempSync(join(tmpdir(), "keyoku-eval-")));
const harness = new Harness(store, new ConnectorManager(store));

// ---- seed: three families, each converged with a step + a pitfall ----
const families = [
  { slug: "deploy-staging-k8s", objective: "deploy the staging service to kubernetes", step: "applied the helm chart", pitfall: "forgot the namespace flag" },
  { slug: "migrate-postgres-schema", objective: "migrate the postgres database schema", step: "ran the migration script", pitfall: "skipped the backup" },
  { slug: "fix-flaky-tests", objective: "fix the flaky integration tests", step: "pinned the system clock", pitfall: "bumped the timeout blindly" },
];
for (const f of families) {
  harness.createGoal({ objective: f.objective, slug: f.slug, criteria: crit("ready", "ready") });
  harness.recordAction(f.slug, { summary: f.pitfall, result: "failure" });
  harness.recordAction(f.slug, { summary: f.step, result: "success", tool: "Edit" });
  await harness.assess(f.slug);
}

// ---- queries ----
const similar = [
  { slug: "deploy-prod-k8s", objective: "deploy the production service to kubernetes", expect: "deploy-staging-k8s" },
  { slug: "migrate-pg-newschema", objective: "migrate the postgres database to a new schema", expect: "migrate-postgres-schema" },
  { slug: "fix-flaky-e2e", objective: "fix the flaky e2e tests", expect: "fix-flaky-tests" },
];
const dissimilar = [
  { slug: "market-report", objective: "write the quarterly marketing report" },
  { slug: "buy-furniture", objective: "order new office furniture for the studio" },
];

let p1 = 0;
let surfaced = 0;
let fp = 0;
const rows: string[] = [];

for (const q of similar) {
  harness.createGoal({ objective: q.objective, slug: q.slug, criteria: crit("nope", "ready") });
  const r = await harness.assess(q.slug);
  const top = r.suggestedWorkflows[0]?.slug ?? "(none)";
  const correct = top === q.expect;
  const fam = families.find((f) => f.slug === q.expect)!;
  const avoid = r.guidance.includes(`avoid (failed before): ${fam.pitfall}`);
  if (correct) p1++;
  if (avoid) surfaced++;
  rows.push(`| ${q.slug} | ${q.expect} | ${top} | ${correct ? "✓" : "✗"} | ${avoid ? "✓" : "✗"} |`);
}
for (const q of dissimilar) {
  harness.createGoal({ objective: q.objective, slug: q.slug, criteria: crit("nope", "ready") });
  const r = await harness.assess(q.slug);
  const got = r.suggestedWorkflows.length > 0;
  if (got) fp++;
  rows.push(`| ${q.slug} | (none) | ${r.suggestedWorkflows[0]?.slug ?? "(none)"} | ${got ? "✗ false-positive" : "✓"} | – |`);
}

const precision = p1 / similar.length;
const surfaceRate = surfaced / similar.length;
const fpRate = fp / dissimilar.length;
const THRESH = { precision: 1.0, surfaceRate: 1.0, fpRate: 0.0 };
const pass =
  precision >= THRESH.precision && surfaceRate >= THRESH.surfaceRate && fpRate <= THRESH.fpRate;

const pct = (n: number) => `${Math.round(n * 100)}%`;
const report = `# Keyoku eval — muscle-memory retrieval quality

Deterministic (no model/network). Regenerate: \`npm run eval\`.

Seeded ${families.length} converged families (each with a step + a pitfall), then assessed
${similar.length} similar and ${dissimilar.length} dissimilar query goals.

| query | expected | top suggestion | precision@1 | pitfall surfaced |
|---|---|---|---|---|
${rows.join("\n")}

## Metrics

| metric | value | threshold | verdict |
|---|---|---|---|
| precision@1 (similar) | ${pct(precision)} | ≥ ${pct(THRESH.precision)} | ${precision >= THRESH.precision ? "✓" : "✗"} |
| pitfall-surface rate (similar) | ${pct(surfaceRate)} | ≥ ${pct(THRESH.surfaceRate)} | ${surfaceRate >= THRESH.surfaceRate ? "✓" : "✗"} |
| false-positive rate (dissimilar) | ${pct(fpRate)} | ≤ ${pct(THRESH.fpRate)} | ${fpRate <= THRESH.fpRate ? "✓" : "✗"} |

**Verdict: ${pass ? "PASS ✓" : "FAIL ✗"}** — muscle memory ${pass ? "is captured AND reused (steps + pitfalls), with no false suggestions on unrelated goals." : "did not meet the bar; see the table above."}
`;

const outDir = dirname(fileURLToPath(import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "REPORT.md"), report);
console.log(report);
process.exit(pass ? 0 : 1);
