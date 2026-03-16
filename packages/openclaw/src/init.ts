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

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  createWriteStream,
  cpSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { KeyokuClient } from '@keyoku/memory';
import { importMemoryFiles } from './migration.js';
import { migrateAllVectorStores, discoverVectorDbs } from './migrate-vector-store.js';
import {
  extractHeartbeatRules,
  migrateHeartbeatRules,
  type HeartbeatRule,
} from './heartbeat-migration.js';
import { findKeyokuBinary, loadKeyokuEnv, waitForHealthy } from './service.js';
import { updateEngine } from './update-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOME = process.env.HOME ?? '';
const OPENCLAW_CONFIG_PATH = join(HOME, '.openclaw', 'openclaw.json');
const KEYOKU_BIN_DIR = join(HOME, '.keyoku', 'bin');
const KEYOKU_BIN_PATH = join(KEYOKU_BIN_DIR, 'keyoku');
const OPENCLAW_MEMORY_DIR = join(HOME, '.openclaw', 'memory');
const OPENCLAW_EXTENSIONS_DIR = join(HOME, '.openclaw', 'extensions');
const PLUGIN_INSTALL_DIR = join(OPENCLAW_EXTENSIONS_DIR, 'keyoku-memory');
const KEYOKU_ENGINE_REPO = 'github.com/keyoku-ai/keyoku-engine';
const MIN_ENGINE_VERSION_BY_PROVIDER: Partial<Record<string, string>> = {
  ollama: '0.4.0',
};

interface AgentHeartbeatConfig {
  every?: string;
  target?: string;
  to?: string;
}

interface OpenClawConfig {
  plugins?: {
    entries?: Record<string, { enabled: boolean; config?: Record<string, unknown> }>;
    slots?: Record<string, string>;
  };
  agents?: {
    defaults?: {
      heartbeat?: AgentHeartbeatConfig;
    };
  };
  [key: string]: unknown;
}

// ── ANSI Colors ──────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  // Indigo/purple brand palette
  indigo: '\x1b[38;2;99;102;241m', // #6366f1
  purple: '\x1b[38;2;167;139;250m', // #a78bfa
  lilac: '\x1b[38;2;196;181;253m', // #c4b5fd
  green: '\x1b[38;2;34;197;94m', // #22c55e
  yellow: '\x1b[38;2;250;204;21m', // #facc15
  red: '\x1b[38;2;239;68;68m', // #ef4444
  gray: '\x1b[38;2;148;163;184m', // #94a3b8
  white: '\x1b[38;2;241;245;249m', // #f1f5f9
  cyan: '\x1b[38;2;34;211;238m', // #22d3ee
};

// ── Output Helpers ───────────────────────────────────────────────────────

let currentStep = 0;
const totalSteps = 12;

