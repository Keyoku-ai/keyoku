#!/usr/bin/env node
// Release preflight — catches the class of bug that shipped a stale version
// (the reported VERSION drifting from package.json) BEFORE a tag goes out.
// Pure Node, no deps. Run via `npm run preflight` (builds first) and in CI's
// release workflow ahead of publish. Exits non-zero with a clear reason on any
// failure; prints a green summary otherwise.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const failures = [];
const checks = [];
const ok = (label) => checks.push(`  ✓ ${label}`);
const fail = (label, detail) => failures.push(`  ✗ ${label}\n      ${detail}`);

const pkg = JSON.parse(read("package.json"));
const version = pkg.version;

// 1. package.json version is a valid semver.
if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) ok(`package.json version is valid semver (${version})`);
else fail("package.json version is valid semver", `got "${version}"`);

// 2. CHANGELOG has an entry for this version (no shipping an undocumented release).
const changelog = read("CHANGELOG.md");
if (new RegExp(`^##\\s+${version.replace(/[.]/g, "\\.")}\\b`, "m").test(changelog)) ok(`CHANGELOG.md documents ${version}`);
else fail("CHANGELOG.md documents this version", `no "## ${version}" heading found — add a changelog entry`);

// 3. VERSION must be DERIVED from package.json, never a hardcoded literal — this
//    is the exact regression that shipped "0.1.0" while the package was 2.7.x.
const server = read("src/server.ts");
const versionDecl = server.match(/export const VERSION[^\n]*=([^\n]*)/);
if (!versionDecl) {
  fail("VERSION is single-sourced", "could not find `export const VERSION` in src/server.ts");
} else if (/=\s*["'`]\d+\.\d+\.\d+["'`]/.test(versionDecl[0])) {
  fail("VERSION is single-sourced", `VERSION is a hardcoded literal (${versionDecl[1].trim()}) — derive it from package.json so it can't drift`);
} else if (!/package\.json|readFileSync|VERSION:\s*string\s*=/.test(server.slice(server.indexOf("export const VERSION")))) {
  fail("VERSION is single-sourced", "VERSION does not appear to read package.json — verify it is derived, not hardcoded");
} else {
  ok("VERSION is single-sourced from package.json (not a hardcoded literal)");
}

// 4. The strongest check: the BUILT artifact actually reports package.json's
//    version. This is end-to-end — it would have caught the 0.1.0 drift directly.
//    Requires `npm run build` to have run first (the npm script does this).
try {
  const reported = execFileSync("node", ["dist/index.js", "version"], { cwd: root, encoding: "utf8" }).trim();
  if (reported === version) ok(`built artifact reports ${version} (matches package.json)`);
  else fail("built artifact version matches package.json", `dist/index.js reports "${reported}", package.json says "${version}" — rebuild (npm run build)`);
} catch (err) {
  fail("built artifact version matches package.json", `could not run dist/index.js — build first (npm run build). ${err instanceof Error ? err.message : err}`);
}

// 5. The npm tarball must ship what the runtime reads at load time. VERSION reads
//    ../package.json relative to dist/, so package.json must be in the tarball.
//    npm always includes package.json, README, LICENSE regardless of `files`,
//    so this is a guard against someone "optimising" it out.
const files = pkg.files ?? [];
if (files.some((f) => f.startsWith("dist"))) ok("dist is included in the published files");
else fail("dist is included in the published files", `package.json "files" = ${JSON.stringify(files)} — dist must ship`);

console.log("\nkeyoku release preflight\n" + checks.join("\n"));
if (failures.length > 0) {
  console.error("\nFAILED:\n" + failures.join("\n") + "\n");
  process.exit(1);
}
console.log(`\nAll ${checks.length} checks passed — safe to tag v${version}.\n`);
