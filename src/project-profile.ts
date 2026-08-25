import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { stringify } from "yaml";

import { initProject, loadOutcome, loadProject, type Actor, type Outcome } from "./contribution.js";

export type ProjectKind = "node" | "python" | "rust" | "go" | "generic";

export interface ProjectProfile {
  kind: ProjectKind;
  label: string;
  installSteps: string[];
  checks: Array<{ id: string; description: string; command: string; whyItMatters: string }>;
  detectedFrom: string[];
}

export interface ProofInitInput {
  root?: string;
  outcomeId?: string;
  title?: string;
  objective?: string;
  check?: string;
  forceWorkflow?: boolean;
}

export interface ProofInitResult {
  profile: ProjectProfile;
  outcome: Outcome;
  outcomePath: string;
  workflowPath: string;
  projectCreated: boolean;
}

export interface ProofCustomizeInput {
  root?: string;
  outcomeId: string;
  title?: string;
  objective?: string;
  check?: string;
  claim?: string;
  why?: string;
  decision?: string;
  decisionId?: string;
  guidance?: string;
  include?: string[];
  exclude?: string[];
  maxChangedFiles?: number;
}

export interface ProofCustomizeResult {
  outcome: Outcome;
  outcomePath: string;
  changed: boolean;
  changes: string[];
}

