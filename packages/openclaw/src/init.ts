/**
 * One-command installer for the Keyoku OpenClaw plugin.
 *
 * `npx @keyoku/openclaw init`
 *
 * 1. Detects OpenClaw config
 * 2. Downloads keyoku-engine binary if missing
 * 3. Registers plugin in openclaw.json (with full config defaults)
 * 4. Configures DB path (~/.keyoku/data/keyoku.db)
 * 5. Sets up LLM provider + API key (OpenAI required for embeddings)
 * 6. Sets autonomy level (observe/suggest/act)
 * 7. Auto-detects timezone, configures quiet hours
 * 8. Installs SKILL.md (LLM guidebook) to workspace
 * 9. Offers migration of existing OpenClaw memories
 * 10. Health check to verify everything works
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, createWriteStream, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { KeyokuClient } from '@keyoku/memory';
import { importMemoryFiles } from './migration.js';
import { migrateAllVectorStores, discoverVectorDbs } from './migrate-vector-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOME = process.env.HOME ?? '';
const OPENCLAW_CONFIG_PATH = join(HOME, '.openclaw', 'openclaw.json');
const KEYOKU_BIN_DIR = join(HOME, '.keyoku', 'bin');
const KEYOKU_BIN_PATH = join(KEYOKU_BIN_DIR, 'keyoku');
const OPENCLAW_MEMORY_DIR = join(HOME, '.openclaw', 'memory');

interface OpenClawConfig {
  plugins?: {
    entries?: Record<string, { enabled: boolean; config?: Record<string, unknown> }>;
    slots?: Record<string, string>;
  };
  [key: string]: unknown;
}

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function success(msg: string): void {
  console.log(`  [OK] ${msg}`);
}

function warn(msg: string): void {
  console.log(`  [!] ${msg}`);
}

// Pre-buffered stdin lines for piped (non-TTY) input.
// When stdin is a pipe, readline only delivers the first line via question().
// We read all lines upfront and serve them from the buffer.
let stdinLines: string[] | null = null;
let stdinReady: Promise<void> | null = null;

function ensureStdinBuffer(): Promise<void> {
  if (stdinReady) return stdinReady;
  if (process.stdin.isTTY) {
    stdinReady = Promise.resolve();
    return stdinReady;
  }
  stdinReady = new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    const lines: string[] = [];
    rl.on('line', (line) => lines.push(line));
    rl.on('close', () => {
      stdinLines = lines;
      resolve();
    });
  });
  return stdinReady;
}

// Shared readline for TTY interactive mode
let ttyRl: ReturnType<typeof createInterface> | null = null;

function closeTtyReadline(): void {
  if (ttyRl) {
    ttyRl.close();
    ttyRl = null;
  }
}

async function prompt(question: string): Promise<string> {
  await ensureStdinBuffer();

  // Piped mode — read from pre-buffered lines
  if (stdinLines !== null) {
    process.stdout.write(`  ${question} `);
    const answer = stdinLines.shift() ?? '';
    console.log(answer);
    return answer.trim();
  }

  // TTY mode — interactive prompt
  if (!ttyRl) {
    ttyRl = createInterface({ input: process.stdin, output: process.stdout });
  }
  return new Promise((resolve) => {
    ttyRl!.question(`  ${question} `, (answer) => {
      resolve(answer.trim());
    });
  });
}

/** Prompt that lowercases the answer (for y/n and enum choices). */
async function promptLower(question: string): Promise<string> {
  return (await prompt(question)).toLowerCase();
}

/**
 * Detect platform and architecture for binary download.
 */
function getPlatformInfo(): { os: string; arch: string } {
  const platform = process.platform;
  const arch = process.arch;

  const osMap: Record<string, string> = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'windows',
  };

  const archMap: Record<string, string> = {
    x64: 'amd64',
    arm64: 'arm64',
  };

  return {
    os: osMap[platform] ?? platform,
    arch: archMap[arch] ?? arch,
  };
}

