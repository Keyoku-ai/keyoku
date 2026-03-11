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
import { ensureHeartbeatMd } from './heartbeat-setup.js';
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

      // Resolve entity/agent IDs — fall back to plugin API id
      const entityId = cfg.entityId || api.id || 'default';
      const agentId = cfg.agentId || api.id || 'default';

      const client = new KeyokuClient({ baseUrl: cfg.keyokuUrl });

      api.logger.info(`keyoku: plugin registered (url: ${cfg.keyokuUrl}, entity: ${entityId})`);

      // Register 6 memory/schedule tools
      registerTools(api, client, entityId, agentId);

      // Register lifecycle hooks (auto-recall, heartbeat, auto-capture)
      registerHooks(api, client, entityId, agentId, cfg);

      // Register Keyoku binary lifecycle service
      registerService(api, cfg.keyokuUrl);

      // Register CLI subcommands
      registerCli(api, client, entityId);

      // Register incremental per-message capture
      if (cfg.incrementalCapture) {
        registerIncrementalCapture(api, client, entityId, agentId, cfg);
      }

      // Auto-generate HEARTBEAT.md if heartbeat is enabled and file doesn't exist
      if (cfg.heartbeat) {
        ensureHeartbeatMd(api);
      }
    },
  };
}
