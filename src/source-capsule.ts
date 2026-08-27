import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJsonDigest } from "./canonical-json.js";
import { resolvePrivateDirectory } from "./local-ledger.js";
import { runProbe } from "./probes.js";
import type { Probe, ProbeEnvelope } from "./types.js";

const CAPSULE_SCHEMA = "keyoku.dev/source-capsule/v1alpha1" as const;
const RUNTIME_CAPSULE_DIR = join(".keyoku", "runtime", "probe-capsules");
const EXCLUDED_PREFIXES = [join(".keyoku", "contributions"), join(".keyoku", "pulse"), join(".keyoku", "runtime")];

export interface SourceCapsuleEntry {
  path: string;
  kind: "file" | "symlink";
  mode: "100644" | "100755" | "120000";
  byteLength: number;
  digest: string;
}

export interface SourceCapsule {
  schemaVersion: typeof CAPSULE_SCHEMA;
  sourceRoot: string;
  runtimeRoot: string;
  capsuleRoot: string;
  gitDir: string;
  treeOid: string;
  commitOid: string;
  contentDigest: string;
  captureStateDigest: string;
  entries: SourceCapsuleEntry[];
}

export interface MutationMonitor {
  readonly mutations: string[];
  clear(): void;
  close(): void;
}

interface ScannedEntry extends SourceCapsuleEntry {
  bytes: Buffer;
  mutationKey: string;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function filesystemMutationKey(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  // ctime is not part of the captured source identity. APFS can advance it for
  // read-only directory walks (notably Node's test discovery) even when bytes,
  // mode, size, inode, and mtime are unchanged. Including it makes a clean
  // verifier look like a source writer. Writes and mutate-restore attempts are
  // still covered by exact bytes, inode/mode/size/mtime, and the live watcher.
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs].join(":");
}

function filesystemDirectoryIdentityKey(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory()) throw new Error(`Expected a source directory: ${path}`);
  // Directory mtimes describe child-entry churn, including writes beneath
  // excluded Keyoku ledgers. Exact source bytes plus the live watcher cover
  // those entries; bind the directory object itself without making generated
  // evidence change its parent's source identity.
  return [stat.dev, stat.ino, stat.mode].join(":");
}

function assertPlainParentChain(root: string, path: string): string {
  const relativeDirectory = normalizedRelative(root, dirname(path));
  const parts = relativeDirectory.split("/").filter((part) => part && part !== ".");
  const identities: string[] = [`.:${filesystemDirectoryIdentityKey(root)}`];
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Source path has a symbolic-link or non-directory ancestor: ${normalizedRelative(root, current)}`);
    }
    if (realpathSync(current) !== current) {
      throw new Error(`Source path ancestor resolves outside its lexical directory: ${normalizedRelative(root, current)}`);
    }
    identities.push(`${normalizedRelative(root, current)}:${filesystemDirectoryIdentityKey(current)}`);
  }
  return identities.join("|");
}

function gitBuffer(root: string, args: string[], label: string, options: { gitDir?: string; env?: NodeJS.ProcessEnv; input?: Buffer } = {}): Buffer {
  try {
    return execFileSync("git", [...(options.gitDir ? ["--git-dir", options.gitDir] : []), ...args], {
      cwd: root,
      env: { ...process.env, ...options.env },
      input: options.input,
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`Cannot ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function gitText(root: string, args: string[], label: string, options: { gitDir?: string; env?: NodeJS.ProcessEnv; input?: Buffer } = {}): string {
  return gitBuffer(root, args, label, options).toString("utf8").trim();
}

function splitNul(value: Buffer, label: string): string[] {
  const values: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    const bytes = value.subarray(start, index);
    if (bytes.length > 0) {
      const path = bytes.toString("utf8");
      if (!Buffer.from(path, "utf8").equals(bytes)) throw new Error(`${label} contains a filename that is not valid UTF-8.`);
      values.push(path);
    }
    start = index + 1;
  }
  if (start !== value.length) throw new Error(`${label} was not NUL terminated.`);
  return values;
}

function normalizedRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

