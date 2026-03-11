/**
 * OpenClaw lifecycle hook registrations.
 * - before_prompt_build: auto-recall + heartbeat context fusion
 * - agent_end: auto-capture memorable facts
 */

import type { KeyokuClient } from '@keyoku/memory';
import type { KeyokuConfig } from './config.js';
import { formatMemoryContext, formatHeartbeatContext } from './context.js';
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
  // before_prompt_build: auto-recall + heartbeat context injection
  if (config.autoRecall || config.heartbeat) {
    api.on('before_prompt_build', async (event: unknown) => {
      const ev = event as { prompt?: string; messages?: unknown[] };
      if (!ev.prompt || ev.prompt.length < 5) return;

      const isHeartbeat = ev.prompt.includes('HEARTBEAT');

      // Heartbeat path: use heartbeat context endpoint with LLM analysis
      if (isHeartbeat && config.heartbeat) {
        const activitySummary = summarizeRecentActivity(ev.messages ?? []);

        try {
          const ctx = await client.heartbeatContext(entityId, {
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
        return;
      }

      // Auto-recall path: search memories relevant to user's prompt + recent context
      if (config.autoRecall && !isHeartbeat) {
        try {
          // Build a richer query: user prompt + last assistant message for context
          const recentContext = summarizeRecentActivity(ev.messages ?? [], 2);
          const query = recentContext
            ? `${ev.prompt}\n\nRecent context:\n${recentContext}`
            : ev.prompt;

          api.logger.info?.(`keyoku: auto-recall searching (query: ${query.slice(0, 80)}...)`);

          const results = await client.search(entityId, query, {
            limit: config.topK,
            min_score: 0.15,
          });

          if (results.length > 0) {
            const formatted = formatMemoryContext(results);
            api.logger.info?.(`keyoku: auto-recall injected ${results.length} memories`);
            return { prependContext: formatted };
          } else {
            api.logger.info?.('keyoku: auto-recall found 0 matching memories');
          }
        } catch (err) {
          api.logger.warn(`keyoku: auto-recall failed: ${String(err)}`);
        }
      }
    });
  }

  // NOTE: agent_end capture removed — incremental capture (incremental-capture.ts)
  // now handles both user and assistant messages in real-time, making the
  // session-end batch capture redundant. This also eliminates the only source
  // of duplicate /remember calls.
}