function stepHeader(label: string): void {
  currentStep++;
  console.log('');
  console.log(
    `  ${c.indigo}${c.bold}[${currentStep}/${totalSteps}]${c.reset} ${c.white}${c.bold}${label}${c.reset}`,
  );
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
    ttyRl.on('close', () => {
      // Prevent silent exit if stdin closes unexpectedly
      ttyRl = null;
    });
  }
  return new Promise((resolve) => {
    let resolved = false;
    const onClose = () => {
      if (!resolved) { resolved = true; resolve(''); }
    };
    ttyRl!.question(`  ${c.purple}?${c.reset} ${question} `, (answer) => {
      resolved = true;
      ttyRl?.removeListener('close', onClose);
      resolve(answer.trim());
    });
    // If readline closes before answering, resolve with empty string (use default)
    ttyRl!.once('close', onClose);
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

    const release = (await releaseRes.json()) as {
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

  // Install dependencies
  const nmDest = join(PLUGIN_INSTALL_DIR, 'node_modules');
  mkdirSync(nmDest, { recursive: true });

  // Copy own node_modules if present (local dev / workspace build)
  const nmSrc = join(packageRoot, 'node_modules');
  if (existsSync(nmSrc)) {
    cpSync(nmSrc, nmDest, { recursive: true });
  }

  // npx installs deps as siblings (flat node_modules), not nested.
  // e.g. node_modules/@keyoku/openclaw + node_modules/@keyoku/memory are siblings.
  // Also handles npm workspace hoisting where deps are in ../../node_modules.
  const siblingDeps = ['@keyoku/memory', '@keyoku/types', '@sinclair/typebox'];
  const searchPaths = [
    join(packageRoot, '..', '..'), // npx flat: node_modules/@keyoku/openclaw/../.. = node_modules/
    join(packageRoot, '..'), // fallback: unscoped package
    join(packageRoot, '..', '..', 'node_modules'), // workspace hoisted
  ];
  for (const dep of siblingDeps) {
    if (existsSync(join(nmDest, dep))) continue; // already copied
    for (const base of searchPaths) {
      const src = join(base, dep);
      if (existsSync(src)) {
        const dest = join(nmDest, dep);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest, { recursive: true });
        break;
      }
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
    skills: ['./skills'],
    configSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        keyokuUrl: { type: 'string' },
        sessionToken: { type: 'string', description: 'Keyoku server auth token (Bearer). Use when the server requires KEYOKU_SESSION_TOKEN.' },
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

// ── HEARTBEAT.md Migration ───────────────────────────────────────────────

/**
 * Extract user heartbeat rules from an existing HEARTBEAT.md for migration
 * into Keyoku. Does NOT write or maintain HEARTBEAT.md — keyoku-engine's
 * watcher owns the heartbeat loop now, so OpenClaw's heartbeat runner is unused.
 */
function extractExistingHeartbeatRules(): HeartbeatRule[] {
  const heartbeatPath = join(HOME, '.openclaw', 'workspace', 'HEARTBEAT.md');

  if (!existsSync(heartbeatPath)) {
    return [];
  }

  const existing = readFileSync(heartbeatPath, 'utf-8');
  const rules = extractHeartbeatRules(existing);
  if (rules.length > 0) {
    info(`Found ${rules.length} heartbeat rule(s) to migrate`);
  }
  return rules;
}

// ── LLM Provider Setup ──────────────────────────────────────────────────

/**
 * Set up LLM provider and API keys.
 *
 * Flow:
 *   5a. Embedding provider (Gemini, OpenAI, or Ollama — Anthropic has no embedding models)
 *   5b. Extraction provider (Gemini, OpenAI, Anthropic, or Ollama)
 *   5c. Extraction model (depends on provider, shows benchmark notes)
 *   5d. API key(s) / connection details for each unique provider selected
 */
async function setupLlmProvider(): Promise<{ embeddingProvider: string; extractionProvider: string }> {
  // Check existing env vars
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;

  // Show current config if already set (but still allow reconfiguration)
  const currentExtraction = process.env.KEYOKU_EXTRACTION_PROVIDER;
  const currentEmbedding = process.env.KEYOKU_EMBEDDING_PROVIDER;
  if (currentExtraction && currentEmbedding) {
    info(
      `Current: ${c.dim}${currentExtraction}/${process.env.KEYOKU_EXTRACTION_MODEL || 'default'} + ${currentEmbedding}/${process.env.KEYOKU_EMBEDDING_MODEL || 'default'}${c.reset}`,
    );
  }

  // Show detected API keys
  const detected: string[] = [];
  if (hasOpenAI) detected.push('OpenAI');
  if (hasGemini) detected.push('Gemini');
  if (hasAnthropic) detected.push('Anthropic');
  if (detected.length > 0) {
    success(`API keys detected: ${c.bold}${detected.join(', ')}${c.reset}`);
  }

  // ── 5a: Embedding provider ──────────────────────────────────────────
  console.log('');
  log('Embeddings convert text into vectors for semantic search.');
  log(`${c.yellow}Anthropic does not offer embedding models.${c.reset}`);

  const embeddingProvider = await choose('Embedding provider?', [
    { label: 'Gemini', value: 'gemini', desc: 'gemini-embedding-001' },
    { label: 'OpenAI', value: 'openai', desc: 'text-embedding-3-small' },
    { label: 'Ollama', value: 'ollama', desc: 'local inference, no API key required' },
  ]);

  if (embeddingProvider === 'gemini') {
    appendToEnvFile('KEYOKU_EMBEDDING_PROVIDER', 'gemini');
    appendToEnvFile('KEYOKU_EMBEDDING_MODEL', 'gemini-embedding-001');
  } else if (embeddingProvider === 'openai') {
    appendToEnvFile('KEYOKU_EMBEDDING_PROVIDER', 'openai');
    appendToEnvFile('KEYOKU_EMBEDDING_MODEL', 'text-embedding-3-small');
  } else {
    // Ollama — always prompt for embedding dims
    appendToEnvFile('KEYOKU_EMBEDDING_PROVIDER', 'ollama');
    const embeddingModel = await prompt('Ollama embedding model (default: nomic-embed-text):');
    appendToEnvFile('KEYOKU_EMBEDDING_MODEL', embeddingModel || 'nomic-embed-text');
    const embeddingDims = await choose('Embedding dimensions?', [
      { label: '768', value: '768', desc: 'nomic-embed-text, nomic-embed-text-v2-moe' },
      { label: '1024', value: '1024', desc: 'bge-large, qwen3-embedding:0.6b , mxbai-embed-large' },
      { label: '1536', value: '1536', desc: 'embedding models that matches OpenAI text-embedding-3-small output size' },
    ]);
    appendToEnvFile('OLLAMA_EMBEDDING_DIMS', embeddingDims);
    success(`Embedding dims → ${c.bold}${embeddingDims}${c.reset}`);
  }
  success(`Embedding → ${c.bold}${embeddingProvider}${c.reset}`);

  // ── 5b: Extraction provider ─────────────────────────────────────────
  const extractionProvider = await choose('Extraction provider?', [
    { label: 'Gemini (recommended)', value: 'gemini', desc: 'Best price-to-quality ratio' },
    { label: 'OpenAI', value: 'openai', desc: 'Reliable, widely supported' },
    {
      label: 'Anthropic',
      value: 'anthropic',
      desc: 'Highest quality, no embeddings (uses your embedding provider)',
    },
    { label: 'Ollama', value: 'ollama', desc: 'Local inference, no API key required' },
  ]);

  appendToEnvFile('KEYOKU_EXTRACTION_PROVIDER', extractionProvider);

  // ── 5c: Extraction model ────────────────────────────────────────────
  let extractionModel: string;

  if (extractionProvider === 'gemini') {
    extractionModel = await choose('Extraction model?', [
      {
        label: 'gemini-3.1-flash-lite-preview (recommended)',
        value: 'gemini-3.1-flash-lite-preview',
        desc: 'Cheapest and fastest, near-perfect quality',
      },
      {
        label: 'gemini-2.5-flash',
        value: 'gemini-2.5-flash',
        desc: 'Thinking model, highest accuracy, slower',
      },
    ]);
  } else if (extractionProvider === 'openai') {
    extractionModel = await choose('Extraction model?', [
      { label: 'gpt-4.1-mini', value: 'gpt-4.1-mini', desc: 'Balanced speed and quality' },
      {
        label: 'gpt-4.1-nano',
        value: 'gpt-4.1-nano',
        desc: 'Cheapest, slightly less reliable on complex schemas',
      },
    ]);
  } else if (extractionProvider === 'ollama') {
    const ollamaModel = await prompt('Ollama model (default: llama3.2):');
    extractionModel = ollamaModel || 'llama3.2';
  } else {
    // Anthropic — single model
    extractionModel = 'claude-haiku-4-5-20251001';
    info(
      `Extraction model: ${c.bold}claude-haiku-4-5-20251001${c.reset}  ${c.dim}Fast, top-tier quality${c.reset}`,
    );
  }

  appendToEnvFile('KEYOKU_EXTRACTION_MODEL', extractionModel);
  success(`Extraction → ${c.bold}${extractionProvider}/${extractionModel}${c.reset}`);
  log(`${c.dim}More models coming soon — re-run init to update.${c.reset}`);

  // ── 5d: API keys / connection details ───────────────────────────────
  const neededProviders = new Set([embeddingProvider, extractionProvider]);
  const ollamaConfigured = neededProviders.has('ollama');

  // Ollama — base URL (shared for both embedding and extraction if both use it)
  if (ollamaConfigured) {
    const ollamaUrl = await prompt('Ollama base URL (default: http://localhost:11434):');
    appendToEnvFile('OLLAMA_BASE_URL', ollamaUrl || 'http://localhost:11434');
    success(`Ollama URL → ${c.bold}${ollamaUrl || 'http://localhost:11434'}${c.reset}`);

    const ollamaKey = await prompt('Ollama API key (leave blank if not using auth middleware):');
    if (ollamaKey) {
      appendToEnvFile('OLLAMA_API_KEY', ollamaKey);
      success('Ollama API key saved');
    }
  }

  for (const provider of neededProviders) {
    if (provider === 'gemini' && !hasGemini) {
      const key = await prompt('Gemini API key:');
      if (key) {
        appendToEnvFile('GEMINI_API_KEY', key);
        success('Gemini API key saved');
      } else {
        warn('No key provided — set GEMINI_API_KEY manually');
      }
    } else if (provider === 'openai' && !hasOpenAI) {
      const key = await prompt('OpenAI API key (sk-...):');
      if (key && key.startsWith('sk-')) {
        appendToEnvFile('OPENAI_API_KEY', key);
        success('OpenAI API key saved');
      } else {
        warn('Invalid key — set OPENAI_API_KEY manually');
      }
    } else if (provider === 'anthropic' && !hasAnthropic) {
      const key = await prompt('Anthropic API key (sk-ant-...):');
      if (key && key.startsWith('sk-ant-')) {
        appendToEnvFile('ANTHROPIC_API_KEY', key);
        success('Anthropic API key saved');
      } else {
        warn('Invalid key — set ANTHROPIC_API_KEY manually');
      }
    }
  }

  // Isolate vector dimensions/index state per embedding backend.
  // This avoids dimension/index corruption when switching providers/models
  // (e.g. OpenAI 1536-dim → Ollama 768-dim) on the same DB file.
  configureProviderScopedDbPath(embeddingProvider, process.env.KEYOKU_EMBEDDING_MODEL || 'default');

  if (neededProviders.has('ollama')) {
    info('If startup reports "unknown provider: ollama", update engine binary:');
    log(`  ${c.bold}npx --yes --package @keyoku/openclaw@latest keyoku-update-engine${c.reset}`);
  }

  return { embeddingProvider, extractionProvider };
}

// ── Engine Compatibility ────────────────────────────────────────────────

function normalizeVersion(input: string): string | null {
  const match = input.match(/v?(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function compareVersions(a: string, b: string): number {
  const ap = a.split('.').map((x) => parseInt(x, 10));
  const bp = b.split('.').map((x) => parseInt(x, 10));
  const max = Math.max(ap.length, bp.length);
  for (let i = 0; i < max; i++) {
    const av = ap[i] ?? 0;
    const bv = bp[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function detectInstalledEngineVersion(binaryPath: string): string | null {
  const tryExtract = (text: string): string | null => {
    if (!text) return null;

    // Preferred: parse Go module metadata line if present.
    // Example: mod github.com/keyoku-ai/keyoku-engine v0.4.1-0.202603...
    const moduleLine = text
      .split('\n')
      .find((line) => line.includes(`mod\t${KEYOKU_ENGINE_REPO}`) || line.includes(`${KEYOKU_ENGINE_REPO}\tv`));
    if (moduleLine) {
      const moduleVersion = normalizeVersion(moduleLine);
      if (moduleVersion) return moduleVersion;
    }

    // Fallback: first semantic version token in output.
    const generic = text.match(/\bv?(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?\b/);
    return generic ? generic[1] : null;
  };

  // 1) Fast path for future binaries that support --version.
  try {
    const versionCmd = spawnSync(binaryPath, ['--version'], {
      encoding: 'utf-8',
      timeout: 1500,
    });
    const detected = tryExtract(`${versionCmd.stdout ?? ''}\n${versionCmd.stderr ?? ''}`);
    if (detected) return detected;
  } catch {
    // ignore and fall through
  }

  // 2) Prefer deterministic Go metadata if `go` is available.
  try {
    const goMeta = spawnSync('go', ['version', '-m', binaryPath], {
      encoding: 'utf-8',
      timeout: 2000,
    });
    if (goMeta.status === 0) {
      const detected = tryExtract(`${goMeta.stdout ?? ''}\n${goMeta.stderr ?? ''}`);
      if (detected) return detected;
    }
  } catch {
    // ignore and fall through
  }

  // 3) Last resort: scan binary strings for module version.
  try {
    const stringsOut = spawnSync('strings', [binaryPath], {
      encoding: 'utf-8',
      timeout: 2500,
      maxBuffer: 10 * 1024 * 1024,
    });
    const detected = tryExtract(`${stringsOut.stdout ?? ''}\n${stringsOut.stderr ?? ''}`);
    if (detected) return detected;
  } catch {
    // ignore
  }

  return null;
}

async function verifyEngineHealthAfterUpgrade(): Promise<boolean> {
  const cleanup = await startKeyokuForMigration();
  try {
    return await healthCheck();
  } finally {
    cleanup();
  }
}

async function ensureEngineCompatibility(providers: string[]): Promise<void> {
  const requiredVersion = providers
    .map((provider) => MIN_ENGINE_VERSION_BY_PROVIDER[provider])
    .filter((v): v is string => !!v)
    .sort(compareVersions)
    .at(-1);

  if (!requiredVersion) return;

  if (!existsSync(KEYOKU_BIN_PATH)) {
    warn(`Engine binary missing at ${KEYOKU_BIN_PATH}`);
    const installNow = await choose('Install latest engine now?', [
      { label: 'Yes', value: 'yes', desc: 'recommended' },
      { label: 'No', value: 'no', desc: 'exit setup and install manually' },
    ]);

    if (installNow !== 'yes') {
      fail(`Cannot continue: selected providers require engine >= v${requiredVersion}`);
      process.exit(1);
    }

    await updateEngine();
    const healthy = await verifyEngineHealthAfterUpgrade();
    if (!healthy) {
      fail('Engine installed, but health check failed after upgrade');
      fail('Please run `keyoku-update-engine` manually and retry init');
      process.exit(1);
    }
    return;
  }

  const installedVersion = detectInstalledEngineVersion(KEYOKU_BIN_PATH);
  if (installedVersion) {
    info(`Detected engine version ${c.bold}v${installedVersion}${c.reset}`);
  } else {
    warn('Could not detect installed engine version');
  }

  const isOutdated = !installedVersion || compareVersions(installedVersion, requiredVersion) < 0;
  if (!isOutdated) {
    success(`Engine compatibility OK (requires >= v${requiredVersion})`);
    return;
  }

  warn(`Selected providers require engine >= ${c.bold}v${requiredVersion}${c.reset}`);
  if (installedVersion) {
    warn(`Installed engine appears to be ${c.bold}v${installedVersion}${c.reset}`);
  }

  const updateNow = await choose('Run keyoku-update-engine now?', [
    { label: 'Yes', value: 'yes', desc: 'download latest and continue setup' },
    { label: 'No', value: 'no', desc: 'stop setup and update manually' },
  ]);

  if (updateNow !== 'yes') {
    fail('Setup blocked until engine is upgraded');
    log(`Run: ${c.bold}npx --yes --package @keyoku/openclaw@latest keyoku-update-engine${c.reset}`);
    process.exit(1);
  }

  await updateEngine();

  const upgradedVersion = detectInstalledEngineVersion(KEYOKU_BIN_PATH);
  if (upgradedVersion && compareVersions(upgradedVersion, requiredVersion) < 0) {
    fail(`Engine is still below required version after update (v${upgradedVersion} < v${requiredVersion})`);
    process.exit(1);
  }

  if (upgradedVersion) {
    success(`Engine upgraded to ${c.bold}v${upgradedVersion}${c.reset}`);
  }

  const healthy = await verifyEngineHealthAfterUpgrade();
  if (!healthy) {
    fail('Engine upgrade completed, but health check failed');
    fail('Please verify KEYOKU_* env config and rerun init');
    process.exit(1);
  }
}

// ── Environment File Management ──────────────────────────────────────────

function slugifyForPath(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function configureProviderScopedDbPath(embeddingProvider: string, embeddingModel: string): void {
  const dbDir = join(HOME, '.keyoku', 'data');
  mkdirSync(dbDir, { recursive: true });

  const providerSlug = slugifyForPath(embeddingProvider);
  const modelSlug = slugifyForPath(embeddingModel);
  const providerDbPath = join(dbDir, `keyoku-${providerSlug}-${modelSlug}.db`);

  appendToEnvFile('KEYOKU_DB_PATH', providerDbPath);
  success(`Database → ${c.dim}${providerDbPath}${c.reset}`);
  info(`${c.dim}Provider-scoped DB path set to avoid mixed-dimension vector indexes.${c.reset}`);
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
 * Common IANA timezones grouped by region.
 */
const COMMON_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'America/Sao_Paulo',
  'America/Mexico_City',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
];

/**
 * Set up autonomy level — controls how aggressively heartbeat acts on signals.
 */
async function setupAutonomy(config: OpenClawConfig): Promise<void> {
  const level = await choose(
    'Autonomy level?',
    [
      { label: 'observe', value: 'observe', desc: 'note signals silently, only act when asked' },
      { label: 'suggest', value: 'suggest', desc: 'mention important signals in conversation' },
      { label: 'act', value: 'act', desc: 'proactively execute actions (reminders, follow-ups)' },
    ],
    1,
  );

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
  // Auto-detect timezone and build selection list
  const detected = detectTimezone();

  // Build options: put detected first, then common ones (deduped)
  const tzOptions: Array<{ label: string; value: string; desc?: string }> = [];
  tzOptions.push({ label: detected, value: detected, desc: 'detected' });
  for (const tz of COMMON_TIMEZONES) {
    if (tz !== detected) {
      tzOptions.push({ label: tz, value: tz });
    }
  }

  // Show numbered list
  console.log('');
  for (let i = 0; i < tzOptions.length; i++) {
    const marker = i === 0 ? `${c.indigo}${c.bold}` : c.gray;
    const tag = i === 0 ? ` ${c.dim}(default)${c.reset}` : '';
    const desc = tzOptions[i].desc ? `  ${c.dim}${tzOptions[i].desc}${c.reset}` : '';
    console.log(`  ${marker}  ${i + 1}) ${tzOptions[i].label}${c.reset}${tag}${desc}`);
  }
  console.log('');

  const tzAnswer = await prompt(`Timezone? [1-${tzOptions.length}]:`);
  const tzIdx = parseInt(tzAnswer, 10) - 1;
  const timezone = tzIdx >= 0 && tzIdx < tzOptions.length ? tzOptions[tzIdx].value : detected;

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

  success(
    `Quiet hours → ${c.bold}${isNaN(start) ? 23 : start}:00 – ${isNaN(end) ? 7 : end}:00${c.reset} (${timezone})`,
  );
}

// ── Heartbeat ────────────────────────────────────────────────────────────

/**
 * Disable OpenClaw's built-in heartbeat runner.
 * Keyoku's watcher now owns the heartbeat loop and delivery.
 */
function disableOpenClawHeartbeat(config: OpenClawConfig): void {
  ensureAgentsDefaults(config);
  config.agents!.defaults!.heartbeat = {
    ...config.agents!.defaults!.heartbeat,
    target: 'none',
  };
  writeOpenClawConfig(config);
  success('OpenClaw heartbeat → disabled (keyoku watcher handles heartbeat)');
}

/**
 * Ensure agents.defaults exists in config.
 */
function ensureAgentsDefaults(config: OpenClawConfig): void {
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.heartbeat) config.agents.defaults.heartbeat = {};
}

// ── Start Keyoku for Migration ──────────────────────────────────────────

/**
 * Temporarily start the keyoku binary so migration can call the API.
 * Returns a cleanup function to kill the process afterward.
 */
async function startKeyokuForMigration(): Promise<() => void> {
  const { spawn } = await import('node:child_process');
  const { randomBytes } = await import('node:crypto');

  // Check if already running
  if (await waitForHealthy('http://localhost:18900', 2000, 500)) {
    info('Keyoku already running');
    return () => {}; // no-op cleanup
  }

  const binary = findKeyokuBinary();
  if (!binary) {
    warn('Keyoku binary not found — migration will be skipped');
    return () => {};
  }

  const keyokuEnv = loadKeyokuEnv();
  const env = { ...keyokuEnv, ...process.env };

  if (!env.KEYOKU_SESSION_TOKEN) {
    env.KEYOKU_SESSION_TOKEN = randomBytes(16).toString('hex');
  }
  process.env.KEYOKU_SESSION_TOKEN = env.KEYOKU_SESSION_TOKEN;

  if (!env.KEYOKU_DB_PATH) {
    const dbDir = join(HOME, '.keyoku', 'data');
    mkdirSync(dbDir, { recursive: true });
    env.KEYOKU_DB_PATH = join(dbDir, 'keyoku.db');
  }

  info('Starting keyoku for migration...');
  const proc = spawn(binary, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env,
  });

  // Suppress output during migration
  proc.stdout?.resume();
  proc.stderr?.resume();

  const healthy = await waitForHealthy('http://localhost:18900', 10000, 500);
  if (healthy) {
    info('Keyoku ready for migration');
  } else {
    warn('Keyoku health check timed out — migration may fail');
  }

  return () => {
    try {
      proc.kill('SIGTERM');
    } catch {
      // Process already exited
    }
  };
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
  console.log(
    `  ${c.gray}Memory engine for OpenClaw${c.reset}  ${c.dim}v${getVersion()}${c.reset}`,
  );
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
    // Always re-install files to pick up new versions (manifest, skills, dist)
    installPluginFiles();
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

  // Step 4: Storage directory
  stepHeader('Configure Storage');
  const dbDir = join(HOME, '.keyoku', 'data');
  mkdirSync(dbDir, { recursive: true });
  success(`Data directory → ${c.dim}${dbDir}${c.reset}`);

  // Step 5: LLM provider (+ provider-scoped DB path)
  stepHeader('LLM Provider');
  const { embeddingProvider, extractionProvider } = await setupLlmProvider();

  // Step 6: Engine compatibility check + auto-upgrade path
  stepHeader('Engine Compatibility');
  await ensureEngineCompatibility([embeddingProvider, extractionProvider]);

  // Step 7: Autonomy level
  stepHeader('Autonomy');
  await setupAutonomy(config);

  // Step 8: Timezone & quiet hours
  stepHeader('Timezone & Quiet Hours');
  await setupTimezoneAndQuietHours();

  // Step 9: Disable OpenClaw's heartbeat (keyoku's watcher handles it now)
  stepHeader('Heartbeat');
  disableOpenClawHeartbeat(config);

  // Step 10: SKILL.md
  stepHeader('Install Skill Guide');
  installSkill();

  // Step 10b: Extract existing heartbeat rules for migration (keyoku's watcher owns heartbeat now)
  const heartbeatRules = extractExistingHeartbeatRules();

  // Step 11: Migration
  const memoryMdPath = join(HOME, '.openclaw', 'MEMORY.md');
  const hasMemoryMd = existsSync(memoryMdPath);
  const vectorDbs = discoverVectorDbs(OPENCLAW_MEMORY_DIR);
  const hasVectorStores = vectorDbs.length > 0;
  const hasHeartbeatRules = heartbeatRules.length > 0;

  if (hasMemoryMd || hasVectorStores || hasHeartbeatRules) {
    stepHeader('Migrate Memories');

    if (hasMemoryMd) info('Found MEMORY.md');
    if (hasVectorStores) info(`Found ${vectorDbs.length} vector store(s)`);
    if (hasHeartbeatRules) info(`Found ${heartbeatRules.length} heartbeat rule(s)`);

    const migrate = await choose('Migrate existing memories into Keyoku?', [
      { label: 'Yes', value: 'yes', desc: 'import everything now' },
      { label: 'No', value: 'no', desc: 'skip for now' },
    ]);

    if (migrate === 'yes') {
      // Start keyoku temporarily for migration
      const cleanup = await startKeyokuForMigration();

      try {
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

        // Migrate heartbeat rules (preferences, rules, scheduled tasks)
        if (hasHeartbeatRules) {
          try {
            const hbResult = await migrateHeartbeatRules({
              client,
              entityId,
              agentId: 'default',
              rules: heartbeatRules,
              logger: console,
            });
            success(
              `Heartbeat: ${hbResult.preferences} preferences, ${hbResult.rules} rules, ${hbResult.schedules} schedules`,
            );
          } catch (err) {
            warn(`Heartbeat migration failed: ${String(err)}`);
          }
        }
      } finally {
        cleanup();
      }
    } else {
      log('Skipping — you can re-run init later to migrate');
    }
  } else {
    stepHeader('Migrate Memories');
    log('No existing memories found — nothing to migrate');
  }

  // Step 12: Health check
  stepHeader('Health Check');
  await healthCheck();

  // Close readline before exiting
  closeTtyReadline();

  // ── Done ─────────────────────────────────────────────────────────────
  const inContainer = existsSync('/.dockerenv') || existsSync('/run/.containerenv');

  console.log('');
  console.log(`  ${c.indigo}${'━'.repeat(52)}${c.reset}`);
  console.log('');
  console.log(`  ${c.green}${c.bold}  Setup complete!${c.reset}`);
  console.log('');
  console.log(`  ${c.white}Next steps:${c.reset}`);
  console.log(`  ${c.gray}1.${c.reset} Restart the gateway to load the plugin`);
  if (inContainer) {
    console.log(
      `     ${c.bold}docker compose restart${c.reset}  ${c.dim}(from the host)${c.reset}`,
    );
  } else {
    console.log(`     ${c.bold}openclaw gateway restart${c.reset}`);
  }
  console.log('');
  console.log(`  ${c.gray}2.${c.reset} Your agent now has persistent memory + heartbeat awareness`);
  console.log(`     ${c.dim}Keyoku handles memory storage, heartbeat, and delivery automatically.${c.reset}`);
  console.log(`     ${c.dim}Configure via KEYOKU_DELIVERY_* env vars or the watcher API.${c.reset}`);
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