/**
 * Download the keyoku-engine binary from GitHub releases.
 */
async function downloadBinary(): Promise<boolean> {
  const { os, arch } = getPlatformInfo();
  const binaryName = os === 'windows' ? 'keyoku-server.exe' : 'keyoku-server';
  const assetName = `keyoku-server-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;

  log(`Downloading keyoku-engine for ${os}/${arch}...`);

  try {
    // Get latest release info from GitHub API
    const releaseRes = await fetch(
      'https://api.github.com/repos/keyoku-ai/keyoku-engine/releases/latest',
      { headers: { Accept: 'application/vnd.github.v3+json' } },
    );

    if (!releaseRes.ok) {
      warn(`Could not fetch latest release: ${releaseRes.status} ${releaseRes.statusText}`);
      return false;
    }

    const release = await releaseRes.json() as {
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    };

    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) {
      warn(`No binary found for ${os}/${arch} in release ${release.tag_name}`);
      warn(`Available assets: ${release.assets.map((a) => a.name).join(', ')}`);
      return false;
    }

    log(`Downloading ${asset.name} from release ${release.tag_name}...`);

    // Download the binary
    const downloadRes = await fetch(asset.browser_download_url);
    if (!downloadRes.ok || !downloadRes.body) {
      warn(`Download failed: ${downloadRes.status}`);
      return false;
    }

    // Ensure directory exists
    mkdirSync(KEYOKU_BIN_DIR, { recursive: true });

    // Stream to file
    const destPath = KEYOKU_BIN_PATH;
    const fileStream = createWriteStream(destPath);
    // @ts-expect-error — Node fetch body is a ReadableStream, pipeline handles it
    await pipeline(downloadRes.body, fileStream);

    // Make executable
    if (os !== 'windows') {
      chmodSync(destPath, 0o755);
    }

    success(`Binary installed at ${destPath}`);
    return true;
  } catch (err) {
    warn(`Failed to download binary: ${String(err)}`);
    return false;
  }
}

/**
 * Read and parse the OpenClaw config file.
 */
function readOpenClawConfig(): OpenClawConfig | null {
  if (!existsSync(OPENCLAW_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8')) as OpenClawConfig;
  } catch {
    return null;
  }
}

/**
 * Write the OpenClaw config file.
 */
function writeOpenClawConfig(config: OpenClawConfig): void {
  writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Install the SKILL.md guidebook to the workspace skills directory.
 * This teaches the LLM how to interpret heartbeat signals, use memory naturally, etc.
 */
function installSkill(): void {
  // The skill ships with the package at ../skills/keyoku-memory/SKILL.md
  const bundledSkillDir = join(__dirname, '..', 'skills', 'keyoku-memory');
  const bundledSkillPath = join(bundledSkillDir, 'SKILL.md');

  // Install to workspace skills (highest precedence)
  const workspaceSkillDir = join(HOME, '.openclaw', 'skills', 'keyoku-memory');

  if (existsSync(join(workspaceSkillDir, 'SKILL.md'))) {
    success('SKILL.md already installed in workspace');
    return;
  }

  if (!existsSync(bundledSkillPath)) {
    warn('Bundled SKILL.md not found — skill will load from plugin package instead');
    return;
  }

  mkdirSync(workspaceSkillDir, { recursive: true });
  cpSync(bundledSkillPath, join(workspaceSkillDir, 'SKILL.md'));
  success('SKILL.md installed to ~/.openclaw/skills/keyoku-memory/');
}

/**
 * Set up LLM provider and API keys.
 * OpenAI is required for embeddings. Extraction provider is configurable.
 */
async function setupLlmProvider(): Promise<void> {
  console.log('');
  log('LLM Provider Setup');
  log('Keyoku needs an OpenAI API key for embeddings (text-embedding-3-small).');
  log('It also needs an LLM for memory extraction (can be OpenAI, Anthropic, or Gemini).');
  console.log('');

  // Check existing env vars
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;

  if (hasOpenAI) {
    success('OPENAI_API_KEY found in environment');
  } else {
    warn('OPENAI_API_KEY not found — required for memory embeddings');
    log('Set it in your shell profile or .env file:');
    log('  export OPENAI_API_KEY=sk-...');
    console.log('');

    const key = await prompt('Enter your OpenAI API key (or press Enter to skip):');
    if (key && key.startsWith('sk-')) {
      appendToEnvFile('OPENAI_API_KEY', key);
      process.env.OPENAI_API_KEY = key;
      success('OPENAI_API_KEY saved to ~/.keyoku/.env');
    } else if (key) {
      warn('That doesn\'t look like an OpenAI key (should start with sk-). Skipping.');
    } else {
      warn('Skipped — you\'ll need to set OPENAI_API_KEY before using memory features');
    }
  }

  // Extraction provider
  const currentProvider = process.env.KEYOKU_EXTRACTION_PROVIDER;
  if (currentProvider) {
    success(`Extraction provider: ${currentProvider} (${process.env.KEYOKU_EXTRACTION_MODEL || 'default model'})`);
    return;
  }

  // Auto-detect best available provider
  if (hasOpenAI || process.env.OPENAI_API_KEY) {
    log('Using OpenAI for memory extraction (detected OPENAI_API_KEY)');
    appendToEnvFile('KEYOKU_EXTRACTION_PROVIDER', 'openai');
    appendToEnvFile('KEYOKU_EXTRACTION_MODEL', 'gpt-4.1-mini');
  } else if (hasGemini) {
    log('Using Gemini for memory extraction (detected GEMINI_API_KEY)');
    appendToEnvFile('KEYOKU_EXTRACTION_PROVIDER', 'gemini');
    appendToEnvFile('KEYOKU_EXTRACTION_MODEL', 'gemini-3.1-flash-lite-preview');
  } else if (hasAnthropic) {
    log('Using Anthropic for memory extraction (detected ANTHROPIC_API_KEY)');
    appendToEnvFile('KEYOKU_EXTRACTION_PROVIDER', 'anthropic');
    appendToEnvFile('KEYOKU_EXTRACTION_MODEL', 'claude-haiku-4-5-20251001');
  } else {
    warn('No LLM API key detected. Memory extraction will not work.');
    warn('Set at least one: OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY');
  }
}

/**
 * Append a key=value to ~/.keyoku/.env (creates if needed).
 * This file is sourced by the service when starting keyoku-engine.
 */
function appendToEnvFile(key: string, value: string): void {
  const envDir = join(HOME, '.keyoku');
  const envPath = join(envDir, '.env');
  mkdirSync(envDir, { recursive: true });

  let content = '';
  if (existsSync(envPath)) {
    content = readFileSync(envPath, 'utf-8');
    // Replace existing key if present
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
      writeFileSync(envPath, content, 'utf-8');
      return;
    }
  }

  // Append new key
  const line = `${key}=${value}\n`;
  writeFileSync(envPath, content + line, 'utf-8');
}

/**
 * Detect the system timezone (IANA format).
 */
function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'America/Los_Angeles';
  }
}

/**
 * Set up autonomy level — controls how aggressively heartbeat acts on signals.
 */
async function setupAutonomy(config: OpenClawConfig): Promise<void> {
  console.log('');
  log('Autonomy Level');
  log('Controls how the agent acts on heartbeat signals (deadlines, reminders, etc.).');
  console.log('');
  log('  observe  — Note signals silently, only act when the user asks');
  log('  suggest  — Mention important signals naturally in conversation (recommended)');
  log('  act      — Proactively execute actions (create reminders, follow up, etc.)');
  console.log('');

  const answer = await promptLower('Autonomy level [observe/suggest/act] (default: suggest):');
  const level = ['observe', 'suggest', 'act'].includes(answer) ? answer : 'suggest';

  // Save to plugin config in openclaw.json
  const entry = config.plugins?.entries?.['keyoku-memory'];
  if (entry) {
    if (!entry.config) entry.config = {};
    entry.config.autonomy = level;
    writeOpenClawConfig(config);
  }

  success(`Autonomy set to: ${level}`);
}

/**
 * Set up timezone and quiet hours — controls when heartbeats are suppressed.
 */
async function setupTimezoneAndQuietHours(): Promise<void> {
  console.log('');
  log('Timezone & Quiet Hours');

  // Auto-detect timezone
  const detected = detectTimezone();
  const tzAnswer = await prompt(`Timezone? (detected: ${detected}, press Enter to accept):`);
  const timezone = tzAnswer || detected;

  appendToEnvFile('KEYOKU_QUIET_HOURS_TIMEZONE', timezone);
  success(`Timezone: ${timezone}`);

  // Quiet hours
  console.log('');
  log('Quiet hours suppress non-urgent heartbeat signals (e.g., 11pm–7am).');
  const enableQuiet = await promptLower('Enable quiet hours? (y/n, default: y):');

  if (enableQuiet === 'n') {
    appendToEnvFile('KEYOKU_QUIET_HOURS_ENABLED', 'false');
    log('Quiet hours disabled — heartbeats can fire anytime');
    return;
  }

  appendToEnvFile('KEYOKU_QUIET_HOURS_ENABLED', 'true');

  const startAnswer = await prompt('Quiet start hour (0-23, default: 23):');
  const endAnswer = await prompt('Quiet end hour (0-23, default: 7):');

  const start = startAnswer ? parseInt(startAnswer, 10) : 23;
  const end = endAnswer ? parseInt(endAnswer, 10) : 7;

  if (!isNaN(start) && start >= 0 && start <= 23) {
    appendToEnvFile('KEYOKU_QUIET_HOUR_START', String(start));
  }
  if (!isNaN(end) && end >= 0 && end <= 23) {
    appendToEnvFile('KEYOKU_QUIET_HOUR_END', String(end));
  }

  success(`Quiet hours: ${isNaN(start) ? 23 : start}:00 – ${isNaN(end) ? 7 : end}:00 (${timezone})`);
}

/**
 * Run a health check against keyoku-engine to verify the install works.
 */
async function healthCheck(): Promise<boolean> {
  const url = 'http://localhost:18900';
  log('Running health check...');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${url}/api/v1/health`, { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      success('Keyoku engine is healthy');
      return true;
    }
    warn(`Health check returned ${res.status}`);
    return false;
  } catch {
    // Engine isn't running yet — that's fine, it auto-starts with OpenClaw
    log('Keyoku engine not running (it will auto-start when OpenClaw loads the plugin)');
    return false;
  }
}

