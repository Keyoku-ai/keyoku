/**
 * One-command installer for the Keyoku OpenClaw plugin.
 *
 * `npx @keyoku/openclaw init`
 *
 * 1. Detects OpenClaw config
 * 2. Downloads keyoku-engine binary if missing
 * 3. Registers plugin in openclaw.json (with full config defaults)
 * 4. Configures DB path (~/.keyoku/data/keyoku.db)
 * 5. Sets up LLM provider + API key (embeddings auto-match extraction provider)
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
import { execSync } from 'node:child_process';
import { KeyokuClient } from '@keyoku/memory';
import { importMemoryFiles } from './migration.js';
import { migrateAllVectorStores, discoverVectorDbs } from './migrate-vector-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOME = process.env.HOME ?? '';
const OPENCLAW_CONFIG_PATH = join(HOME, '.openclaw', 'openclaw.json');
const KEYOKU_BIN_DIR = join(HOME, '.keyoku', 'bin');
const KEYOKU_BIN_PATH = join(KEYOKU_BIN_DIR, 'keyoku');
const OPENCLAW_MEMORY_DIR = join(HOME, '.openclaw', 'memory');
const OPENCLAW_EXTENSIONS_DIR = join(HOME, '.openclaw', 'extensions');
const PLUGIN_INSTALL_DIR = join(OPENCLAW_EXTENSIONS_DIR, 'keyoku-memory');

interface OpenClawConfig {
  plugins?: {
    entries?: Record<string, { enabled: boolean; config?: Record<string, unknown> }>;
    slots?: Record<string, string>;
  };
  [key: string]: unknown;
}

// ── ANSI Colors ──────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  // Indigo/purple brand palette
  indigo: '\x1b[38;2;99;102;241m',    // #6366f1
  purple: '\x1b[38;2;167;139;250m',   // #a78bfa
  lilac: '\x1b[38;2;196;181;253m',    // #c4b5fd
  green: '\x1b[38;2;34;197;94m',      // #22c55e
  yellow: '\x1b[38;2;250;204;21m',    // #facc15
  red: '\x1b[38;2;239;68;68m',        // #ef4444
  gray: '\x1b[38;2;148;163;184m',     // #94a3b8
  white: '\x1b[38;2;241;245;249m',    // #f1f5f9
  cyan: '\x1b[38;2;34;211;238m',      // #22d3ee
};

// ── Output Helpers ───────────────────────────────────────────────────────

let currentStep = 0;
const totalSteps = 10;

function stepHeader(label: string): void {
  currentStep++;
  console.log('');
  console.log(`  ${c.indigo}${c.bold}[${currentStep}/${totalSteps}]${c.reset} ${c.white}${c.bold}${label}${c.reset}`);
  console.log(`  ${c.dim}${'─'.repeat(50)}${c.reset}`);
}

function log(msg: string): void {
  console.log(`  ${c.gray}${msg}${c.reset}`);
}

function success(msg: string): void {
  console.log(`  ${c.green}✔${c.reset} ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ${c.yellow}⚠${c.reset} ${msg}`);
}

function info(msg: string): void {
  console.log(`  ${c.indigo}▸${c.reset} ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ${c.red}✖${c.reset} ${msg}`);
}

// ── Stdin Buffering ──────────────────────────────────────────────────────

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
    process.stdout.write(`  ${c.purple}?${c.reset} ${question} `);
    const answer = stdinLines.shift() ?? '';
    console.log(answer);
    return answer.trim();
  }

  // TTY mode — interactive prompt
  if (!ttyRl) {
    ttyRl = createInterface({ input: process.stdin, output: process.stdout });
  }
  return new Promise((resolve) => {
    ttyRl!.question(`  ${c.purple}?${c.reset} ${question} `, (answer) => {
      resolve(answer.trim());
    });
  });
}

/** Prompt that lowercases the answer (for y/n and enum choices). */
async function promptLower(question: string): Promise<string> {
  return (await prompt(question)).toLowerCase();
}

