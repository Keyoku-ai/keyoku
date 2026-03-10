/**
 * OpenClaw lifecycle hook registrations.
 * - before_prompt_build: auto-recall + heartbeat context fusion
 * - agent_end: auto-capture memorable facts
 */

import type { KeyokuClient } from '@keyoku/memory';
import type { KeyokuConfig } from './config.js';
import { formatMemoryContext, formatHeartbeatContext } from './context.js';
import { extractCapturableTexts } from './capture.js';
import type { PluginApi } from './types.js';

/**
 * Extract a summary of recent activity from conversation messages.
 * Takes the last N user and assistant messages and builds a query string
 * that represents what the agent has been doing.
 */
function summarizeRecentActivity(messages: unknown[], maxMessages = 6): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const recent = messages.slice(-maxMessages);
  const parts: string[] = [];

  for (const msg of recent) {
    const m = msg as { role?: string; content?: string | Array<{ type?: string; text?: string }> };
    if (!m.role || !m.content) continue;

    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      // Anthropic format: content blocks
      text = m.content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join(' ');
    }

    if (!text) continue;

    // Truncate long messages to keep the query focused
    const truncated = text.length > 300 ? text.slice(0, 300) : text;

    if (m.role === 'user') {
      parts.push(`User: ${truncated}`);
    } else if (m.role === 'assistant') {
      parts.push(`Assistant: ${truncated}`);
    }
  }

  return parts.join('\n');
}

export function registerHooks(
  api: PluginApi,
  client: KeyokuClient,
  entityId: string,
  agentId: string,
  config: Required<KeyokuConfig>,
): void {
  // before_prompt_build: inject relevant memories + heartbeat data
  if (config.autoRecall || config.heartbeat) {
    api.on('before_prompt_build', async (event: unknown) => {
      const ev = event as { prompt?: string; messages?: unknown[] };
      if (!ev.prompt || ev.prompt.length < 5) return;

      const isHeartbeat = config.heartbeat && ev.prompt.includes('HEARTBEAT');

      if (isHeartbeat) {
        // Build a query from recent conversation activity, not the heartbeat prompt itself
        const activitySummary = summarizeRecentActivity(ev.messages ?? []);

        try {
          const ctx = await client.heartbeatContext(entityId, {
            // Use conversation activity as the search query, not "Read HEARTBEAT.md..."
            query: activitySummary || undefined,
            top_k: config.topK,
            min_score: 0.1,
            agent_id: agentId,
            max_results: 10,
            analyze: true,
            activity_summary: activitySummary || undefined,
            autonomy: config.autonomy,
          });
          const formatted = formatHeartbeatContext(ctx);
          if (formatted) {
            const analyzed = ctx.analysis ? ` [${ctx.analysis.autonomy}/${ctx.analysis.urgency}]` : '';
            api.logger.info?.(`keyoku: heartbeat context injected (should_act: ${ctx.should_act}, memories: ${ctx.relevant_memories.length}${analyzed})`);
            return { prependContext: formatted };
          }
        } catch (err) {
          api.logger.warn(`keyoku: heartbeat context failed: ${String(err)}`);
        }
      } else if (config.autoRecall) {
        // Normal prompt: search for relevant memories using the user's actual message
        try {
          const results = await client.search(entityId, ev.prompt, { limit: config.topK, min_score: 0.1 });
          if (results.length > 0) {
            const ctx = formatMemoryContext(results);
            if (ctx) {
              api.logger.info?.(`keyoku: injected ${results.length} memories into context`);
              return { prependContext: ctx };
            }
          }
        } catch (err) {
          api.logger.warn(`keyoku: recall failed: ${String(err)}`);
        }
      }
    });
  }

  // agent_end: auto-capture memorable facts from conversation
  if (config.autoCapture) {
    api.on('agent_end', async (event: unknown) => {
      const ev = event as { messages?: unknown[]; success?: boolean };
      if (!ev.success || !ev.messages || ev.messages.length === 0) return;

      try {
        const toCapture = extractCapturableTexts(ev.messages, config.captureMaxChars);
        if (toCapture.length === 0) return;

        let stored = 0;
        // Limit to 3 captures per conversation to avoid noise
        for (const text of toCapture.slice(0, 3)) {
          await client.remember(entityId, text, { agent_id: agentId, source: 'auto-capture' });
          stored++;
        }

        if (stored > 0) {
          api.logger.info(`keyoku: auto-captured ${stored} memories`);
        }
      } catch (err) {
        api.logger.warn(`keyoku: capture failed: ${String(err)}`);
      }
    });
  }
}
