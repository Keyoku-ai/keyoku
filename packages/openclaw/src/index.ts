/**
 * @keyoku/openclaw — Keyoku Memory Plugin for OpenClaw
 *
 * Gives any OpenClaw agent persistent memory, proactive heartbeat behavior,
 * and scheduling — powered by the Keyoku memory engine.
 *
 * Usage:
 *   import keyokuMemory from '@keyoku/openclaw';
 *   // In openclaw config:
 *   plugins: { 'keyoku-memory': keyokuMemory({ autoRecall: true }) }
 *   slots: { memory: 'keyoku-memory' }
 */

import { KeyokuClient } from '@keyoku/memory';
import { type KeyokuConfig, resolveConfig } from './config.js';
import { registerTools } from './tools.js';
import { registerHooks } from './hooks.js';
import { registerService } from './service.js';
import { registerCli } from './cli.js';
import { registerIncrementalCapture } from './incremental-capture.js';
import { createEntityResolver } from './entity-resolver.js';
import type { PluginApi } from './types.js';

export type { KeyokuConfig } from './config.js';
export { KeyokuClient } from '@keyoku/memory';

type KeyokuMemoryPlugin = ReturnType<typeof createKeyokuMemoryPlugin>;

function registerKeyokuMemory(api: PluginApi, config?: KeyokuConfig): void {
  const cfg = resolveConfig(config ?? (api.pluginConfig as KeyokuConfig | undefined));

  // Resolve entity/agent IDs
  // entityId = base memory namespace; resolver can derive dynamic child scopes per event
  // agentId = attribution marker for writes
  const entityId = cfg.entityId || 'default';
  const agentId = cfg.agentId || 'default';
  const resolver = createEntityResolver(entityId, cfg, api.logger);

  // Token resolved lazily — the service generates it at startup, after register()
  // 60s timeout: remember calls LLM extraction, heartbeatContext does analysis
  const client = new KeyokuClient({
    baseUrl: cfg.keyokuUrl,
    token: () => process.env.KEYOKU_SESSION_TOKEN,
    timeout: 60000,
  });

  // When keyoku heartbeat is enabled, disable OpenClaw's built-in heartbeat runner.
  // The keyoku engine watcher handles heartbeat cycles with smart adaptive intervals;
  // OpenClaw's runner would fire redundantly every 30m, wasting LLM tokens.
  // Uses target: "none" — the canonical disable mechanism used by disableOpenClawHeartbeat() in init.
  if (cfg.heartbeat && api.config) {
    const ocConfig = api.config as Record<string, unknown>;
    const agents = (ocConfig.agents ?? {}) as Record<string, unknown>;
    const defaults = (agents.defaults ?? {}) as Record<string, unknown>;
    const heartbeat = (defaults.heartbeat ?? {}) as Record<string, unknown>;
    heartbeat.target = 'none';
    defaults.heartbeat = heartbeat;
    agents.defaults = defaults;
    ocConfig.agents = agents;
    api.logger.debug?.(
      'keyoku: disabled OpenClaw heartbeat runner (keyoku engine watcher handles heartbeats)',
    );
  }

  api.logger.debug?.(
    `keyoku: plugin registered (url: ${cfg.keyokuUrl}, entityBase: ${entityId}, strategy: ${cfg.entityStrategy})`,
  );
  api.logger.debug?.(
    `keyoku: capture diagnostics (plugin=keyoku-memory incrementalCapture=${cfg.incrementalCapture} url=${cfg.keyokuUrl} entityBase=${entityId} strategy=${cfg.entityStrategy})`,
  );

  // Register 6 memory/schedule tools
  registerTools(api, client, resolver, agentId);

  // Register lifecycle hooks (auto-recall, heartbeat, auto-capture)
  registerHooks(api, client, resolver, agentId, cfg);

  // Register Keyoku binary lifecycle service
  registerService(api, cfg.keyokuUrl);

  // Register CLI subcommands
  registerCli(api, client, entityId);

  // Register incremental per-message capture
  if (cfg.incrementalCapture) {
    registerIncrementalCapture(api, client, resolver, agentId, cfg);
  }
}

function createKeyokuMemoryPlugin(config?: KeyokuConfig) {
  return {
    id: 'keyoku-memory',
    name: 'Keyoku Memory',
    description: 'Persistent memory, heartbeat enhancement, and scheduling powered by Keyoku',
    kind: 'memory' as const,

    register(api: PluginApi) {
      registerKeyokuMemory(api, config);
    },
  };
}

function isPluginApi(value: KeyokuConfig | PluginApi | undefined): value is PluginApi {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PluginApi>;
  return (
    typeof candidate.registerTool === 'function' &&
    typeof candidate.registerCli === 'function' &&
    typeof candidate.registerService === 'function' &&
    typeof candidate.resolvePath === 'function' &&
    typeof candidate.on === 'function'
  );
}

export { createKeyokuMemoryPlugin };

export default function keyokuMemory(configOrApi?: KeyokuConfig | PluginApi): KeyokuMemoryPlugin | void {
  if (isPluginApi(configOrApi)) {
    registerKeyokuMemory(configOrApi);
    return;
  }
  return createKeyokuMemoryPlugin(configOrApi);
}
