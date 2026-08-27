#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sealEvidenceEnvelope, sealWorkEvent } from "../dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "fixtures", "assurance", "v1");
const digest = (character) => character.repeat(64);

const evidence = sealEvidenceEnvelope({
  schemaVersion: "evidence-provider/v1",
  work: { id: "sample-change", objective: "Confirm the bounded change behaves as declared." },
  claims: [{ id: "behavior", statement: "The declared behavior passes its native check.", verdict: "pass", evidenceRefs: ["native-check", "result-log"] }],
  source: { capturedDigest: digest("a"), currentDigest: digest("a"), label: "source snapshot" },
  commands: [{ id: "native-check", command: "project-test-command", exitCode: 0, resultDigest: digest("b") }],
  artifacts: [{ id: "result-log", path: "evidence/result.txt", digest: digest("c") }],
  limitations: ["This generic fixture contains synthetic digests and establishes no deployment claim."],
  authority: { kind: "human", id: "review-owner", decision: "approved" },
});

const events = [
  sealWorkEvent({ schemaVersion: "work-event/v1", id: "sample-checkpoint", kind: "checkpoint", at: "2026-08-25T16:00:00.000Z", workId: evidence.work.id, summary: "A content-bound evidence result is available for caller review.", outcome: "checkpoint_ready", sourceDigest: evidence.source.capturedDigest, limitations: evidence.limitations }),
  sealWorkEvent({ schemaVersion: "work-event/v1", id: "sample-terminal", kind: "terminal", at: "2026-08-25T16:05:00.000Z", workId: evidence.work.id, summary: "The caller recorded its terminal outcome.", outcome: "complete", limitations: evidence.limitations }),
];

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
writeFileSync(join(out, "work-events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
console.log(`Rendered neutral assurance fixtures in ${out}`);