function isExcluded(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized === ".git" || normalized.startsWith(".git/")
    || EXCLUDED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function readRegularFileNoFollow(path: string): Buffer {
  const before = lstatSync(path);
  const beforeKey = filesystemMutationKey(path);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`Source path changed while it was opened: ${path}`);
    const bytes = readFileSync(descriptor);
    const after = lstatSync(path);
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino || filesystemMutationKey(path) !== beforeKey) {
      throw new Error(`Source path changed while it was read: ${path}`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readSymlinkTarget(path: string): { target: string; bytes: Buffer } {
  const before = filesystemMutationKey(path);
  const bytes = readlinkSync(path, { encoding: "buffer" });
  if (filesystemMutationKey(path) !== before) throw new Error(`Source symlink changed while it was read: ${path}`);
  const target = bytes.toString("utf8");
  if (!Buffer.from(target, "utf8").equals(bytes)) {
    throw new Error(`Source symlink target is not valid UTF-8: ${path}`);
  }
  return { target, bytes };
}

function trackedModes(root: string): Map<string, string> {
  const records = splitNul(gitBuffer(root, ["ls-files", "--stage", "-z"], "read the staged source modes"), "Git staged path list");
  const modes = new Map<string, string>();
  for (const record of records) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("Git staged path record is malformed.");
    const metadata = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    modes.set(path, metadata[0] ?? "");
  }
  return modes;
}

function visibleSourcePaths(root: string): string[] {
  const paths = splitNul(
    gitBuffer(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], "enumerate the complete tracked and untracked source tree"),
    "Git source path list",
  );
  return [...new Set(paths.filter((path) => !isExcluded(path)))].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function gitPathIsIgnored(root: string, path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--", path], { cwd: root, stdio: "ignore" });
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return false;
    throw new Error(`Cannot evaluate Git ignore policy for ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertNoUnsupportedSourceEntries(root: string): void {
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const absolute = join(directory, name);
      const path = normalizedRelative(root, absolute);
      if (isExcluded(path)) continue;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        if (!gitPathIsIgnored(root, path)) visit(absolute);
      } else if (!stat.isFile() && !stat.isSymbolicLink() && !gitPathIsIgnored(root, path)) {
        throw new Error(`Source capsule does not support this filesystem entry type: ${path}`);
      }
    }
  };
  visit(root);
}

function visibleSourceDirectories(root: string): string[] {
  const directories: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const absolute = join(directory, name);
      const path = normalizedRelative(root, absolute);
      if (isExcluded(path)) continue;
      const stat = lstatSync(absolute);
      if (!stat.isDirectory() || stat.isSymbolicLink() || gitPathIsIgnored(root, path)) continue;
      directories.push(path);
      visit(absolute);
    }
  };
  visit(root);
  return directories.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function scanSourceTree(rootInput: string): ScannedEntry[] {
  const root = realpathSync(resolve(rootInput));
  assertNoUnsupportedSourceEntries(root);
  const modes = trackedModes(root);
  const entries: ScannedEntry[] = [];
  for (const path of visibleSourcePaths(root)) {
    if (modes.get(path) === "160000") throw new Error(`Source capsule does not support Git submodules: ${path}. Capture the required submodule bytes in the parent repository or use a separate Factfile.`);
    const absolute = resolve(root, path);
    const relativePath = normalizedRelative(root, absolute);
    if (!relativePath || relativePath.startsWith("../") || isAbsolute(relativePath)) throw new Error(`Source path escapes the repository root: ${path}`);
    const parentBefore = assertPlainParentChain(root, absolute);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(absolute); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // A tracked deletion is represented by absence.
      throw error;
    }
    if (stat.isDirectory()) throw new Error(`Source capsule encountered an unsupported directory entry: ${path}`);
    if (stat.isSymbolicLink()) {
      const { target, bytes } = readSymlinkTarget(absolute);
      if (isAbsolute(target)) throw new Error(`Source symlink must not use an absolute target: ${path}`);
      const targetAbsolute = resolve(dirname(absolute), target);
      const targetRelative = normalizedRelative(root, targetAbsolute);
      if (!targetRelative || targetRelative.startsWith("../") || isAbsolute(targetRelative)) throw new Error(`Source symlink escapes the repository root: ${path}`);
      if (isExcluded(targetRelative)) throw new Error(`Source symlink targets excluded verifier state: ${path} -> ${targetRelative}`);
      const parentAfter = assertPlainParentChain(root, absolute);
      if (parentAfter !== parentBefore) throw new Error(`Source path ancestors changed while reading: ${path}`);
      entries.push({ path: relativePath, kind: "symlink", mode: "120000", byteLength: bytes.length, digest: digest(bytes), bytes, mutationKey: `${parentAfter}|${filesystemMutationKey(absolute)}` });
      continue;
    }
    if (!stat.isFile()) throw new Error(`Source capsule does not support this filesystem entry type: ${path}`);
    const bytes = readRegularFileNoFollow(absolute);
    const parentAfter = assertPlainParentChain(root, absolute);
    if (parentAfter !== parentBefore) throw new Error(`Source path ancestors changed while reading: ${path}`);
    entries.push({
      path: relativePath,
      kind: "file",
      mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644",
      byteLength: bytes.length,
      digest: digest(bytes),
      bytes,
      mutationKey: `${parentAfter}|${filesystemMutationKey(absolute)}`,
    });
  }
  const capturedPaths = new Set(entries.map((entry) => entry.path));
  const capturedDirectories = new Set<string>();
  for (const entry of entries) {
    const parts = dirname(entry.path).split("/").filter((part) => part && part !== ".");
    parts.forEach((_part, index) => capturedDirectories.add(parts.slice(0, index + 1).join("/")));
  }
  for (const entry of entries.filter((candidate) => candidate.kind === "symlink")) {
    const { target } = readSymlinkTarget(resolve(root, entry.path));
    const targetPath = normalizedRelative(root, resolve(dirname(resolve(root, entry.path)), target));
    if (!capturedPaths.has(targetPath) && !capturedDirectories.has(targetPath)) {
      throw new Error(`Source symlink target is not captured by the capsule: ${entry.path} -> ${targetPath}`);
    }
  }
  return entries;
}

function publicEntries(entries: ScannedEntry[]): SourceCapsuleEntry[] {
  return entries.map(({ bytes: _bytes, mutationKey: _mutationKey, ...entry }) => entry);
}

function sourceStateDigest(root: string, entries: ScannedEntry[]): string {
  return canonicalJsonDigest({
    root: filesystemDirectoryIdentityKey(root),
    directories: visibleSourceDirectories(root).map((path) => ({ path, mutationKey: filesystemDirectoryIdentityKey(resolve(root, path)) })),
    entries: entries.map((entry) => ({ path: entry.path, mutationKey: entry.mutationKey })),
  });
}

function capsuleDigest(entries: SourceCapsuleEntry[]): string {
  return canonicalJsonDigest({ schemaVersion: CAPSULE_SCHEMA, entries });
}

/** Compute the same complete content identity used to materialize command probes. */
export function captureSourceTreeDigest(rootInput: string): string {
  return capsuleDigest(publicEntries(scanSourceTree(rootInput)));
}

function safeCleanup(path: string, requiredParent: string): void {
  const resolvedPath = resolve(path);
  const resolvedParent = resolve(requiredParent);
  const relation = relative(resolvedParent, resolvedPath);
  if (!relation || relation.startsWith("..") || isAbsolute(relation) || !resolvedPath.startsWith(`${resolvedParent}${sep}`)) {
    throw new Error(`Refusing to clean an unvalidated capsule path: ${resolvedPath}`);
  }
  rmSync(resolvedPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  if (existsSync(resolvedPath)) throw new Error(`Disposable capsule path could not be cleaned: ${resolvedPath}`);
}

/** Capture exact tracked and non-ignored untracked bytes without touching the caller's index. */
export function createSourceCapsule(rootInput: string): SourceCapsule {
  const sourceRoot = realpathSync(resolve(rootInput));
  const gitRoot = realpathSync(gitText(sourceRoot, ["rev-parse", "--show-toplevel"], "establish the source repository root"));
  if (gitRoot !== sourceRoot) throw new Error(`Keyoku project root must match the Git repository root for capsule verification (${sourceRoot} != ${gitRoot}).`);
  const runtimeRoot = resolvePrivateDirectory(sourceRoot, RUNTIME_CAPSULE_DIR.split(sep));
  const capsuleRoot = mkdtempSync(join(runtimeRoot, "capsule-"));
  const gitDir = join(capsuleRoot, "objects.git");
  const indexFile = join(capsuleRoot, "capsule.index");
  try {
    gitText(sourceRoot, ["init", "--bare", "--quiet", gitDir], "initialize the disposable capsule repository");
    const first = scanSourceTree(sourceRoot);
    const entries = publicEntries(first);
    const contentDigest = capsuleDigest(entries);
    const captureStateDigest = sourceStateDigest(sourceRoot, first);
    gitText(sourceRoot, ["read-tree", "--empty"], "initialize the capsule index", { gitDir, env: { GIT_INDEX_FILE: indexFile } });
    const indexRecords: Buffer[] = [];
    for (const entry of first) {
      const oid = gitText(sourceRoot, ["hash-object", "-w", "--stdin"], `hash source bytes for ${entry.path}`, { gitDir, input: entry.bytes });
      indexRecords.push(Buffer.from(`${entry.mode} ${oid}\t${entry.path}\0`, "utf8"));
    }
    if (indexRecords.length > 0) gitBuffer(sourceRoot, ["update-index", "-z", "--index-info"], "populate the capsule index", { gitDir, env: { GIT_INDEX_FILE: indexFile }, input: Buffer.concat(indexRecords) });
    const treeOid = gitText(sourceRoot, ["write-tree"], "write the capsule tree", { gitDir, env: { GIT_INDEX_FILE: indexFile } });
    const commitOid = gitText(sourceRoot, ["commit-tree", treeOid], "seal the capsule commit", {
      gitDir,
      input: Buffer.from(`Keyoku source capsule ${contentDigest}\n`, "utf8"),
      env: {
        GIT_AUTHOR_NAME: "Keyoku Capsule",
        GIT_AUTHOR_EMAIL: "capsule@keyoku.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_NAME: "Keyoku Capsule",
        GIT_COMMITTER_EMAIL: "capsule@keyoku.invalid",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    });
    gitText(sourceRoot, ["update-ref", "refs/heads/capsule", commitOid], "publish the local capsule ref", { gitDir });
    gitText(sourceRoot, ["symbolic-ref", "HEAD", "refs/heads/capsule"], "select the local capsule ref", { gitDir });
    const capsule: SourceCapsule = { schemaVersion: CAPSULE_SCHEMA, sourceRoot, runtimeRoot, capsuleRoot, gitDir, treeOid, commitOid, contentDigest, captureStateDigest, entries };
    assertSourceCapsuleCurrent(capsule);
    return capsule;
  } catch (error) {
    safeCleanup(capsuleRoot, runtimeRoot);
    throw error;
  }
}

/** Re-read caller bytes/modes/path inventory and fail if they differ from capture. */
export function assertSourceCapsuleCurrent(capsule: SourceCapsule): void {
  const scanned = scanSourceTree(capsule.sourceRoot);
  const currentDigest = capsuleDigest(publicEntries(scanned));
  if (currentDigest !== capsule.contentDigest || sourceStateDigest(capsule.sourceRoot, scanned) !== capsule.captureStateDigest) {
    throw new Error(`Source changed after capsule capture (captured ${capsule.contentDigest}, current ${currentDigest}).`);
  }
}

function scanMaterializedTree(rootInput: string): { digest: string; mutationDigest: string; paths: string[] } {
  const root = realpathSync(resolve(rootInput));
  const records: Array<{ path: string; kind: "directory" | "file" | "symlink"; mode: number; byteLength?: number; digest?: string }> = [];
  const mutationRecords: Array<{ path: string; mutationKey: string }> = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
      const absolute = join(directory, name);
      const path = normalizedRelative(root, absolute);
      if (isExcluded(path)) continue;
      const stat = lstatSync(absolute);
      const mode = stat.mode & 0o7777;
      if (stat.isDirectory()) {
        records.push({ path, kind: "directory", mode });
        visit(absolute);
        mutationRecords.push({ path, mutationKey: filesystemMutationKey(absolute) });
      } else if (stat.isSymbolicLink()) {
        const { bytes } = readSymlinkTarget(absolute);
        records.push({ path, kind: "symlink", mode, byteLength: bytes.length, digest: digest(bytes) });
        mutationRecords.push({ path, mutationKey: filesystemMutationKey(absolute) });
      } else if (stat.isFile()) {
        const bytes = readRegularFileNoFollow(absolute);
        records.push({ path, kind: "file", mode, byteLength: bytes.length, digest: digest(bytes) });
        mutationRecords.push({ path, mutationKey: filesystemMutationKey(absolute) });
      } else throw new Error(`Disposable checkout contains an unsupported filesystem entry: ${path}`);
    }
  };
  visit(root);
  return { digest: canonicalJsonDigest(records), mutationDigest: canonicalJsonDigest(mutationRecords), paths: records.map((record) => record.path) };
}

function assertMaterializedCheckout(capsule: SourceCapsule, checkout: string): void {
  const expectedFiles = new Set(capsule.entries.map((entry) => entry.path));
  const expectedDirectories = new Set<string>();
  for (const entry of capsule.entries) {
    const parts = dirname(entry.path).split("/").filter((part) => part && part !== ".");
    parts.forEach((_part, index) => expectedDirectories.add(parts.slice(0, index + 1).join("/")));
    const absolute = resolve(checkout, entry.path);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(absolute); }
    catch { throw new Error(`Disposable checkout is missing captured source path: ${entry.path}`); }
    if (entry.kind === "symlink") {
      if (!stat.isSymbolicLink()) throw new Error(`Disposable checkout changed the captured symlink type: ${entry.path}`);
      const { bytes } = readSymlinkTarget(absolute);
      if (digest(bytes) !== entry.digest) throw new Error(`Disposable checkout changed captured symlink bytes: ${entry.path}`);
    } else {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Disposable checkout changed the captured file type: ${entry.path}`);
      const mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
      if (mode !== entry.mode || digest(readRegularFileNoFollow(absolute)) !== entry.digest) throw new Error(`Disposable checkout does not match captured bytes or mode: ${entry.path}`);
    }
  }
  const materialized = scanMaterializedTree(checkout).paths.filter((path) => !expectedDirectories.has(path));
  const extras = materialized.filter((path) => !expectedFiles.has(path));
  if (extras.length > 0) throw new Error(`Disposable checkout contains paths outside the source capsule: ${extras.slice(0, 8).join(", ")}`);
}

