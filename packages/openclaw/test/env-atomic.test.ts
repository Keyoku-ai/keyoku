import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createEnvStaging,
  assertProviderCredentials,
  mergeEnvContent,
  PROVIDER_REQUIRED_KEYS,
} from '../src/env-atomic.js';

function tmpDir(): string {
  return mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keyoku-env-atomic-'));
}

describe('mergeEnvContent', () => {
  it('appends new keys with trailing newline', () => {
    const staged = new Map([
      ['FOO', 'one'],
      ['BAR', 'two'],
    ]);
    const out = mergeEnvContent('', staged);
    expect(out).toBe('FOO=one\nBAR=two\n');
  });

  it('replaces existing keys in place without duplicating', () => {
    const base = 'FOO=old\nBAZ=keep\n';
    const out = mergeEnvContent(base, new Map([['FOO', 'new']]));
    expect(out).toBe('FOO=new\nBAZ=keep\n');
    expect(out.match(/^FOO=/gm)).toHaveLength(1);
  });

  it('handles base without trailing newline', () => {
    const out = mergeEnvContent('FOO=one', new Map([['BAR', 'two']]));
    expect(out).toBe('FOO=one\nBAR=two\n');
  });

  it('escapes regex metacharacters in keys', () => {
    // Not a realistic env key but proves we don't explode.
    const out = mergeEnvContent('K.E=orig\n', new Map([['K.E', 'new']]));
    expect(out).toBe('K.E=new\n');
  });
});

describe('createEnvStaging — atomicity', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stage() does not touch disk', () => {
    const staging = createEnvStaging({ dir, mirrorProcessEnv: false });
    staging.stage('FOO', 'bar');
    expect(existsSync(join(dir, '.env'))).toBe(false);
    expect(staging.pendingCount()).toBe(1);
  });

  it('commit() writes atomically and clears staging', () => {
    const staging = createEnvStaging({ dir, mirrorProcessEnv: false });
    staging.stage('FOO', 'bar');
    staging.commit();
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('FOO=bar\n');
    expect(staging.pendingCount()).toBe(0);
    expect(existsSync(join(dir, '.env.tmp'))).toBe(false);
  });

  it('commit() writes a .env.bak backup when an existing .env is present', () => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'EXISTING=1\n', 'utf-8');
    const staging = createEnvStaging({ dir, mirrorProcessEnv: false });
    staging.stage('NEW', 'v');
    staging.commit();
    expect(existsSync(join(dir, '.env.bak'))).toBe(true);
    expect(readFileSync(join(dir, '.env.bak'), 'utf-8')).toBe('EXISTING=1\n');
    expect(readFileSync(envPath, 'utf-8')).toBe('EXISTING=1\nNEW=v\n');
  });

  it('rollback() leaves pre-init .env bytewise unchanged (the #34 acceptance test)', () => {
    const envPath = join(dir, '.env');
    const original = 'KEYOKU_EXTRACTION_PROVIDER=ollama\nOLLAMA_BASE_URL=http://localhost:11434\n';
    writeFileSync(envPath, original, 'utf-8');

    const staging = createEnvStaging({ dir, mirrorProcessEnv: false });
    staging.stage('KEYOKU_EXTRACTION_PROVIDER', 'gemini');
    staging.stage('KEYOKU_EMBEDDING_PROVIDER', 'gemini');
    // User aborts before entering GEMINI_API_KEY.
    staging.rollback();

    expect(readFileSync(envPath, 'utf-8')).toBe(original);
    expect(staging.pendingCount()).toBe(0);
  });

  it('rollback() restores .env from .env.bak when a partial commit already landed', () => {
    const envPath = join(dir, '.env');
    const original = 'FOO=pristine\n';
    writeFileSync(envPath, original, 'utf-8');

    const staging = createEnvStaging({ dir, mirrorProcessEnv: false });
    staging.stage('FOO', 'dirty');
    staging.commit();
    expect(readFileSync(envPath, 'utf-8')).toBe('FOO=dirty\n');

    // Something downstream errored; the init flow invokes rollback.
    staging.rollback();
    expect(readFileSync(envPath, 'utf-8')).toBe(original);
  });

  it('rollback() removes a stray .env.tmp from a crashed write', () => {
    writeFileSync(join(dir, '.env.tmp'), 'GARBAGE=1\n', 'utf-8');
    const staging = createEnvStaging({ dir, mirrorProcessEnv: false });
    staging.rollback();
    expect(existsSync(join(dir, '.env.tmp'))).toBe(false);
  });

  it('effective() returns staged value before commit, process.env after clear', () => {
    const staging = createEnvStaging({ dir, mirrorProcessEnv: false });
    staging.stage('STAGED_ONLY', 'x');
    expect(staging.effective('STAGED_ONLY')).toBe('x');
    expect(staging.effective('NEVER_SET')).toBeUndefined();
  });

  it('commit() is idempotent / a no-op when nothing is staged', () => {
    writeFileSync(join(dir, '.env'), 'FOO=keep\n', 'utf-8');
    const staging = createEnvStaging({ dir, mirrorProcessEnv: false });
    staging.commit();
    // Should not have created a backup since we never staged anything.
    expect(existsSync(join(dir, '.env.bak'))).toBe(false);
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('FOO=keep\n');
  });
});

describe('assertProviderCredentials', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.values(PROVIDER_REQUIRED_KEYS)) delete process.env[k];
  });

  it('throws when a provider switch lacks its credential', () => {
    const staging = createEnvStaging({ dir, mirrorProcessEnv: false });
    expect(() => assertProviderCredentials(staging, 'gemini')).toThrow(/GEMINI_API_KEY/);
  });

  it('passes when the credential is staged in the same transaction', () => {
    const staging = createEnvStaging({ dir, mirrorProcessEnv: false });
    staging.stage('GEMINI_API_KEY', 'fake-key');
    expect(() => assertProviderCredentials(staging, 'gemini')).not.toThrow();
  });

  it('passes when the credential is inherited from process.env', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const staging = createEnvStaging({ dir, mirrorProcessEnv: false });
    expect(() => assertProviderCredentials(staging, 'openai')).not.toThrow();
  });

  it('reports all missing providers at once (so users fix all at once)', () => {
    const staging = createEnvStaging({ dir, mirrorProcessEnv: false });
    try {
      assertProviderCredentials(staging, 'gemini', 'anthropic');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toMatch(/gemini/);
      expect((e as Error).message).toMatch(/anthropic/);
    }
  });

  it('ignores unknown providers gracefully (no false-positive rejection)', () => {
    const staging = createEnvStaging({ dir, mirrorProcessEnv: false });
    expect(() => assertProviderCredentials(staging, 'pigeon-llm')).not.toThrow();
  });
});
