// ~/.keyoku/.env atomic-write helpers.
//
// Background: init runs through 10+ phases, each writing env keys (provider,
// model, api keys, db path, quiet hours…). The old implementation wrote to
// disk per-key, so if the user aborted mid-flow (or a phase errored) the
// file was left in a half-applied state — e.g. provider switched to Gemini
// with no GEMINI_API_KEY, which then bricks keyoku-engine boot. See
// keyoku#34 and harness/20-contracts/config.md §Atomicity.
//
// Contract honored here:
//   stage-then-commit | atomic rename | backup on replace | signal safe |
//   credential gate.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

export interface EnvStaging {
  /** Stage a key=value; does NOT touch disk. */
  stage(key: string, value: string): void;
  /** Effective value (staged → process.env fallback). */
  effective(key: string): string | undefined;
  /** Atomically persist staged writes. No-op when nothing is staged. */
  commit(): void;
  /** Drop staged writes and restore .env from .env.bak if present. */
  rollback(): void;
  /** Snapshot count of pending writes — for tests/diagnostics. */
  pendingCount(): number;
}

export interface EnvStagingOptions {
  /** Root dir that contains the .env file. Defaults to ~/.keyoku. */
  dir: string;
  /**
   * If true, mirror staged writes into `process.env` so in-process callers
   * that read env via process.env observe staged values before commit.
   * init.ts needs this for downstream step continuity. Tests disable it.
   */
  mirrorProcessEnv?: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Merge staged key/values into an existing .env body. Replace-in-place
 *  when a key already exists, otherwise append on a new line. */
export function mergeEnvContent(base: string, staged: Map<string, string>): string {
  let content = base;
  for (const [key, value] of staged) {
    const line = `${key}=${value}`;
    const regex = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      if (content.length > 0 && !content.endsWith('\n')) content += '\n';
      content += `${line}\n`;
    }
  }
  return content;
}

export function createEnvStaging(opts: EnvStagingOptions): EnvStaging {
  const envPath = join(opts.dir, '.env');
  const tmpPath = join(opts.dir, '.env.tmp');
  const bakPath = join(opts.dir, '.env.bak');
  const staged: Map<string, string> = new Map();
  let snapshot = '';
  let snapshotLoaded = false;

  const mirrorProcessEnv = opts.mirrorProcessEnv ?? true;

  function loadSnapshot(): void {
    if (snapshotLoaded) return;
    snapshot = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
    snapshotLoaded = true;
  }

  return {
    stage(key, value) {
      loadSnapshot();
      staged.set(key, value);
      if (mirrorProcessEnv) process.env[key] = value;
    },
    effective(key) {
      return staged.get(key) ?? process.env[key];
    },
    commit() {
      if (staged.size === 0) return;
      loadSnapshot();
      mkdirSync(opts.dir, { recursive: true });
      const merged = mergeEnvContent(snapshot, staged);
      if (existsSync(envPath)) {
        cpSync(envPath, bakPath);
      }
      writeFileSync(tmpPath, merged, 'utf-8');
      renameSync(tmpPath, envPath);
      snapshot = merged;
      staged.clear();
    },
    rollback() {
      staged.clear();
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // best-effort
      }
      if (existsSync(bakPath)) {
        try {
          cpSync(bakPath, envPath);
        } catch {
          // leave disk untouched if backup unreadable
        }
      }
    },
    pendingCount() {
      return staged.size;
    },
  };
}

/**
 * Per-provider credential requirement. Checked before commit so we never
 * persist a provider switch the engine can't actually use.
 */
export const PROVIDER_REQUIRED_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  ollama: 'OLLAMA_BASE_URL',
};

export function assertProviderCredentials(
  staging: EnvStaging,
  ...providers: string[]
): void {
  const missing: string[] = [];
  for (const provider of new Set(providers)) {
    const required = PROVIDER_REQUIRED_KEYS[provider.toLowerCase()];
    if (!required) continue;
    if (!staging.effective(required)) {
      missing.push(`${provider} requires ${required}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `refusing to persist provider config — missing credentials: ${missing.join(', ')}`,
    );
  }
}
