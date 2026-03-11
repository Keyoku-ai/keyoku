/**
 * Incremental per-message memory capture.
 *
 * Strategy: capture the user+assistant exchange as a PAIR, not separately.
 * This gives Keyoku the full context to extract meaningful memories:
 *   "User asked about X → Agent decided Y because Z"
 * instead of fragmented, context-free snippets.
 *
 * Flow:
 * 1. `before_prompt_build` — stash the user's prompt (no /remember call yet)
 * 2. `message_sent` — pair the stashed prompt with the assistant's response,
 *    send the combined exchange to Keyoku's /remember endpoint ONCE.
 *
 * Keyoku's engine then:
 * - Extracts discrete facts from the full exchange
 * - Deduplicates against existing memories (hash + semantic)
 * - Detects and resolves conflicts
 * - Stores only genuinely new information
 */

import type { KeyokuClient } from '@keyoku/memory';
import type { KeyokuConfig } from './config.js';
import { looksLikePromptInjection } from './capture.js';
import type { PluginApi } from './types.js';

export function registerIncrementalCapture(
  api: PluginApi,
  client: KeyokuClient,
  entityId: string,
  agentId: string,
  config: Required<KeyokuConfig>,
): void {
  // Stash for the most recent user prompt, paired with the next assistant response
  let pendingUserPrompt: string | null = null;

  // Step 1: Stash user prompt (no API call yet)
  api.on('before_prompt_build', async (event: unknown) => {
    const ev = event as { prompt?: string };
    if (!ev.prompt || ev.prompt.length < 10) return;

    // Don't stash heartbeat prompts or injected blocks
    if (ev.prompt.includes('HEARTBEAT')) return;
    if (ev.prompt.includes('<your-memories>') || ev.prompt.includes('<heartbeat-signals>')) return;
    if (ev.prompt.length > config.captureMaxChars) return;
    if (looksLikePromptInjection(ev.prompt)) return;

    pendingUserPrompt = ev.prompt;
  }, { priority: -10 }); // Low priority — runs after auto-recall

  // Step 2: Pair with assistant response and send to Keyoku
  api.on('message_sent', async (event: unknown) => {
    const ev = event as { content?: string; success?: boolean };
    if (!ev.success || !ev.content) return;

    const assistantContent = ev.content;

    // Skip noise
    if (assistantContent.length < 20) return;
    if (assistantContent === 'HEARTBEAT_OK' || assistantContent === 'NO_REPLY') return;
    if (assistantContent.includes('<heartbeat-signals>') || assistantContent.includes('<your-memories>')) return;
    if (looksLikePromptInjection(assistantContent)) return;

    // Build the exchange: user prompt + assistant response
    let exchange: string;
    if (pendingUserPrompt) {
      exchange = `User: ${pendingUserPrompt}\n\nAssistant: ${assistantContent}`;
      pendingUserPrompt = null; // consumed
    } else {
      // No user prompt stashed (e.g., tool-triggered response) — just capture assistant
      exchange = assistantContent;
    }

    // Truncate if the combined exchange is too long
    if (exchange.length > config.captureMaxChars) {
      exchange = exchange.slice(0, config.captureMaxChars);
    }

    try {
      await client.remember(entityId, exchange, {
        agent_id: agentId,
        source: 'conversation',
      });
      api.logger.debug?.(`keyoku: captured exchange (${exchange.length} chars)`);
    } catch (err) {
      api.logger.warn(`keyoku: capture failed: ${String(err)}`);
    }
  });
}
