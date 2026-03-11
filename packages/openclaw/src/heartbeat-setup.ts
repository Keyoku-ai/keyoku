/**
 * Auto-generates HEARTBEAT.md so that OpenClaw's heartbeat runner
 * actually fires the heartbeat (empty file = skip).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginApi } from './types.js';

const HEARTBEAT_FILENAME = 'HEARTBEAT.md';

const HEARTBEAT_TEMPLATE = `# Heartbeat Check

You have been checked in on. Your memory system has reviewed your recent activity and surfaced anything that needs your attention. The signals are injected into your context automatically — look for the <heartbeat-signals> block.

## How to respond

1. Read the signals carefully. Check urgency and mode.
2. If mode is \`act\` — take action immediately. Do what the signal says.
3. If mode is \`suggest\` and urgency is not \`none\` — surface the suggestion naturally. Keep it brief.
4. If mode is \`suggest\`, urgency is \`none\`, but there are suggested actions or a "Tell the User" section with real content — share it conversationally. One sentence is fine.
5. If there are truly no signals, no suggestions, and nothing to surface — reply HEARTBEAT_OK.

Do not repeat old tasks from prior conversations. Only act on what the signals say right now.
`;

/**
 * Write HEARTBEAT.md to the workspace if it doesn't exist or is effectively empty.
 */
export function ensureHeartbeatMd(api: PluginApi): void {
  try {
    const heartbeatPath = join(api.resolvePath('.'), HEARTBEAT_FILENAME);

    if (existsSync(heartbeatPath)) {
      // Check if file is effectively empty (only comments/whitespace)
      const content = readFileSync(heartbeatPath, 'utf-8');
      const hasContent = content
        .split('\n')
        .some((line: string) => {
          const trimmed = line.trim();
          return trimmed.length > 0 && !trimmed.startsWith('#');
        });
      if (hasContent) return; // File has real content, don't overwrite
    }

    writeFileSync(heartbeatPath, HEARTBEAT_TEMPLATE, 'utf-8');
    api.logger.info(`keyoku: created ${HEARTBEAT_FILENAME} for heartbeat support`);
  } catch (err) {
    api.logger.warn(`keyoku: could not create ${HEARTBEAT_FILENAME}: ${String(err)}`);
  }
}