function watchDirectories(rootInput: string, directories: string[], ignored: (path: string) => boolean): MutationMonitor {
  const root = resolve(rootInput);
  const changed = new Set<string>();
  const watchers: FSWatcher[] = [];
  for (const relativeDirectory of [...new Set(["", ...directories])].sort()) {
    const directory = resolve(root, relativeDirectory);
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) continue;
    try {
      watchers.push(watch(directory, { persistent: false }, (_event, name) => {
        const path = name == null ? relativeDirectory || "<unknown>" : join(relativeDirectory, String(name)).split(sep).join("/");
        if (!ignored(path)) changed.add(path);
      }));
    } catch (error) {
      watchers.forEach((watcher) => watcher.close());
      throw new Error(`Cannot monitor source mutations at ${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    get mutations() { return [...changed].sort(); },
    clear() { changed.clear(); },
    close() { watchers.forEach((watcher) => watcher.close()); },
  };
}

export function watchOriginalSource(capsule: SourceCapsule): MutationMonitor {
  const directories = visibleSourceDirectories(capsule.sourceRoot);
  return watchDirectories(capsule.sourceRoot, directories, (path) => {
    // macOS can report a descendant write under an excluded Keyoku ledger as
    // the coarse root-level name `.keyoku`. Dedicated watchers on `.keyoku`
    // and its visible source directories still observe project/outcome edits
    // precisely, while exact digest/state checks cover lasting changes. Ignore
    // only this ambiguous ancestor notification so Keyoku's own Factfile and
    // session writes cannot make an otherwise stable proof fail at random.
    return path === ".keyoku" || isExcluded(path);
  });
}

async function settleWatcher(): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
}

export async function assertOriginalSourceUnchanged(capsule: SourceCapsule, monitor: MutationMonitor): Promise<void> {
  await settleWatcher();
  const current = scanSourceTree(capsule.sourceRoot);
  const currentContentDigest = capsuleDigest(publicEntries(current));
  const currentStateDigest = sourceStateDigest(capsule.sourceRoot, current);
  if (monitor.mutations.length > 0 || currentContentDigest !== capsule.contentDigest || currentStateDigest !== capsule.captureStateDigest) {
    const details = monitor.mutations.slice(0, 8).join(", ") || "bytes, paths, or filesystem identity changed";
    throw new Error(`Original source changed while probes were running (${details}).`);
  }
}

function mapProbeCwd(capsule: SourceCapsule, checkout: string, cwdInput?: string): string {
  const requestedInput = cwdInput ? (isAbsolute(cwdInput) ? resolve(cwdInput) : resolve(capsule.sourceRoot, cwdInput)) : capsule.sourceRoot;
  const requested = existsSync(requestedInput) ? realpathSync(requestedInput) : requestedInput;
  const path = normalizedRelative(capsule.sourceRoot, requested);
  if (path.startsWith("../") || isAbsolute(path)) throw new Error(`Command probe cwd is outside the captured source root: ${cwdInput}`);
  const mapped = resolve(checkout, path || ".");
  if (!existsSync(mapped) || !lstatSync(mapped).isDirectory()) throw new Error(`Command probe cwd is not a captured directory: ${cwdInput ?? "."}`);
  const realCheckout = realpathSync(checkout);
  const realMapped = realpathSync(mapped);
  const relation = relative(realCheckout, realMapped);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`Command probe cwd traverses outside the captured source root: ${cwdInput}`);
  return mapped;
}

export async function withSourceCapsuleCheckout<T>(capsule: SourceCapsule, callback: (checkout: string) => Promise<T> | T): Promise<T> {
  const checkout = mkdtempSync(join(capsule.capsuleRoot, "checkout-"));
  try {
    gitText(capsule.sourceRoot, ["clone", "--quiet", "--no-local", capsule.gitDir, checkout], "materialize a fresh capsule checkout");
    assertMaterializedCheckout(capsule, checkout);
    return await callback(checkout);
  } finally {
    safeCleanup(checkout, capsule.capsuleRoot);
  }
}

/** Run trusted repository code in a disposable source copy and reject every observed write. */
export async function runCommandInSourceCapsule(capsule: SourceCapsule, probe: Extract<Probe, { kind: "command" }>): Promise<ProbeEnvelope> {
  assertSourceCapsuleCurrent(capsule);
  return withSourceCapsuleCheckout(capsule, async (checkout) => {
    const before = scanMaterializedTree(checkout);
    const directories = before.paths.filter((path) => existsSync(join(checkout, path)) && lstatSync(join(checkout, path)).isDirectory());
    const monitor = watchDirectories(checkout, directories, (path) => path === ".git" || path.startsWith(".git/"));
    let envelope: ProbeEnvelope;
    try {
      await settleWatcher();
      monitor.clear();
      envelope = await runProbe({ ...probe, cwd: mapProbeCwd(capsule, checkout, probe.cwd) });
      await settleWatcher();
    } finally {
      monitor.close();
    }
    const after = scanMaterializedTree(checkout);
    if (before.digest !== after.digest || before.mutationDigest !== after.mutationDigest) {
      const details = monitor.mutations.slice(0, 8).join(", ") || "filesystem state changed";
      throw new Error(`Proof refused: a verification probe mutated its disposable source checkout (${details}).`);
    }
    return envelope;
  });
}

export function disposeSourceCapsule(capsule: SourceCapsule): void {
  safeCleanup(capsule.capsuleRoot, capsule.runtimeRoot);
}
