#!/usr/bin/env node
// Release preflight — catches the class of bug that shipped a stale version
// (the reported VERSION drifting from package.json) BEFORE a tag goes out.
// Pure Node, no deps. Run via `npm run preflight` (builds first) and in CI's
// release workflow ahead of publish. Exits non-zero with a clear reason on any
// failure; prints a green summary otherwise.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

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

const action = read("action.yml");
const actionVersion = action.match(/keyoku-version:[\s\S]*?default:\s*["']?([^"'\s]+)["']?/m)?.[1];
if (actionVersion === version) ok("GitHub Action installs the exact package version");
else fail("GitHub Action installs the exact package version", `action.yml defaults to ${actionVersion ?? "no version"}, package.json is ${version}`);

// 3. VERSION must be DERIVED from package.json, never a hardcoded literal — this
//    is the exact regression that shipped "0.1.0" while the package was 2.7.x.
const server = read("src/public-server.ts");
const versionDecl = server.match(/export const VERSION[^\n]*=([^\n]*)/);
if (!versionDecl) {
  fail("VERSION is single-sourced", "could not find `export const VERSION` in src/public-server.ts");
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
if (files.includes("dist/index.js")) ok("the v3 entrypoint is included in published files");
else fail("the v3 entrypoint is included in published files", `package.json "files" = ${JSON.stringify(files)}`);
if (!files.some((file) => file.includes("legacy-cli"))) ok("the compatibility CLI is excluded from published files");
else fail("the compatibility CLI is excluded from published files", "legacy-cli must remain test-only");

// 6. The built help is the customer-facing contract. Legacy muscle-memory
// commands may remain regression-tested, but cannot leak back into v3 help.
try {
  const help = execFileSync("node", ["dist/index.js", "help"], { cwd: root, encoding: "utf8" });
  for (const command of ["proof", "factfile", "pulse", "serve", "doctor", "version", "help"]) {
    if (!new RegExp(`keyoku\\s+${command}\\b`).test(help)) fail(`public help includes ${command}`, "missing from dist/index.js help");
  }
  const leaked = ["goal", "workflow", "connector", "record", "iterate", "contribution", "gate", "project", "outcome"]
    .filter((command) => new RegExp(`keyoku\\s+${command}\\b`).test(help));
  if (leaked.length === 0) ok("built help contains no legacy top-level commands");
  else fail("built help contains no legacy top-level commands", `found: ${leaked.join(", ")}`);
} catch (err) {
  fail("built public help is inspectable", err instanceof Error ? err.message : String(err));
}

// 7. Source maps make accidental bundling inspectable. These v2 subsystems may
// remain in the repository and test-only compatibility build, but must not be
// reachable code in the shipped v3 entrypoint.
try {
  const map = JSON.parse(read("dist/index.js.map"));
  const prohibited = new Set(["connectors.ts", "engine.ts", "learn.ts", "observe.ts", "openapi.ts", "slm.ts", "server.ts", "store.ts", "executor.ts"]);
  const leaked = map.sources.filter((source) => prohibited.has(basename(source)));
  if (leaked.length === 0) ok("the public bundle excludes v2 connector, goal, memory, learning, and execution modules");
  else fail("the public bundle excludes v2 connector, goal, memory, learning, and execution modules", leaked.join(", "));
} catch (err) {
  fail("the public bundle source inventory is inspectable", err instanceof Error ? err.message : String(err));
}

console.log("\nkeyoku release preflight\n" + checks.join("\n"));
if (failures.length > 0) {
  console.error("\nFAILED:\n" + failures.join("\n") + "\n");
  process.exit(1);
}
console.log(`\nAll ${checks.length} candidate checks passed. This is not publish authorization; security, UX, distribution, and owner release gates still apply.\n`);