/**
 * Show numbered choices and return the selected option.
 * Returns the value string (not the number).
 */
async function choose(
  question: string,
  options: Array<{ label: string; value: string; desc?: string }>,
  defaultIndex = 0,
): Promise<string> {
  console.log('');
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIndex ? `${c.indigo}${c.bold}` : c.gray;
    const tag = i === defaultIndex ? ` ${c.dim}(default)${c.reset}` : '';
    const desc = options[i].desc ? `  ${c.dim}${options[i].desc}${c.reset}` : '';
    console.log(`  ${marker}  ${i + 1}) ${options[i].label}${c.reset}${tag}${desc}`);
  }
  console.log('');

  const answer = await prompt(`${question} [${options.map((_, i) => i + 1).join('/')}]:`);
  const idx = parseInt(answer, 10) - 1;

  if (idx >= 0 && idx < options.length) {
    return options[idx].value;
  }
  return options[defaultIndex].value;
}

// ── Platform Detection ───────────────────────────────────────────────────

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

// ── Binary Download ──────────────────────────────────────────────────────

/**
 * Download the keyoku-engine binary from GitHub releases.
 */
async function downloadBinary(): Promise<boolean> {
  const { os, arch } = getPlatformInfo();
  const assetName = `keyoku-server-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;

  info(`Downloading keyoku-engine for ${c.bold}${os}/${arch}${c.reset}...`);

  try {
    // Get latest release info from GitHub API
    const releaseRes = await fetch(
      'https://api.github.com/repos/keyoku-ai/keyoku-engine/releases/latest',
      { headers: { Accept: 'application/vnd.github.v3+json' } },
    );

    if (!releaseRes.ok) {
      fail(`Could not fetch latest release: ${releaseRes.status} ${releaseRes.statusText}`);
      return false;
    }

    const release = await releaseRes.json() as {
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    };

    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) {
      fail(`No binary found for ${os}/${arch} in release ${release.tag_name}`);
      log(`Available: ${release.assets.map((a) => a.name).join(', ')}`);
      return false;
    }

    info(`Fetching ${c.bold}${asset.name}${c.reset} from ${c.dim}${release.tag_name}${c.reset}...`);

    // Download the binary
    const downloadRes = await fetch(asset.browser_download_url);
    if (!downloadRes.ok || !downloadRes.body) {
      fail(`Download failed: ${downloadRes.status}`);
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

    success(`Binary installed → ${c.dim}${destPath}${c.reset}`);
    return true;
  } catch (err) {
    fail(`Failed to download binary: ${String(err)}`);
    return false;
  }
}

// ── Config Management ────────────────────────────────────────────────────

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

// ── Plugin Installation ──────────────────────────────────────────────────

/**
 * Install the @keyoku/openclaw plugin to ~/.openclaw/extensions/keyoku-memory/
 * so OpenClaw can discover it on restart. When running via npx, the package
 * lives in a temp cache that disappears — this copies it to a permanent location.
 */
function installPluginFiles(): void {
  const packageRoot = join(__dirname, '..');

  // Copy the entire package to the extensions directory
  mkdirSync(PLUGIN_INSTALL_DIR, { recursive: true });

  // Copy dist/
  const distSrc = join(packageRoot, 'dist');
  const distDest = join(PLUGIN_INSTALL_DIR, 'dist');
  if (existsSync(distSrc)) {
    cpSync(distSrc, distDest, { recursive: true });
  }

  // Copy skills/
  const skillsSrc = join(packageRoot, 'skills');
  const skillsDest = join(PLUGIN_INSTALL_DIR, 'skills');
  if (existsSync(skillsSrc)) {
    cpSync(skillsSrc, skillsDest, { recursive: true });
  }

  // Copy package.json
  const pkgSrc = join(packageRoot, 'package.json');
  if (existsSync(pkgSrc)) {
    cpSync(pkgSrc, join(PLUGIN_INSTALL_DIR, 'package.json'));
  }

  // Install dependencies: copy node_modules from the npx cache
  const nmSrc = join(packageRoot, 'node_modules');
  const nmDest = join(PLUGIN_INSTALL_DIR, 'node_modules');
  if (existsSync(nmSrc)) {
    cpSync(nmSrc, nmDest, { recursive: true });
  }
  // Also check parent node_modules (hoisted deps in npm workspaces)
  const parentNm = join(packageRoot, '..', '..', 'node_modules');
  if (existsSync(parentNm)) {
    const sinclairSrc = join(parentNm, '@sinclair');
    if (existsSync(sinclairSrc) && !existsSync(join(nmDest, '@sinclair'))) {
      mkdirSync(nmDest, { recursive: true });
      cpSync(sinclairSrc, join(nmDest, '@sinclair'), { recursive: true });
    }
  }

  // Create entry point that calls the factory function.
  // OpenClaw expects a plain object export with { kind, register }, not a factory function.
  const entryPoint = `import keyokuMemory from './dist/index.js';\nconst plugin = keyokuMemory();\nexport default plugin;\n`;
  writeFileSync(join(PLUGIN_INSTALL_DIR, 'index.js'), entryPoint, 'utf-8');

  // Update package.json: set name to match plugin ID and point to wrapper entry
  const pkgPath = join(PLUGIN_INSTALL_DIR, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.name = 'keyoku-memory';
    pkg.openclaw = { extensions: ['index.js'] };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  }

  // Create openclaw.plugin.json manifest (required by OpenClaw for discovery)
  const manifest = {
    id: 'keyoku-memory',
    kind: 'memory',
    configSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        keyokuUrl: { type: 'string' },
        autoCapture: { type: 'boolean' },
        autoRecall: { type: 'boolean' },
        heartbeat: { type: 'boolean' },
        topK: { type: 'number', minimum: 1, maximum: 20 },
        autonomy: { type: 'string', enum: ['observe', 'suggest', 'act'] },
      },
    },
  };
  writeFileSync(
    join(PLUGIN_INSTALL_DIR, 'openclaw.plugin.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );
}

// ── Skill Installation ───────────────────────────────────────────────────

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
    success('SKILL.md already installed');
    return;
  }

  if (!existsSync(bundledSkillPath)) {
    warn('Bundled SKILL.md not found — skill will load from plugin package instead');
    return;
  }

  mkdirSync(workspaceSkillDir, { recursive: true });
  cpSync(bundledSkillPath, join(workspaceSkillDir, 'SKILL.md'));
  success(`SKILL.md installed → ${c.dim}~/.openclaw/skills/keyoku-memory/${c.reset}`);
}

// ── LLM Provider Setup ──────────────────────────────────────────────────

/**
 * Set up LLM provider and API keys.
 * Embeddings auto-match the extraction provider (no separate key needed for Gemini).
 */
async function setupLlmProvider(): Promise<void> {
  // Check existing env vars
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;

  // Extraction provider
  const currentProvider = process.env.KEYOKU_EXTRACTION_PROVIDER;
  if (currentProvider) {
    success(`Extraction: ${c.bold}${currentProvider}${c.reset} (${process.env.KEYOKU_EXTRACTION_MODEL || 'default model'})`);
  } else {
    // Auto-detect best available provider
    if (hasGemini) {
      appendToEnvFile('KEYOKU_EXTRACTION_PROVIDER', 'gemini');
      appendToEnvFile('KEYOKU_EXTRACTION_MODEL', 'gemini-2.5-flash');
      appendToEnvFile('KEYOKU_EMBEDDING_PROVIDER', 'gemini');
      appendToEnvFile('KEYOKU_EMBEDDING_MODEL', 'gemini-embedding-001');
      success(`Auto-configured: ${c.bold}Gemini${c.reset} for extraction + embeddings`);
    } else if (hasOpenAI) {
      appendToEnvFile('KEYOKU_EXTRACTION_PROVIDER', 'openai');
      appendToEnvFile('KEYOKU_EXTRACTION_MODEL', 'gpt-5-mini');
      appendToEnvFile('KEYOKU_EMBEDDING_PROVIDER', 'openai');
      appendToEnvFile('KEYOKU_EMBEDDING_MODEL', 'text-embedding-3-small');
      success(`Auto-configured: ${c.bold}OpenAI${c.reset} for extraction + embeddings`);
    } else {
      // No API key detected — prompt for provider
      const provider = await choose('Which LLM provider?', [
        { label: 'OpenAI', value: 'openai', desc: 'extraction + embeddings' },
        { label: 'Gemini', value: 'gemini', desc: 'extraction + embeddings' },
      ]);

      if (provider === 'gemini') {
        const key = await prompt('Gemini API key:');
        if (key) {
          appendToEnvFile('GEMINI_API_KEY', key);
          appendToEnvFile('KEYOKU_EXTRACTION_PROVIDER', 'gemini');
          appendToEnvFile('KEYOKU_EXTRACTION_MODEL', 'gemini-2.5-flash');
          appendToEnvFile('KEYOKU_EMBEDDING_PROVIDER', 'gemini');
          appendToEnvFile('KEYOKU_EMBEDDING_MODEL', 'gemini-embedding-001');
          success('Gemini configured');
        } else {
          warn('No key provided — set GEMINI_API_KEY manually');
        }
      } else {
        // Default: OpenAI
        const key = await prompt('OpenAI API key (sk-...):');
        if (key && key.startsWith('sk-')) {
          appendToEnvFile('OPENAI_API_KEY', key);
          appendToEnvFile('KEYOKU_EXTRACTION_PROVIDER', 'openai');
          appendToEnvFile('KEYOKU_EXTRACTION_MODEL', 'gpt-5-mini');
          appendToEnvFile('KEYOKU_EMBEDDING_PROVIDER', 'openai');
          appendToEnvFile('KEYOKU_EMBEDDING_MODEL', 'text-embedding-3-small');
          success('OpenAI configured');
        } else {
          warn('Invalid key — set OPENAI_API_KEY manually');
        }
      }
    }
  }

  // Show detected API keys
  const detected: string[] = [];
  if (hasOpenAI) detected.push('OpenAI');
  if (hasGemini) detected.push('Gemini');
  if (detected.length > 0) {
    success(`API keys detected: ${c.bold}${detected.join(', ')}${c.reset}`);
  }
}

// ── Environment File Management ──────────────────────────────────────────

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

// ── System Configuration ─────────────────────────────────────────────────

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
 * Validate an IANA timezone string.
 */
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Set up autonomy level — controls how aggressively heartbeat acts on signals.
 */
async function setupAutonomy(config: OpenClawConfig): Promise<void> {
  const level = await choose('Autonomy level?', [
    { label: 'observe', value: 'observe', desc: 'note signals silently, only act when asked' },
    { label: 'suggest', value: 'suggest', desc: 'mention important signals in conversation' },
    { label: 'act', value: 'act', desc: 'proactively execute actions (reminders, follow-ups)' },
  ], 1);

  // Save to plugin config in openclaw.json
  const entry = config.plugins?.entries?.['keyoku-memory'];
  if (entry) {
    if (!entry.config) entry.config = {};
    entry.config.autonomy = level;
    writeOpenClawConfig(config);
  }

  success(`Autonomy → ${c.bold}${level}${c.reset}`);
}

/**
 * Set up timezone and quiet hours — controls when heartbeats are suppressed.
 */
async function setupTimezoneAndQuietHours(): Promise<void> {
  // Auto-detect timezone
  const detected = detectTimezone();
  let timezone = detected;

  const tzAnswer = await prompt(`Timezone? (detected: ${c.bold}${detected}${c.reset}, Enter to accept):`);
  if (tzAnswer) {
    if (isValidTimezone(tzAnswer)) {
      timezone = tzAnswer;
    } else {
      warn(`Invalid timezone "${tzAnswer}" — using detected: ${detected}`);
    }
  }

  appendToEnvFile('KEYOKU_QUIET_HOURS_TIMEZONE', timezone);
  success(`Timezone → ${c.bold}${timezone}${c.reset}`);

  // Quiet hours
  console.log('');
  log('Quiet hours suppress non-urgent heartbeat signals (e.g., 11pm–7am).');

  const enableQuiet = await choose('Enable quiet hours?', [
    { label: 'Yes', value: 'yes', desc: '11pm–7am by default' },
    { label: 'No', value: 'no', desc: 'heartbeats can fire anytime' },
  ]);

  if (enableQuiet === 'no') {
    appendToEnvFile('KEYOKU_QUIET_HOURS_ENABLED', 'false');
    success('Quiet hours → disabled');
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

  success(`Quiet hours → ${c.bold}${isNaN(start) ? 23 : start}:00 – ${isNaN(end) ? 7 : end}:00${c.reset} (${timezone})`);
}

// ── Health Check ─────────────────────────────────────────────────────────

/**
 * Run a health check against keyoku-engine to verify the install works.
 */
async function healthCheck(): Promise<boolean> {
  const url = 'http://localhost:18900';
  info('Running health check...');

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
    log('Engine not running yet — it will auto-start when OpenClaw loads the plugin');
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

/**
 * Main init function — orchestrates the full setup.
 */
export async function init(): Promise<void> {
  console.log('');
  console.log(`  ${c.indigo}${c.bold}  █  █  █▀▀  █   █  █▀▀█  █  █  █  █${c.reset}`);
  console.log(`  ${c.indigo}${c.bold}  █▄▀   █▀▀   █ █   █  █  █▀▄   █  █${c.reset}`);
  console.log(`  ${c.indigo}${c.bold}  █  █  █▄▄    █    █▄▄█  █  █  █▄▄█${c.reset}`);
  console.log('');
  console.log(`  ${c.gray}Memory engine for OpenClaw${c.reset}  ${c.dim}v${getVersion()}${c.reset}`);
  console.log(`  ${c.indigo}${'━'.repeat(52)}${c.reset}`);

  // Step 1: Detect OpenClaw
  stepHeader('Detect OpenClaw');
  const config = readOpenClawConfig();
  if (!config) {
    fail(`Config not found at ${OPENCLAW_CONFIG_PATH}`);
    fail('Make sure OpenClaw is installed first: https://openclaw.dev');
    process.exit(1);
  }
  success('OpenClaw config detected');

  // Step 2: Check if already installed
  const entries = config.plugins?.entries ?? {};
  const alreadyRegistered = !!entries['keyoku-memory']?.enabled;

  if (alreadyRegistered) {
    stepHeader('Plugin Registration');
    success('Keyoku plugin already registered');
  } else {
    // Step 2: Binary
    stepHeader('Install Engine Binary');
    if (existsSync(KEYOKU_BIN_PATH)) {
      success(`Binary found → ${c.dim}${KEYOKU_BIN_PATH}${c.reset}`);
    } else {
      info('Binary not found — downloading...');
      const downloaded = await downloadBinary();
      if (!downloaded) {
        warn('Could not download binary. Install manually:');
        log(`  https://github.com/keyoku-ai/keyoku-engine/releases`);
        log(`  Place binary at: ${KEYOKU_BIN_PATH}`);
        const proceed = await promptLower('Continue without binary? (y/n)');
        if (proceed !== 'y') {
          process.exit(1);
        }
      }
    }

    // Step 3: Register plugin
    stepHeader('Register Plugin');
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

    // Install plugin files to extensions directory so OpenClaw can discover them
    info('Installing plugin to extensions...');
    installPluginFiles();
    success(`Plugin installed → ${c.dim}${PLUGIN_INSTALL_DIR}${c.reset}`);
  }

  // Step 4: DB path
  stepHeader('Configure Storage');
  const dbPath = join(HOME, '.keyoku', 'data', 'keyoku.db');
  appendToEnvFile('KEYOKU_DB_PATH', dbPath);
  success(`Database → ${c.dim}${dbPath}${c.reset}`);

  // Step 5: LLM provider
  stepHeader('LLM Provider');
  await setupLlmProvider();

  // Step 6: Autonomy level
  stepHeader('Autonomy');
  await setupAutonomy(config);

  // Step 7: Timezone & quiet hours
  stepHeader('Timezone & Quiet Hours');
  await setupTimezoneAndQuietHours();

  // Step 8: SKILL.md
  stepHeader('Install Skill Guide');
  installSkill();

  // Step 9: Migration
  const memoryMdPath = join(HOME, '.openclaw', 'MEMORY.md');
  const hasMemoryMd = existsSync(memoryMdPath);
  const vectorDbs = discoverVectorDbs(OPENCLAW_MEMORY_DIR);
  const hasVectorStores = vectorDbs.length > 0;

  if (hasMemoryMd || hasVectorStores) {
    stepHeader('Migrate Memories');

    if (hasMemoryMd) info('Found MEMORY.md');
    if (hasVectorStores) info(`Found ${vectorDbs.length} vector store(s)`);

    const migrate = await choose('Migrate existing memories into Keyoku?', [
      { label: 'Yes', value: 'yes', desc: 'import everything now' },
      { label: 'No', value: 'no', desc: 'skip for now' },
    ]);

    if (migrate === 'yes') {
      info('Starting migration...');

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
          log('Make sure Keyoku is running (it auto-starts when OpenClaw loads the plugin)');
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
          success(`Vector stores: ${vsResult.imported} imported, ${vsResult.skipped} skipped`);
        } catch (err) {
          warn(`Vector store migration failed: ${String(err)}`);
        }
      }
    } else {
      log('Skipping — you can re-run init later to migrate');
    }
  } else {
    stepHeader('Migrate Memories');
    log('No existing memories found — nothing to migrate');
  }

  // Step 10: Health check
  stepHeader('Health Check');
  await healthCheck();

  // ── Restart Gateway ───────────────────────────────────────────────────
  stepHeader('Restart Gateway');
  const restartAnswer = await promptLower('Restart OpenClaw gateway now to load the plugin? (Y/n):');
  const shouldRestart = restartAnswer !== 'n';

  if (shouldRestart) {
    try {
      info('Restarting gateway...');
      execSync('openclaw gateway restart', { stdio: 'inherit', timeout: 130_000 });
      success('Gateway restarted — Keyoku plugin is now active');
    } catch {
      warn('Could not restart gateway automatically');
      log(`Run manually: ${c.bold}openclaw gateway restart${c.reset}`);
    }
  } else {
    log(`Run later: ${c.bold}openclaw gateway restart${c.reset}`);
  }

  // Close readline before exiting
  closeTtyReadline();

  // ── Done ─────────────────────────────────────────────────────────────
  console.log('');
  console.log(`  ${c.indigo}${'━'.repeat(52)}${c.reset}`);
  console.log('');
  console.log(`  ${c.green}${c.bold}  Setup complete!${c.reset}`);
  console.log('');
  console.log(`  ${c.white}Next steps:${c.reset}`);
  if (!shouldRestart) {
    console.log(`  ${c.gray}1.${c.reset} Restart the gateway to load the plugin`);
    console.log(`     ${c.bold}openclaw gateway restart${c.reset}`);
    console.log('');
  }
  console.log(`  ${c.gray}${shouldRestart ? '1' : '2'}.${c.reset} Your agent now has persistent memory + heartbeat awareness`);
  console.log(`     ${c.dim}openclaw memory status${c.reset}    ${c.dim}check memory index status${c.reset}`);
  console.log(`     ${c.dim}openclaw memory search${c.reset}    ${c.dim}search stored memories${c.reset}`);
  console.log('');
  console.log(`  ${c.indigo}${'━'.repeat(52)}${c.reset}`);
  console.log('');
}

// ── Helpers ──────────────────────────────────────────────────────────────

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version ?? 'dev';
  } catch {
    return 'dev';
  }
}
