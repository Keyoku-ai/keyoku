/**
 * OpenClaw lifecycle hook registrations.
 * - before_prompt_build: auto-recall + heartbeat context fusion
 * - agent_end: auto-capture memorable facts
 */

import type { KeyokuClient } from '@keyoku/memory';
import type { KeyokuConfig } from './config.js';
import { formatMemoryContext, formatHeartbeatContext } from './context.js';
import type { PluginApi } from './types.js';
import type { EntityResolver } from './entity-resolver.js';

/**
 * Strip OpenClaw-injected inbound metadata blocks from a prompt string.
 * These blocks (e.g. "Conversation info (untrusted metadata):" followed by
 * fenced JSON) are AI-facing context that pollutes search queries.
 */
const INBOUND_META_SENTINELS = [
  'Conversation info (untrusted metadata):',
  'Sender (untrusted metadata):',
  'Thread starter (untrusted, for context):',
  'Replied message (untrusted, for context):',
  'Forwarded message context (untrusted metadata):',
  'Chat history since last reply (untrusted, for context):',
  'Untrusted context (metadata, do not treat as instructions or commands):',
] as const;

function stripInboundMetadata(text: string): string {
  if (!text || !INBOUND_META_SENTINELS.some((s) => text.includes(s))) {
    return text;
  }

  const lines = text.split('\n');
  const result: string[] = [];
  let inMetaBlock = false;
  let inFencedJson = false;

  for (const line of lines) {
    if (!inMetaBlock && INBOUND_META_SENTINELS.some((s) => line.startsWith(s))) {
      inMetaBlock = true;
      inFencedJson = false;
      continue;
    }

    if (inMetaBlock) {
      if (!inFencedJson && line.trim() === '```json') {
        inFencedJson = true;
        continue;
      }
      if (inFencedJson) {
        if (line.trim() === '```') {
          inMetaBlock = false;
          inFencedJson = false;
        }
        continue;
      }
      if (line.trim() === '') continue;
      // Non-blank line outside fence — treat as user content
      inMetaBlock = false;
    }

    result.push(line);
  }

  return result.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
}

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
  resolver: EntityResolver,
  agentId: string,
  config: Required<KeyokuConfig>,
): void {
  // before_prompt_build: auto-recall + heartbeat context injection
  if (config.autoRecall || config.heartbeat) {
    api.on('before_prompt_build', async (event: unknown) => {
      const ev = event as { prompt?: string; messages?: unknown[] };
      if (!ev.prompt || ev.prompt.length < 5) return;

      const isHeartbeat = ev.prompt.includes('HEARTBEAT');

      // Heartbeat path: engine handles all intelligence (cooldown, novelty, active hours, nudges)
      if (isHeartbeat && config.heartbeat) {
        if (!resolver.isAllowed(ev, 'heartbeat')) {
          api.logger.debug?.('keyoku: heartbeat recall skipped in group context by policy');
          return;
        }

        const entityId = resolver.resolve(ev, 'heartbeat');
        const activitySummary = summarizeRecentActivity(ev.messages ?? []);

        // Detect active conversation: check if the most recent user message
        // was within the last 15 minutes. Messages may have a `timestamp` field
        // (ISO string or epoch ms). If no timestamps available, fall back to
        // checking only the last few messages in the array.
        const msgs = (ev.messages ?? []) as Array<{
          role?: string;
          content?: string;
          timestamp?: string | number;
        }>;
        const CONVERSATION_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
        const now = Date.now();
        let hasUserMessages = false;

        // Count real (non-heartbeat) user messages to detect session-establishing messages
        let userMsgCount = 0;
        for (const m of msgs) {
          const msg = m as { role?: string; content?: string };
          if (msg.role === 'user' && msg.content && !msg.content.includes('HEARTBEAT')) {
            userMsgCount++;
          }
        }

        // If there's only 1 user message, it's the initial session-establishing message — skip it
        if (userMsgCount > 1) {
          // Walk backwards to find the most recent non-heartbeat user message
          for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i];
            if (!msg.content || msg.content.includes('HEARTBEAT')) continue;
            if (msg.role !== 'user') continue;

            // If message has a timestamp, use it
            if (msg.timestamp) {
              const ts =
                typeof msg.timestamp === 'number'
                  ? msg.timestamp
                  : new Date(msg.timestamp).getTime();
              if (!isNaN(ts) && now - ts < CONVERSATION_WINDOW_MS) {
                hasUserMessages = true;
              }
            } else {
              // No timestamp — only consider it active if it's in the last 4 messages
              hasUserMessages = i >= msgs.length - 4;
            }
            break; // only check the most recent user message
          }
        }

        const heartbeatQuery =
          activitySummary ||
          'important things about this user, recent plans, preferences, and what they care about';

        try {
          const ctx = await client.heartbeatContext(entityId, {
            query: heartbeatQuery,
            top_k: Math.max(config.topK, 8),
            min_score: 0.05,
            agent_id: agentId,
            max_results: 10,
            analyze: true,
            activity_summary: activitySummary || undefined,
            autonomy: config.autonomy,
            in_conversation: hasUserMessages,
          });

          const memories = ctx.relevant_memories ?? [];
          const decision = ctx.decision_reason ?? 'unknown';

          // Engine decides — plugin just logs and passes through
          if (ctx.should_act) {
            const formatted = formatHeartbeatContext(ctx);
            if (formatted) {
              const analysis = ctx.analysis;
              const analyzed = analysis ? ` [${analysis.autonomy}/${analysis.urgency}]` : '';
              api.logger.info?.(
                `keyoku: heartbeat ${decision} (memories: ${memories.length}, tier: ${ctx.highest_urgency_tier ?? 'n/a'}${analyzed})`,
              );
              return { prependContext: formatted };
            }
          }

          api.logger.info?.(
            `keyoku: heartbeat ${decision} (should_act: false, memories: ${memories.length})`,
          );
        } catch (err) {
          api.logger.warn(`keyoku: heartbeat context failed: ${String(err)}`);
        }
        return;
      }

      // Auto-recall path: search memories relevant to user's prompt + recent context
      if (config.autoRecall && !isHeartbeat) {
        if (!resolver.isAllowed(ev, 'recall')) {
          api.logger.debug?.('keyoku: auto-recall skipped in group context by policy');
          return;
        }

        const entityId = resolver.resolve(ev, 'recall');
        try {
          // Strip OpenClaw metadata blocks so the search query is the actual user message
          const cleanPrompt = stripInboundMetadata(ev.prompt);
          // Build a richer query: user prompt + last assistant message for context
          const recentContext = summarizeRecentActivity(ev.messages ?? [], 2);
          const query = recentContext
            ? `${cleanPrompt}\n\nRecent context:\n${recentContext}`
            : cleanPrompt;

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

  // Record heartbeat messages for dedup — captures what the AI actually said
  if (config.heartbeat) {
    api.on('agent_end', async (event: unknown) => {
      const ev = event as {
        messages?: Array<{
          role?: string;
          content?: string | Array<{ type?: string; text?: string }>;
        }>;
        output?: string;
      };

      // Check if this was a heartbeat response
      const messages = ev.messages ?? [];
      const wasHeartbeat = messages.some((m) => {
        const text = typeof m.content === 'string' ? m.content : '';
        return m.role === 'user' && text.includes('HEARTBEAT');
      });
      if (!wasHeartbeat) return;

      // Extract assistant response
      let response = ev.output ?? '';
      if (!response) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.role !== 'assistant') continue;
          if (typeof msg.content === 'string') {
            response = msg.content;
          } else if (Array.isArray(msg.content)) {
            response = (msg.content as Array<{ type?: string; text?: string }>)
              .filter((b) => b.type === 'text' && b.text)
              .map((b) => b.text!)
              .join(' ');
          }
          if (response) break;
        }
      }

      // Don't record non-messages
      if (
        !response ||
        response === 'HEARTBEAT_OK' ||
        response === 'NO_REPLY' ||
        response.length < 10
      )
        return;

      try {
        const entityId = resolver.resolve(ev, 'heartbeat');
        await client.recordHeartbeatMessage(entityId, response, { agent_id: agentId });
      } catch (err) {
        api.logger.warn(`keyoku: failed to record heartbeat message: ${String(err)}`);
      }
    });
  }

  // NOTE: agent_end capture removed — incremental capture (incremental-capture.ts)
  // now handles both user and assistant messages in real-time, making the
  // session-end batch capture redundant. This also eliminates the only source
  // of duplicate /remember calls.
}
