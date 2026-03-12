/**
 * Keyoku binary lifecycle management.
 * Starts/stops the Keyoku Go binary as a child process.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PluginApi } from './types.js';

let keyokuProcess: ChildProcess | null = null;

/**
 * Check if Keyoku is already running by attempting a health check.
 */
async function isKeyokuRunning(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for Keyoku to become healthy, polling every interval up to a timeout.
 */
async function waitForHealthy(url: string, timeoutMs = 5000, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isKeyokuRunning(url)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Find keyoku binary on disk or PATH.
 */
function findKeyokuBinary(): string | null {
  const home = process.env.HOME ?? '';
  const candidates = [
    resolve(home, '.keyoku', 'bin', 'keyoku'),
    resolve(home, '.local', 'bin', 'keyoku'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Fall back to PATH resolution
  return 'keyoku';
}

/**
 * Ensure the Keyoku data directory exists and return the DB path.
 */
function ensureDataDir(): string {
  const dir = resolve(process.env.HOME ?? '', '.keyoku', 'data');
  mkdirSync(dir, { recursive: true });
  return resolve(dir, 'keyoku.db');
}

/**
 * Load key=value pairs from ~/.keyoku/.env if it exists.
 * These are written by `npx @keyoku/openclaw init` during setup.
 */
function loadKeyokuEnv(): Record<string, string> {
  const envPath = resolve(process.env.HOME ?? '', '.keyoku', '.env');
  if (!existsSync(envPath)) return {};

  const vars: Record<string, string> = {};
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return vars;
}

export function registerService(api: PluginApi, keyokuUrl: string): void {
  api.registerService({
    id: 'keyoku-engine',

    async start() {
      // Skip if already running
      if (await isKeyokuRunning(keyokuUrl)) {
        api.logger.info('keyoku: Keyoku already running');
        return;
      }

      const binary = findKeyokuBinary();
      if (!binary) {
        api.logger.warn('keyoku: Keyoku binary not found — memory features require Keyoku to be running');
        return;
      }

      // Prepare environment — merge ~/.keyoku/.env (init-saved keys) with process.env
      const keyokuEnv = loadKeyokuEnv();
      const env = { ...keyokuEnv, ...process.env };
      if (!env.KEYOKU_SESSION_TOKEN) {
        env.KEYOKU_SESSION_TOKEN = randomBytes(16).toString('hex');
        api.logger.info('keyoku: Generated session token');
      }
      // Expose token to the host process so the client (index.ts) can authenticate
      process.env.KEYOKU_SESSION_TOKEN = env.KEYOKU_SESSION_TOKEN;
      if (!env.KEYOKU_DB_PATH) {
        env.KEYOKU_DB_PATH = ensureDataDir();
        api.logger.info(`keyoku: Using database at ${env.KEYOKU_DB_PATH}`);
      }

      try {
        keyokuProcess = spawn(binary, [], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          env,
        });

        // Pipe stdout/stderr to logger
        keyokuProcess.stdout?.on('data', (data: Buffer) => {
          const line = data.toString().trim();
          if (line) api.logger.info(`keyoku: ${line}`);
        });

        keyokuProcess.stderr?.on('data', (data: Buffer) => {
          const line = data.toString().trim();
          if (line) api.logger.warn(`keyoku: ${line}`);
        });

        keyokuProcess.on('error', (err) => {
          api.logger.warn(`keyoku: Failed to start Keyoku: ${err.message}`);
          keyokuProcess = null;
        });

        keyokuProcess.on('exit', (code) => {
          if (code !== 0 && code !== null) {
            api.logger.warn(`keyoku: Keyoku exited with code ${code}`);
          }
          keyokuProcess = null;
        });

        // Wait for health check with retry
        if (await waitForHealthy(keyokuUrl)) {
          api.logger.info('keyoku: Keyoku started successfully');
        } else {
          api.logger.warn('keyoku: Keyoku started but health check failed — it may still be initializing');
        }
      } catch (err) {
        api.logger.warn(`keyoku: Could not start Keyoku: ${String(err)}`);
      }
    },

    stop() {
      if (keyokuProcess) {
        keyokuProcess.kill('SIGTERM');
        keyokuProcess = null;
        api.logger.info('keyoku: Keyoku stopped');
      }
    },
  });
}
