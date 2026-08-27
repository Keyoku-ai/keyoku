import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertOriginalSourceUnchanged,
  assertSourceCapsuleCurrent,
  captureSourceTreeDigest,
  createSourceCapsule,
  disposeSourceCapsule,
  runCommandInSourceCapsule,
  watchOriginalSource,
  withSourceCapsuleCheckout,
} from "../src/source-capsule.js";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "keyoku-source-capsule-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "owner@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Owner"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), "ignored.log\n", "utf8");
  writeFileSync(join(root, "README.md"), "captured\n", "utf8");
  execFileSync("git", ["add", ".gitignore", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

function checkoutNames(capsuleRoot: string): string[] {
  return readdirSync(capsuleRoot).filter((name) => name.startsWith("checkout-"));
}

describe("content-addressed source capsules", () => {
  it("captures dirty and odd-path bytes, executable modes, and internal symlinks exactly", async () => {
    const root = repository();
    const odd = "odd name\nwith\tcontrols.txt";
    writeFileSync(join(root, "README.md"), "dirty tracked bytes\n", "utf8");
    writeFileSync(join(root, odd), "odd untracked bytes\n", "utf8");
    writeFileSync(join(root, "tool.sh"), "#!/bin/sh\necho capsule\n", "utf8");
    chmodSync(join(root, "tool.sh"), 0o755);
    mkdirSync(join(root, "links"));
    symlinkSync("../README.md", join(root, "links", "readme"));
    writeFileSync(join(root, "ignored.log"), "not source\n", "utf8");

    const capsule = createSourceCapsule(root);
    try {
      expect(capsule.contentDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(capsule.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(["README.md", odd, "tool.sh", "links/readme"]));
      expect(capsule.entries.find((entry) => entry.path === "tool.sh")?.mode).toBe("100755");
      expect(capsule.entries.find((entry) => entry.path === "links/readme")?.mode).toBe("120000");
      expect(capsule.entries.some((entry) => entry.path === "ignored.log")).toBe(false);
      await withSourceCapsuleCheckout(capsule, (checkout) => {
        expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe("dirty tracked bytes\n");
        expect(readFileSync(join(checkout, odd), "utf8")).toBe("odd untracked bytes\n");
        expect(readlinkSync(join(checkout, "links", "readme"))).toBe("../README.md");
      });
      expect(checkoutNames(capsule.capsuleRoot)).toEqual([]);
      assertSourceCapsuleCurrent(capsule);
    } finally {
      const capsuleRoot = capsule.capsuleRoot;
      disposeSourceCapsule(capsule);
      expect(existsSync(capsuleRoot)).toBe(false);
    }
  });

  it("rejects submodules, escaping symlinks, and unsupported filesystem entries", () => {
    const submoduleRoot = repository();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: submoduleRoot, encoding: "utf8" }).trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${head},vendor/dependency`], { cwd: submoduleRoot });
    expect(() => createSourceCapsule(submoduleRoot)).toThrow(/does not support Git submodules/);

    const symlinkRoot = repository();
    symlinkSync("../outside", join(symlinkRoot, "escape"));
    expect(() => createSourceCapsule(symlinkRoot)).toThrow(/symlink escapes/);

    const invalidTargetRoot = repository();
    symlinkSync(Buffer.from([0xff]), join(invalidTargetRoot, "invalid-target"));
    expect(() => createSourceCapsule(invalidTargetRoot)).toThrow(/symlink target is not valid UTF-8/);

    const ignoredTargetRoot = repository();
    writeFileSync(join(ignoredTargetRoot, "ignored.log"), "environment input\n", "utf8");
    symlinkSync("ignored.log", join(ignoredTargetRoot, "ignored-target"));
    expect(() => createSourceCapsule(ignoredTargetRoot)).toThrow(/symlink target is not captured/);

    const fifoRoot = repository();
    execFileSync("mkfifo", [join(fifoRoot, "unsupported.pipe")]);
    expect(() => createSourceCapsule(fifoRoot)).toThrow(/does not support this filesystem entry type/);

    const linkedRuntimeRoot = repository();
    const outsideRuntime = mkdtempSync(join(tmpdir(), "keyoku-capsule-runtime-outside-"));
    mkdirSync(join(linkedRuntimeRoot, ".keyoku"));
    symlinkSync(outsideRuntime, join(linkedRuntimeRoot, ".keyoku", "runtime"), "dir");
    expect(() => createSourceCapsule(linkedRuntimeRoot)).toThrow(/real directory|symbolic link/);

    const linkedAncestorRoot = repository();
    mkdirSync(join(linkedAncestorRoot, "tracked"));
    writeFileSync(join(linkedAncestorRoot, "tracked", "value.txt"), "captured\n", "utf8");
    execFileSync("git", ["add", "tracked/value.txt"], { cwd: linkedAncestorRoot });
    execFileSync("git", ["commit", "-qm", "track nested source"], { cwd: linkedAncestorRoot });
    const preserved = `${join(linkedAncestorRoot, "tracked")}.preserved`;
    renameSync(join(linkedAncestorRoot, "tracked"), preserved);
    const external = mkdtempSync(join(tmpdir(), "keyoku-linked-ancestor-"));
    writeFileSync(join(external, "value.txt"), "external\n", "utf8");
    symlinkSync(external, join(linkedAncestorRoot, "tracked"), "dir");
    expect(() => createSourceCapsule(linkedAncestorRoot)).toThrow(/absolute target|symbolic-link or non-directory ancestor/);
  });

  it("binds symlink targets and excludes only generated proof bookkeeping", () => {
    const root = repository();
    writeFileSync(join(root, "same-a.txt"), "same bytes\n", "utf8");
    writeFileSync(join(root, "same-b.txt"), "same bytes\n", "utf8");
    symlinkSync("same-a.txt", join(root, "selected.txt"));
    const first = captureSourceTreeDigest(root);
    unlinkSync(join(root, "selected.txt"));
    symlinkSync("same-b.txt", join(root, "selected.txt"));
    const second = captureSourceTreeDigest(root);
    expect(second).not.toBe(first);

    mkdirSync(join(root, ".keyoku", "pulse"), { recursive: true });
    writeFileSync(join(root, ".keyoku", "pulse", "events.jsonl"), "generated event\n", "utf8");
    expect(captureSourceTreeDigest(root)).toBe(second);
  });

  it("rejects write, add, delete, executable-mode, and mutate-restore probes without contaminating the next checkout", async () => {
    const root = repository();
    const capsule = createSourceCapsule(root);
    try {
      const probes = [
        "require('fs').appendFileSync('README.md','write')",
        "require('fs').writeFileSync('added.txt','added')",
        "require('fs').unlinkSync('README.md')",
        "require('fs').chmodSync('README.md',0o755)",
        "const f=require('fs');const b=f.readFileSync('README.md');f.writeFileSync('README.md','temporary');f.writeFileSync('README.md',b)",
      ];
      for (const script of probes) {
        await expect(runCommandInSourceCapsule(capsule, { kind: "command", run: `node -e ${JSON.stringify(script)}` })).rejects.toThrow(/mutated its disposable source checkout/);
        expect(checkoutNames(capsule.capsuleRoot)).toEqual([]);
      }
      const read = await runCommandInSourceCapsule(capsule, { kind: "command", run: "node -e \"process.stdout.write(require('fs').readFileSync('README.md'))\"", parse: "text" });
      expect(read).toMatchObject({ output: "captured", exitCode: 0 });
      expect(readFileSync(join(root, "README.md"), "utf8")).toBe("captured\n");
    } finally {
      disposeSourceCapsule(capsule);
    }
  });

  it("does not mistake a read-only Node test run for source mutation", async () => {
    const root = repository();
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n', "utf8");
    writeFileSync(join(root, "value.js"), "export const value = 42;\n", "utf8");
    writeFileSync(join(root, "value.test.js"), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { value } from './value.js';\ntest('reads source', () => assert.equal(value, 42));\n", "utf8");
    execFileSync("git", ["add", "package.json", "value.js", "value.test.js"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "add read-only test"], { cwd: root });

    const capsule = createSourceCapsule(root);
    try {
      const result = await runCommandInSourceCapsule(capsule, { kind: "command", run: "node --test", parse: "text" });
      expect(result.exitCode).toBe(0);
      expect(String(result.output)).toContain("pass 1");
      assertSourceCapsuleCurrent(capsule);
    } finally {
      disposeSourceCapsule(capsule);
    }
  });

  it("detects concurrent mutate-restore of the original source", async () => {
    const root = repository();
    mkdirSync(join(root, "empty-directory"));
    const capsule = createSourceCapsule(root);
    const monitor = watchOriginalSource(capsule);
    try {
      const running = runCommandInSourceCapsule(capsule, { kind: "command", run: "node -e \"setTimeout(()=>{},150)\"", timeoutMs: 1_000 });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      writeFileSync(join(root, "README.md"), "concurrent mutation\n", "utf8");
      writeFileSync(join(root, "README.md"), "captured\n", "utf8");
      writeFileSync(join(root, "transient.txt"), "created then removed\n", "utf8");
      unlinkSync(join(root, "transient.txt"));
      writeFileSync(join(root, "empty-directory", "transient.txt"), "nested transient\n", "utf8");
      unlinkSync(join(root, "empty-directory", "transient.txt"));
      await running;
      await expect(assertOriginalSourceUnchanged(capsule, monitor)).rejects.toThrow(/Original source changed while probes were running/);
    } finally {
      monitor.close();
      disposeSourceCapsule(capsule);
    }
  });

  it("ignores generated Keyoku ledger writes while still detecting Keyoku contract edits", async () => {
    const root = repository();
    mkdirSync(join(root, ".keyoku", "outcomes"), { recursive: true });
    writeFileSync(join(root, ".keyoku", "project.yaml"), "id: fixture\n", "utf8");
    writeFileSync(join(root, ".keyoku", "outcomes", "proof.yaml"), "revision: 1\n", "utf8");
    execFileSync("git", ["add", ".keyoku/project.yaml", ".keyoku/outcomes/proof.yaml"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "add Keyoku contract"], { cwd: root });

    const capsule = createSourceCapsule(root);
    const generatedMonitor = watchOriginalSource(capsule);
    try {
      mkdirSync(join(root, ".keyoku", "contributions", "run"), { recursive: true });
      writeFileSync(join(root, ".keyoku", "contributions", "run", "events.jsonl"), "generated event\n", "utf8");
      await expect(assertOriginalSourceUnchanged(capsule, generatedMonitor)).resolves.toBeUndefined();
    } finally {
      generatedMonitor.close();
    }

    const contractMonitor = watchOriginalSource(capsule);
    try {
      writeFileSync(join(root, ".keyoku", "project.yaml"), "id: changed\n", "utf8");
      writeFileSync(join(root, ".keyoku", "project.yaml"), "id: fixture\n", "utf8");
      await expect(assertOriginalSourceUnchanged(capsule, contractMonitor)).rejects.toThrow(/Original source changed while probes were running/);
    } finally {
      contractMonitor.close();
      disposeSourceCapsule(capsule);
    }
  });

  it("revalidates lasting original changes and cleans a timed-out checkout", async () => {
    const root = repository();
    const capsule = createSourceCapsule(root);
    try {
      const timeout = await runCommandInSourceCapsule(capsule, { kind: "command", run: "node -e \"setTimeout(()=>{},5000)\"", timeoutMs: 80 });
      expect(timeout.error).toContain("timed out");
      expect(checkoutNames(capsule.capsuleRoot)).toEqual([]);
      writeFileSync(join(root, "README.md"), "lasting mutation\n", "utf8");
      expect(() => assertSourceCapsuleCurrent(capsule)).toThrow(/Source changed after capsule capture/);
    } finally {
      disposeSourceCapsule(capsule);
    }
  });

  it("maps only captured cwd paths and refuses paths outside the project", async () => {
    const root = repository();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "value.txt"), "nested\n", "utf8");
    const capsule = createSourceCapsule(root);
    try {
      const relative = await runCommandInSourceCapsule(capsule, { kind: "command", run: "pwd", cwd: "nested", parse: "text" });
      expect(String(relative.output)).toMatch(/\/nested$/);
      await expect(runCommandInSourceCapsule(capsule, { kind: "command", run: "pwd", cwd: tmpdir(), parse: "text" })).rejects.toThrow(/cwd .*outside/);
    } finally {
      disposeSourceCapsule(capsule);
    }
  });
});
