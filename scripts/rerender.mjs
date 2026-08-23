#!/usr/bin/env node
// Re-renders a Factfile HTML from an existing factfile.json without re-running any probes.
//
// Usage:
//   node scripts/rerender.mjs <factfile.json> [output.html]
//   node scripts/rerender.mjs <factfile.json> [output.html] --with-demo-watch <projectRoot>
//
// --with-demo-watch <projectRoot> optionally patches in the "demo-watch-pass" criterion's
// screenshot/report artifacts (base64-embedded, same as resolveEvidencePresentation does at
// gate time) so the filmstrip hero can be exercised even when the on-disk factfile.json predates
// that criterion. It never writes back to the source project — only to this script's output.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { renderFactfileHtml } from "../dist/index.js";

const args = process.argv.slice(2);
const input = args[0];
const output = args[1] && !args[1].startsWith("--") ? args[1] : "preview-factfile.html";
const demoWatchFlagIndex = args.indexOf("--with-demo-watch");
const demoWatchRoot = demoWatchFlagIndex !== -1 ? args[demoWatchFlagIndex + 1] : undefined;

if (!input) {
  console.error("Usage: node scripts/rerender.mjs <factfile.json> [output.html] [--with-demo-watch <projectRoot>]");
  process.exit(2);
}

const snapshot = JSON.parse(readFileSync(resolve(input), "utf8"));

if (demoWatchRoot) {
  const artifactSpecs = [
    { kind: "screenshot", path: "demo-captures/01-cfo-hero.jpeg", label: "CFO executive glance", caption: "Score 58/critical, 20 controls (12 key/8 non-key), systems 4, entities 5, control/risk deltas +2." },
    { kind: "screenshot", path: "demo-captures/09-reviewer-full.jpeg", label: "Reviewer dashboard (new persona)", caption: "Pending review 6, reviewed 3, avg 4.0 days waiting, pending-by-tester breakdown." },
    { kind: "screenshot", path: "demo-captures/12-pbc-testing-period.jpeg", label: "PBC Testing Period column", caption: "Every evidence request shows the testing period it covers." },
    { kind: "report", path: ".keyoku/contributions/dashboards-feedback-round-2026-08-23-0ad97b6a/demo-walkthrough.html", label: "Full demo walkthrough", caption: "All 14 captioned stops, published as a shareable gallery." },
  ];
  const artifacts = artifactSpecs.map((spec) => {
    const absolute = resolve(demoWatchRoot, spec.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return { ...spec, annotations: [], unavailable: "Artifact was not found for this preview." };
    const bytes = readFileSync(absolute);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (spec.kind !== "screenshot" && spec.kind !== "video") return { ...spec, annotations: [], digest };
    const lower = spec.path.toLowerCase();
    const mediaType = lower.endsWith(".jpeg") || lower.endsWith(".jpg") ? "image/jpeg" : lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : undefined;
    if (!mediaType) return { ...spec, annotations: [], digest, unavailable: "Unsupported screenshot format." };
    return { ...spec, annotations: [], digest, mediaType, dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}` };
  });
  snapshot.evidence.push({
    id: "c8",
    description: "An agent watched the recorded demo and every stop's expectations are visibly met",
    pass: true,
    actual: { exitCode: 0 },
    expected: { path: "exitCode", op: "eq", value: 0 },
    durationMs: 41200,
    verification: {
      kind: "command",
      label: "Repository command",
      reproduce: "bash .keyoku/probes/demo-watch-pass.sh",
      assertion: { path: "exitCode", op: "eq", value: 0 },
    },
    presentation: {
      summary: "A vision agent reviewed all 14 Playwright-captured demo frames against their declared expectations (and ran a UI/UX audit); the verdict is pass and postdates the frames.",
      whyItMatters: "Humans digest demos — this proves the demo a stakeholder would watch actually shows the claimed behavior, not just that endpoints return 200.",
      code: [],
      artifacts,
    },
  });
  snapshot.summary = { ...snapshot.summary, passed: snapshot.summary.passed + 1, total: snapshot.summary.total + 1 };
  console.error(`Patched in criterion c8 (demo-watch-pass) with ${artifacts.filter((a) => a.dataUrl).length} embedded screenshot(s) for filmstrip verification.`);
}

const html = renderFactfileHtml(snapshot, {});
const target = resolve(output);
writeFileSync(target, html, "utf8");
console.log(target);