function packageJson(root: string): { scripts?: Record<string, string>; packageManager?: string } | undefined {
  const path = join(root, "package.json");
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

export function detectProject(rootInput = process.cwd()): ProjectProfile {
  const root = resolve(rootInput);
  const pkg = packageJson(root);
  if (pkg) {
    const manager = existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(root, "yarn.lock")) ? "yarn" : "npm";
    const run = (script: string) => manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`;
    const install = manager === "pnpm" ? "corepack enable && pnpm install --frozen-lockfile"
      : manager === "yarn" ? "corepack enable && yarn install --immutable"
        : existsSync(join(root, "package-lock.json")) ? "npm ci" : "npm install";
    const checks: ProjectProfile["checks"] = [];
    if (pkg.scripts?.test) checks.push({ id: "tests", description: "The project test suite passes", command: run("test"), whyItMatters: "The behavior covered by the repository's tests still works at this exact revision." });
    if (pkg.scripts?.typecheck) checks.push({ id: "types", description: "Static type checks pass", command: run("typecheck"), whyItMatters: "The change remains consistent with the project's declared type contracts." });
    if (pkg.scripts?.build) checks.push({ id: "build", description: "The production build succeeds", command: run("build"), whyItMatters: "The repository can produce its declared build artifact from this revision." });
    if (!checks.length) checks.push({ id: "package", description: "The Node package metadata is valid", command: "node -e \"JSON.parse(require('fs').readFileSync('package.json','utf8'))\"", whyItMatters: "The detected project has a readable package contract; add a real test command before relying on this gate." });
    return { kind: "node", label: "Node.js", installSteps: [install], checks, detectedFrom: ["package.json"] };
  }
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))) {
    const install = existsSync(join(root, "requirements.txt")) ? "python -m pip install -r requirements.txt" : "python -m pip install -e .";
    return { kind: "python", label: "Python", installSteps: [install], checks: [{ id: "tests", description: "The Python test suite passes", command: "python -m pytest", whyItMatters: "The behavior covered by the repository's tests still works at this exact revision." }], detectedFrom: [existsSync(join(root, "pyproject.toml")) ? "pyproject.toml" : "requirements.txt"] };
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    return { kind: "rust", label: "Rust", installSteps: [], checks: [{ id: "tests", description: "The Rust test suite passes", command: "cargo test --all-targets", whyItMatters: "The crate's executable behavior remains valid at this exact revision." }, { id: "format", description: "Rust formatting is current", command: "cargo fmt --all -- --check", whyItMatters: "The contribution follows the repository's deterministic formatting contract." }], detectedFrom: ["Cargo.toml"] };
  }
  if (existsSync(join(root, "go.mod"))) {
    return { kind: "go", label: "Go", installSteps: [], checks: [{ id: "tests", description: "The Go test suite passes", command: "go test ./...", whyItMatters: "All discovered Go packages pass their tests at this exact revision." }], detectedFrom: ["go.mod"] };
  }
  return { kind: "generic", label: "generic Git", installSteps: [], checks: [{ id: "diff", description: "The proposed patch has no whitespace errors", command: "git diff --check", whyItMatters: "The patch is mechanically clean. Replace this starter check with a project-specific behavior test." }], detectedFrom: [] };
}

function githubSetup(profile: ProjectProfile): string {
  if (profile.kind === "node") return `      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - name: Install project dependencies\n        run: ${profile.installSteps[0]}`;
  if (profile.kind === "python") return `      - uses: actions/setup-python@v5\n        with:\n          python-version: \"3.12\"\n      - name: Install project dependencies\n        run: ${profile.installSteps[0]}`;
  if (profile.kind === "rust") return "      - uses: dtolnay/rust-toolchain@stable\n        with:\n          components: rustfmt";
  if (profile.kind === "go") return "      - uses: actions/setup-go@v5\n        with:\n          go-version: stable\n          cache: true";
  return "      # Add project setup steps here when your proof command needs them.";
}

function renderGithubWorkflowTemplate(profile: ProjectProfile, outcomeId: string): string {
  return `name: Keyoku proof\n\non:\n  pull_request:\n  workflow_dispatch:\n\n# Repository-defined proof commands execute untrusted pull-request code.\n# Keep this job read-only; GitHub's native PR review owns the human decision.\npermissions:\n  contents: read\n\nconcurrency:\n  group: keyoku-proof-\${{ github.event.pull_request.number || github.ref }}\n  cancel-in-progress: true\n\njobs:\n  factfile:\n    name: Keyoku / outcome proof\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n${githubSetup(profile)}\n      - name: Install Keyoku\n        run: npm install --global keyoku@latest\n      - name: Prove the proposed outcome\n        id: proof\n        env:\n          KEYOKU_BASE_SHA: \${{ github.event.pull_request.base.sha || github.event.before || github.sha }}\n        run: keyoku proof ci ${outcomeId} --base "$KEYOKU_BASE_SHA"\n      - name: Attach the full Factfile\n        if: always()\n        uses: actions/upload-artifact@v4\n        with:\n          name: keyoku-factfile-\${{ github.sha }}\n          path: .keyoku/contributions/\${{ steps.proof.outputs.contribution_id }}/factfile.*\n          if-no-files-found: error\n          retention-days: 14\n`;
}

export function renderGithubWorkflow(profile: ProjectProfile, outcomeId: string): string {
  return renderGithubWorkflowTemplate(profile, outcomeId)
    .replace("- name: Install Keyoku\n        run: npm install --global keyoku@latest", "- name: Install the Keyoku v3 source alpha\n        run: npm install --global github:Keyoku-ai/keyoku#proof-alpha.1");
}

export function initProof(input: ProofInitInput = {}): ProofInitResult {
  const root = resolve(input.root ?? process.cwd());
  const profile = detectProject(root);
  const projectPath = join(root, ".keyoku", "project.yaml");
  const projectCreated = !existsSync(projectPath);
  const project = projectCreated ? initProject({ root, name: basename(root) }) : loadProject(root);
  const id = (input.outcomeId ?? "review-ready-change").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "");
  const outcomePath = join(root, ".keyoku", "outcomes", `${id}.yaml`);
  if (existsSync(outcomePath)) throw new Error(`${outcomePath} already exists; Keyoku will not overwrite an outcome contract.`);
  const timestamp = new Date().toISOString();
  const owner: Actor = { kind: "human", id: "repository-owner", name: "Repository owner", role: "accountable owner" };
  const checks = input.check ? [{ id: "project-check", description: "The project-defined outcome check passes", command: input.check, whyItMatters: "The repository owner selected this command as the executable definition of the outcome." }] : profile.checks;
  const outcome: Outcome = {
    schemaVersion: "keyoku.dev/outcome/v1alpha1",
    id,
    revision: 1,
    title: input.title ?? "A reviewer can confidently decide this change",
    objective: input.objective ?? `The proposed ${project.name} change is understandable, bounded, and supported by the repository's own executable checks.`,
    owner,
    constraints: [
      "One contribution represents one coherent reviewer outcome; split unrelated work.",
      "Passing checks support only their declared claims and do not replace human review.",
      "Evidence must describe the exact Git revision under review.",
    ],
    criteria: checks.map((check) => ({
      description: check.description,
      probe: { kind: "command" as const, run: check.command, timeoutMs: 300_000, parse: "text" as const },
      assert: { path: "exitCode", op: "eq" as const, value: 0 },
      evidence: {
        summary: `${check.description} at the exact revision shown in this Factfile.`,
        whyItMatters: check.whyItMatters,
        code: [],
        artifacts: [],
      },
    })),
    humanCriteria: [{
      id: "coherent-review-unit",
      description: "This contribution is one coherent outcome and the implementation is understandable enough to own",
      guidance: "Read the reviewer brief, inspect the changed areas and evidence, then review the diff where judgment is still required.",
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  mkdirSync(join(root, ".keyoku", "outcomes"), { recursive: true });
  writeFileSync(outcomePath, stringify(outcome, { lineWidth: 100 }), "utf8");
  const workflowPath = join(root, ".github", "workflows", "keyoku-proof.yml");
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  if (!existsSync(workflowPath) || input.forceWorkflow) writeFileSync(workflowPath, renderGithubWorkflow(profile, id), "utf8");
  return { profile, outcome, outcomePath, workflowPath, projectCreated };
}

/** Small, flag-friendly customization surface for people and agents. Outcome
 * YAML remains the portable source of truth, but common edits should not
 * require understanding the full schema. Meaningful edits create a new
 * repository-visible outcome revision. */
export function customizeProof(input: ProofCustomizeInput): ProofCustomizeResult {
  const root = resolve(input.root ?? process.cwd());
  const outcome = loadOutcome(root, input.outcomeId);
  const outcomePath = join(root, ".keyoku", "outcomes", `${outcome.id}.yaml`);
  const changes: string[] = [];
  if (input.title && input.title !== outcome.title) {
    outcome.title = input.title;
    changes.push("title");
  }
  if (input.objective && input.objective !== outcome.objective) {
    outcome.objective = input.objective;
    changes.push("objective");
  }
  if (input.check) {
    outcome.criteria.push({
      description: input.claim ?? "The added project-specific check passes",
      probe: { kind: "command", run: input.check, timeoutMs: 300_000, parse: "text" },
      assert: { path: "exitCode", op: "eq", value: 0 },
      evidence: {
        summary: `${input.claim ?? "The added project-specific check passes"} at the exact source snapshot shown in the Factfile.`,
        whyItMatters: input.why ?? "The repository owner selected this command as evidence for the requested outcome.",
        code: [],
        artifacts: [],
      },
    });
    changes.push("automated claim");
  }
  if (input.decision) {
    const id = (input.decisionId ?? input.decision).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
    if (!id) throw new Error("--decision-id must contain at least one letter or number.");
    if (outcome.humanCriteria.some((criterion) => criterion.id === id)) throw new Error(`Human decision '${id}' already exists.`);
    outcome.humanCriteria.push({ id, description: input.decision, ...(input.guidance ? { guidance: input.guidance } : {}) });
    changes.push("human decision");
  }
  if (input.include || input.exclude || input.maxChangedFiles !== undefined) {
    outcome.scope = {
      include: input.include ?? outcome.scope?.include ?? [],
      exclude: input.exclude ?? outcome.scope?.exclude ?? [],
      ...(input.maxChangedFiles !== undefined || outcome.scope?.maxChangedFiles !== undefined
        ? { maxChangedFiles: input.maxChangedFiles ?? outcome.scope?.maxChangedFiles }
        : {}),
    };
    changes.push("review boundary");
  }
  if (!changes.length) return { outcome, outcomePath, changed: false, changes };
  outcome.revision += 1;
  outcome.updatedAt = new Date().toISOString();
  writeFileSync(outcomePath, stringify(outcome, { lineWidth: 100 }), "utf8");
  return { outcome, outcomePath, changed: true, changes };
}
