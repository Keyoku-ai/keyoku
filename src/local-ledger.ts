import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_APPEND_BYTES = 1024 * 1024;

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function directoryFlag(): number {
  return typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
}

function sameIdentity(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requirePlainDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Local ledger directory must be a real directory, not a link or special file: ${path}`);
  }
  if (realpathSync(path) !== path) {
    throw new Error(`Local ledger directory resolves through a symbolic link: ${path}`);
  }
}

function requirePlainFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Local ledger must be a regular file, not a link or special file: ${path}`);
  }
  if (realpathSync(path) !== path) {
    throw new Error(`Local ledger resolves through a symbolic link: ${path}`);
  }
}

function openAnchoredParent(parent: string): { fd: number; identity: ReturnType<typeof fstatSync> } {
  requirePlainDirectory(parent);
  const fd = openSync(parent, constants.O_RDONLY | directoryFlag() | noFollowFlag());
  const identity = fstatSync(fd);
  const current = lstatSync(parent);
  if (!identity.isDirectory() || current.isSymbolicLink() || !sameIdentity(identity, current) || realpathSync(parent) !== parent) {
    closeSync(fd);
    throw new Error(`Local ledger directory changed while it was opened: ${parent}`);
  }
  return { fd, identity };
}

function assertAnchoredParent(parent: string, identity: ReturnType<typeof fstatSync>): void {
  const current = lstatSync(parent);
  if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(identity, current) || realpathSync(parent) !== parent) {
    throw new Error(`Local ledger directory changed during the operation: ${parent}`);
  }
}

function assertPathMatchesFd(path: string, fd: number): void {
  const opened = fstatSync(fd);
  const current = lstatSync(path);
  if (!opened.isFile() || current.isSymbolicLink() || !current.isFile() || !sameIdentity(opened, current) || realpathSync(path) !== path) {
    throw new Error(`Local ledger path changed during the operation: ${path}`);
  }
}

function pathMatchesFd(path: string, fd: number): boolean {
  try {
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    return opened.isFile() && current.isFile() && !current.isSymbolicLink() && sameIdentity(opened, current);
  } catch {
    return false;
  }
}

/** Resolve private repository-local directories without following writable path links. */
export function resolvePrivateDirectory(rootInput: string, components: string[], create = true): string {
  const suppliedRoot = resolve(rootInput);
  if (!existsSync(suppliedRoot)) {
    if (!create) return join(suppliedRoot, ...components);
    mkdirSync(suppliedRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }
  const root = realpathSync(suppliedRoot);
  requirePlainDirectory(root);

  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]!;
    if (!/^[A-Za-z0-9._-]+$/.test(component) || component === "." || component === "..") {
      throw new Error(`Invalid private directory component: ${component}`);
    }
    current = join(current, component);
    if (!existsSync(current)) {
      if (!create) return join(current, ...components.slice(index + 1));
      mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
    }
    requirePlainDirectory(current);
  }
  return current;
}

/** Resolve a private repository-local ledger without following writable path links. */
export function resolveLocalLedger(rootInput: string, filename: string, create = true): string {
  const current = resolvePrivateDirectory(rootInput, [".keyoku", "pulse"], create);
  const path = join(current, filename);
  if (existsSync(path)) requirePlainFile(path);
  return path;
}

/** Read through an opened file descriptor and reject path or parent replacement. */
export function readLocalLedger(path: string): Buffer {
  if (!existsSync(path)) return Buffer.alloc(0);
  const parent = dirname(path);
  const anchor = openAnchoredParent(parent);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollowFlag());
    assertAnchoredParent(parent, anchor.identity);
    assertPathMatchesFd(path, fd);
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_LEDGER_BYTES) throw new Error(`Local ledger exceeds the ${MAX_LEDGER_BYTES}-byte local safety limit: ${path}`);
    assertAnchoredParent(parent, anchor.identity);
    assertPathMatchesFd(path, fd);
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeSync(anchor.fd);
  }
}

/**
 * Serialize a bounded append and fsync it through an identity-checked descriptor.
 * This protects cooperative local writers and fails closed on path replacement;
 * it is not a sandbox against a malicious process with the same OS account.
 */
export function updateLocalLedger(path: string, update: (current: Buffer) => Buffer): void {
  const parent = dirname(path);
  const anchor = openAnchoredParent(parent);
  const lockPath = `${path}.lock`;
  let lockFd: number | undefined;
  let ledgerFd: number | undefined;
  try {
    try {
      lockFd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag(), PRIVATE_FILE_MODE);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      if (code === "EEXIST") {
        throw new Error(`Local ledger is busy: ${lockPath}. If no writer is alive, inspect and remove this stale lock before retrying.`);
      }
      throw error;
    }
    fchmodSync(lockFd, PRIVATE_FILE_MODE);
    assertAnchoredParent(parent, anchor.identity);
    assertPathMatchesFd(lockPath, lockFd);

    ledgerFd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | noFollowFlag(), PRIVATE_FILE_MODE);
    fchmodSync(ledgerFd, PRIVATE_FILE_MODE);
    assertAnchoredParent(parent, anchor.identity);
    assertPathMatchesFd(path, ledgerFd);

    const current = readFileSync(ledgerFd);
    if (current.length > MAX_LEDGER_BYTES) throw new Error(`Local ledger exceeds the ${MAX_LEDGER_BYTES}-byte local safety limit: ${path}`);
    const next = update(current);
    if (!Buffer.isBuffer(next)) throw new Error("Local ledger updates must return a Buffer.");
    if (next.equals(current)) return;
    if (next.length < current.length || !next.subarray(0, current.length).equals(current)) {
      throw new Error("Local ledgers are append-only; an update may not replace or truncate existing bytes.");
    }
    const suffix = next.subarray(current.length);
    if (suffix.length > MAX_APPEND_BYTES || next.length > MAX_LEDGER_BYTES) {
      throw new Error(`Local ledger append exceeds its bounded local safety limit: ${path}`);
    }
    assertAnchoredParent(parent, anchor.identity);
    assertPathMatchesFd(path, ledgerFd);
    const written = writeSync(ledgerFd, suffix, 0, suffix.length);
    if (written !== suffix.length) throw new Error(`Local ledger append was incomplete (${written}/${suffix.length} bytes): ${path}`);
    fsyncSync(ledgerFd);
    assertAnchoredParent(parent, anchor.identity);
    assertPathMatchesFd(path, ledgerFd);
    fsyncSync(anchor.fd);
  } finally {
    if (ledgerFd !== undefined) closeSync(ledgerFd);
    if (lockFd !== undefined) {
      if (pathMatchesFd(lockPath, lockFd)) {
        try { unlinkSync(lockPath); } catch { /* fail closed with a visible stale lock */ }
      }
      closeSync(lockFd);
    }
    closeSync(anchor.fd);
  }
}
