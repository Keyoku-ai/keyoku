import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";

import { customizeProof, detectProject, initProof, renderGithubWorkflow } from "../src/project-profile.js";
import { listOutcomeHistory, loadOutcome, renderFactfileGithubMarkdown, runGate, startContribution } from "../src/contribution.js";

function directory(label: string): string {
  return mkdtempSync(join(tmpdir(), `keyoku-${label}-`));
}

function gitRepo(label: string): string {
  const root = directory(label);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "owner@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Project Owner"], { cwd: root });
  return root;
}

describe("cross-project proof setup", () => {
  it.each([
    ["python", "pyproject.toml", "[project]\nname='demo'\n", "python -m pytest"],
    ["rust", "Cargo.toml", "[package]\nname='demo'\nversion='0.1.0'\n", "cargo test --all-targets"],
    ["go", "go.mod", "module example.test/demo\n\ngo 1.24\n", "go test ./..."],
    ["generic", "README.md", "# Demo\n", "git diff --check"],
  ])("detects %s projects and emits an appropriate proof command", (kind, filename, content, command) => {
    const root = directory(kind);
    writeFileSync(join(root, filename), content, "utf8");
    const profile = detectProject(root);
    expect(profile.kind).toBe(kind);
    expect(profile.checks.some((check) => check.command === command)).toBe(true);
    expect(renderGithubWorkflow(profile, "review-ready-change")).toContain("fetch-depth: 0");
  });

  it("installs a bounded outcome and safe GitHub workflow in one command", () => {
    const root = gitRepo("node-init");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "node build.js" } }), "utf8");
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ name: "demo", lockfileVersion: 3, packages: {} }), "utf8");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });

    const result = initProof({ root });
    expect(result.profile.kind).toBe("node");
    expect(result.projectCreated).toBe(true);
    expect(existsSync(result.outcomePath)).toBe(true);
    expect(existsSync(result.workflowPath)).toBe(true);
    expect(loadOutcome(root, result.outcome.id).humanCriteria[0]?.id).toBe("coherent-review-unit");
    const workflow = readFileSync(result.workflowPath, "utf8");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain("name: Keyoku / outcome proof");
    expect(workflow).toContain("keyoku proof ci review-ready-change");
    expect(workflow).not.toContain("pull-requests: write");
  });

  it("customizes common proof fields without requiring direct YAML edits", () => {
    const root = gitRepo("customize");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    initProof({ root });
    const result = customizeProof({
      root,
      outcomeId: "review-ready-change",
      objective: "A user can complete checkout without losing their cart.",
      check: "npm run test:checkout",
      claim: "Checkout completes end to end",
      why: "This is the user-visible behavior being shipped.",
      decision: "The recovery path is understandable on mobile",
      decisionId: "mobile-recovery",
      guidance: "Inspect the attached mobile recording.",
      include: ["src/**", "tests/**"],
      maxChangedFiles: 20,
    });
    expect(result.changed).toBe(true);
    expect(result.outcome.revision).toBe(2);
    expect(result.outcome.criteria.at(-1)?.description).toBe("Checkout completes end to end");
    expect(result.outcome.humanCriteria.at(-1)?.id).toBe("mobile-recovery");
    expect(result.outcome.scope).toMatchObject({ include: ["src/**", "tests/**"], maxChangedFiles: 20 });
    expect(loadOutcome(root, "review-ready-change").objective).toContain("complete checkout");
  });
});

describe("Git-native contribution history", () => {
  it("binds committed PR changes to their base and renders a reviewer-first GitHub summary", async () => {
    const root = gitRepo("history");
    writeFileSync(join(root, "README.md"), "# Before\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    initProof({ root, check: "node -e \"process.exit(0)\"" });
    const outcomePath = join(root, ".keyoku", "outcomes", "review-ready-change.yaml");
    const outcome = parse(readFileSync(outcomePath, "utf8"));
    outcome.scope = { include: ["README.md", ".keyoku/**", ".github/**"], exclude: [], maxChangedFiles: 10 };
    writeFileSync(outcomePath, stringify(outcome), "utf8");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "add proof contract"], { cwd: root });
    expect(listOutcomeHistory(root, "review-ready-change")).toMatchObject([{ revision: 1, subject: "add proof contract" }]);
    writeFileSync(join(root, "README.md"), "# After\n\nOne coherent outcome.\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "deliver outcome"], { cwd: root });

    const contribution = startContribution({ root, outcomeId: "review-ready-change", baseSha: base, summary: "Makes the documented behavior explicit and reviewable." });
    const snapshot = await runGate(root, contribution.id);
    expect(snapshot.repository.changedFiles).toContain("README.md");
    expect(snapshot.scope.passed).toBe(true);
    expect(snapshot.state).toBe("human_review_required");
    expect(snapshot.reviewPlan.some((item) => item.title.includes("security-, data-, workflow-"))).toBe(true);
    const markdown = renderFactfileGithubMarkdown(snapshot);
    expect(markdown).toContain("Keyoku · Human review needed");
    expect(markdown).toContain("Review path");
    expect(markdown).toContain("What is established");
    expect(markdown).toContain("What only a human can decide");
    expect(markdown).toContain("What “proof” means here");
    expect(markdown).toContain(base);
    expect(readFileSync(join(root, ".keyoku", "contributions", contribution.id, "factfile.github.md"), "utf8")).toBe(markdown);
  });

  it("fails closed when committed paths exceed the declared review boundary", async () => {
    const root = gitRepo("scope");
    writeFileSync(join(root, "README.md"), "# Base\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    initProof({ root, check: "node -e \"process.exit(0)\"" });
    const outcomePath = join(root, ".keyoku", "outcomes", "review-ready-change.yaml");
    const outcome = parse(readFileSync(outcomePath, "utf8"));
    outcome.scope = { include: ["src/**"], exclude: [".keyoku/**"] };
    writeFileSync(outcomePath, stringify(outcome), "utf8");
    writeFileSync(join(root, "README.md"), "# Outside scope\n", "utf8");
    const contribution = startContribution({ root, outcomeId: "review-ready-change", baseSha: base });
    const snapshot = await runGate(root, contribution.id);
    expect(snapshot.scope.unexpectedPaths).toContain("README.md");
    expect(snapshot.state).toBe("evidence_gaps");
  });
});
