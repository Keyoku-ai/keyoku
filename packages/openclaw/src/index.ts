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

export default function keyokuMemory(config?: KeyokuConfig) {
  return {
    id: 'keyoku-memory',
    name: 'Keyoku Memory',
    description: 'Persistent memory, heartbeat enhancement, and scheduling powered by Keyoku',
    kind: 'memory' as const,

    register(api: PluginApi) {
      const cfg = resolveConfig(config);

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

      api.logger.debug?.(
        `keyoku: plugin registered (url: ${cfg.keyokuUrl}, entityBase: ${entityId}, strategy: ${cfg.entityStrategy})`,
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

    },
  };
}
