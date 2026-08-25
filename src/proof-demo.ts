import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";

import {
  reviewContribution,
  runGate,
  startContribution,
  type GateSnapshot,
  type Outcome,
} from "./contribution.js";
import { initProof } from "./project-profile.js";

export interface ProofDemoOptions {
  root?: string;
  open?: boolean;
  log?: (line: string) => void;
}

export interface ProofDemoResult {
  root: string;
  contributionId: string;
  factfilePath: string;
  firstSnapshot: GateSnapshot;
  snapshot: GateSnapshot;
  staleRejection: string;
}

function command(root: string, args: string[]): string {
  return execFileSync(args[0]!, args.slice(1), {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function demoRoot(requested?: string): string {
  if (!requested) return mkdtempSync(join(tmpdir(), "keyoku-proof-demo-"));
  const root = resolve(requested);
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`Demo directory is not empty: ${root}`);
  }
  mkdirSync(root, { recursive: true });
  return root;
}

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function openFile(path: string): void {
  try {
    if (process.platform === "darwin") execFileSync("open", [path], { stdio: "ignore" });
    else if (process.platform === "win32") execFileSync("cmd", ["/c", "start", "", path], { stdio: "ignore" });
    else execFileSync("xdg-open", [path], { stdio: "ignore" });
  } catch {
    // The path is always printed, so a missing desktop opener is non-fatal.
  }
}

/**
 * Run a real, disposable Keyoku proof from start to Factfile. The demo uses a
 * tiny Node repository so it has no package-install or network dependency, but
 * every Git capture, test observation, digest, state transition, and renderer
 * is the same implementation used in a real project.
 */
export async function runProofDemo(options: ProofDemoOptions = {}): Promise<ProofDemoResult> {
  const root = demoRoot(options.root);
  const log = options.log ?? (() => undefined);

  log("KEYOKU PROOF DEMO");
  log("A real repository, a real check, and a real exact-revision Factfile.\n");

  log("1/5  DEFINE       Create the baseline repository and Git-owned outcome");
  command(root, ["git", "init", "-q"]);
  command(root, ["git", "config", "user.email", "demo@keyoku.ai"]);
  command(root, ["git", "config", "user.name", "Keyoku Demo"]);
  write(root, "package.json", `${JSON.stringify({
    name: "keyoku-cart-recovery-demo",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2)}\n`);
  write(root, "src/cart.js", `export function restoreCart() {\n  return [];\n}\n`);
  write(root, "README.md", "# Cart recovery demo\n\nA tiny repository used by `keyoku proof demo`.\n");
  command(root, ["git", "add", "."]);
  command(root, ["git", "commit", "-qm", "baseline before cart recovery"]);
  const baseSha = command(root, ["git", "rev-parse", "HEAD"]);

  const initialized = initProof({
    root,
    outcomeId: "cart-recovery",
    title: "A returning shopper gets the saved cart back",
    objective: "A saved cart is restored with the same products and quantities, and a reviewer can see exactly what established that claim.",
    check: "node --test",
  });
  const outcome = parse(readFileSync(initialized.outcomePath, "utf8")) as Outcome;
  outcome.criteria[0]!.description = "Saved products and quantities are restored exactly";
  outcome.criteria[0]!.evidence = {
    summary: "The cart recovery behavior passed its repository test at this exact source snapshot.",
    whyItMatters: "A returning shopper should not have to rebuild a cart after signing in.",
    code: [
      { path: "src/cart.js", purpose: "Restores and normalizes saved cart lines." },
      { path: "test/cart.test.js", purpose: "Exercises product and quantity preservation." },
    ],
    artifacts: [],
  };
  outcome.humanCriteria = [{
    id: "reviewable-evidence",
    description: "The evidence and change boundary are clear enough for a human to accept this outcome",
    guidance: "Inspect the Factfile summary, exact source identity, changed files, and reproduction command before deciding.",
  }];
  outcome.scope = {
    include: ["src/**", "test/**", ".keyoku/**", ".github/**"],
    exclude: [],
    maxChangedFiles: 12,
  };
  writeFileSync(initialized.outcomePath, stringify(outcome, { lineWidth: 100 }), "utf8");

  log("2/5  CONTRIBUTE   Add a behavior test that exposes the missing recovery");
  write(root, "test/cart.test.js", `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { restoreCart } from "../src/cart.js";\n\ntest("restores saved products and quantities", () => {\n  assert.deepEqual(restoreCart([\n    { productId: "tea", quantity: 2 },\n    { productId: "cup", quantity: 1 },\n  ]), [\n    { productId: "tea", quantity: 2 },\n    { productId: "cup", quantity: 1 },\n  ]);\n});\n`);

  log("3/5  OBSERVE      Run the repository-owned check: node --test");
  const contribution = startContribution({
    root,
    outcomeId: outcome.id,
    baseSha,
    summary: "Restores the shopper's saved cart and adds an executable behavior check.",
    actor: {
      kind: "agent",
      id: "keyoku-demo-agent",
      name: "Demo coding agent",
      role: "implementer",
      harness: "Keyoku CLI demo",
      ownerId: "repository-owner",
    },
  });
  const firstSnapshot = await runGate(root, contribution.id);
  log(`     ✗ ${firstSnapshot.summary.failed}/${firstSnapshot.summary.total} claim has an evidence gap`);

  log("4/5  VERIFY       Fix the defect and rerun the same declared proof");
  const fixedSource = `export function restoreCart(savedLines) {\n  return savedLines\n    .filter((line) => line.quantity > 0)\n    .map((line) => ({ productId: line.productId, quantity: line.quantity }));\n}\n`;
  write(root, "src/cart.js", fixedSource);
  const snapshot = await runGate(root, contribution.id);
  const factfilePath = join(root, ".keyoku", "contributions", contribution.id, "factfile.html");

  log(`     ✓ ${snapshot.summary.passed}/${snapshot.summary.total} claim supported`);
  log(`     State: ${snapshot.state.toUpperCase().replaceAll("_", " ")}`);
  log(`     Bound to: ${snapshot.repository.headSha.slice(0, 8)}+${snapshot.repository.worktreeDigest.slice(0, 8)}`);

  log("5/5  DECIDE       Change the source after proof and test the review boundary");
  write(root, "src/cart.js", `${fixedSource}\n// changed after the Factfile was generated\n`);
  let staleRejection = "";
  try {
    reviewContribution({
      root,
      contributionId: contribution.id,
      decision: "note",
      comment: "Demo-only attempt to review a stale snapshot.",
      reviewer: { kind: "human", id: "demo-reviewer", name: "Demo reviewer", role: "reviewer" },
    });
  } catch (error) {
    staleRejection = error instanceof Error ? error.message : String(error);
  } finally {
    write(root, "src/cart.js", fixedSource);
  }
  if (!staleRejection) throw new Error("The proof demo expected stale review rejection, but the review was accepted.");
  log("     ✓ STALE PROOF REJECTED — source changed after evidence was captured\n");
  log("Open the Factfile:");
  log(`  ${factfilePath}`);
  log("Demo files are kept here:");
  log(`  ${root}`);
  log("\nExplore the optional live review UI:");
  log(`  cd ${root}`);
  log(`  keyoku proof serve ${contribution.id}`);

  if (options.open) openFile(factfilePath);
  return { root, contributionId: contribution.id, factfilePath, firstSnapshot, snapshot, staleRejection };
}