/**
 * Main init function — orchestrates the full setup.
 */
export async function init(): Promise<void> {
  console.log('\n  Keyoku OpenClaw Plugin — Setup\n');

  // Step 1: Detect OpenClaw
  const config = readOpenClawConfig();
  if (!config) {
    warn(`OpenClaw config not found at ${OPENCLAW_CONFIG_PATH}`);
    warn('Make sure OpenClaw is installed first: https://openclaw.dev');
    process.exit(1);
  }
  success('OpenClaw config detected');

  // Step 2: Check if already installed
  const entries = config.plugins?.entries ?? {};
  const alreadyRegistered = !!entries['keyoku-memory']?.enabled;

  if (alreadyRegistered) {
    success('Keyoku plugin already registered in OpenClaw config');
  } else {
    // Step 3: Ensure binary exists
    if (existsSync(KEYOKU_BIN_PATH)) {
      success(`Keyoku binary found at ${KEYOKU_BIN_PATH}`);
    } else {
      log('Keyoku binary not found — downloading...');
      const downloaded = await downloadBinary();
      if (!downloaded) {
        warn('Could not download binary. You can install it manually:');
        warn('  Visit: https://github.com/keyoku-ai/keyoku-engine/releases');
        warn(`  Place the binary at: ${KEYOKU_BIN_PATH}`);
        const proceed = await promptLower('Continue without binary? (y/n)');
        if (proceed !== 'y') {
          process.exit(1);
        }
      }
    }

    // Step 4: Register plugin in config
    if (!config.plugins) config.plugins = {};
    if (!config.plugins.entries) config.plugins.entries = {};
    if (!config.plugins.slots) config.plugins.slots = {};

    config.plugins.entries['keyoku-memory'] = {
      enabled: true,
      config: {
        keyokuUrl: 'http://localhost:18900',
        autoRecall: true,
        autoCapture: true,
        heartbeat: true,
        topK: 5,
      },
    };
    config.plugins.slots['memory'] = 'keyoku-memory';

    writeOpenClawConfig(config);
    success('Plugin registered in openclaw.json');
  }

  // Step 5: Ensure DB path is configured
  const dbPath = join(HOME, '.keyoku', 'data', 'keyoku.db');
  appendToEnvFile('KEYOKU_DB_PATH', dbPath);

  // Step 6: Set up LLM provider + API keys
  await setupLlmProvider();

  // Step 7: Autonomy level
  await setupAutonomy(config);

  // Step 8: Timezone & quiet hours
  await setupTimezoneAndQuietHours();

  // Step 9: Install SKILL.md guidebook
  console.log('');
  installSkill();

  // Step 10: Check for existing memories to migrate
  const memoryMdPath = join(HOME, '.openclaw', 'MEMORY.md');
  const hasMemoryMd = existsSync(memoryMdPath);
  const vectorDbs = discoverVectorDbs(OPENCLAW_MEMORY_DIR);
  const hasVectorStores = vectorDbs.length > 0;

  if (hasMemoryMd || hasVectorStores) {
    console.log('');
    log('Found existing OpenClaw memories:');
    if (hasMemoryMd) log(`  - MEMORY.md`);
    if (hasVectorStores) log(`  - ${vectorDbs.length} vector store(s) in ~/.openclaw/memory/`);

    const migrate = await promptLower('Migrate existing memories into Keyoku? (y/n)');

    if (migrate === 'y') {
      log('Starting migration...');

      const client = new KeyokuClient({
        baseUrl: 'http://localhost:18900',
        token: process.env.KEYOKU_SESSION_TOKEN,
        timeout: 60000,
      });
      const entityId = 'default';

      // Migrate markdown files
      if (hasMemoryMd) {
        try {
          const mdResult = await importMemoryFiles({
            client,
            entityId,
            workspaceDir: join(HOME, '.openclaw'),
            logger: console,
          });
          success(`Markdown: ${mdResult.imported} imported, ${mdResult.skipped} skipped`);
        } catch (err) {
          warn(`Markdown migration failed: ${String(err)}`);
          warn('Make sure Keyoku is running (it will auto-start when OpenClaw loads the plugin)');
        }
      }

      // Migrate vector stores
      if (hasVectorStores) {
        try {
          const vsResult = await migrateAllVectorStores({
            client,
            entityId,
            memoryDir: OPENCLAW_MEMORY_DIR,
            logger: console,
          });
          success(`Vector store: ${vsResult.imported} imported, ${vsResult.skipped} skipped`);
        } catch (err) {
          warn(`Vector store migration failed: ${String(err)}`);
        }
      }
    } else {
      log('Skipping migration. You can run it later with: openclaw memory migrate');
    }
  }

  // Step 11: Health check
  console.log('');
  await healthCheck();

  // Done — close readline before exiting
  closeTtyReadline();

  console.log('\n  Setup complete!\n');
  log('Restart OpenClaw to load the plugin:');
  log('  openclaw restart    (or close and reopen your editor)');
  console.log('');
  log('The plugin will auto-start Keyoku when OpenClaw loads.');
  log('Your agent now has persistent memory and heartbeat awareness.');
  log('Run `openclaw memory stats` to check your memory status.');
  log('Run `openclaw memory migrate` to migrate data later.\n');
}
