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
 * 2. `agent_end` — pair the stashed prompt with the assistant's response,
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
import type { EntityResolver } from './entity-resolver.js';
import { stripInboundMetadata } from './inbound-metadata.js';

type OpenClawMessage = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

type BeforePromptBuildEvent = {
  prompt?: string;
  messages?: OpenClawMessage[];
};

function logCaptureDiagnostic(
  api: PluginApi,
  eventName: 'before_prompt_build' | 'agent_end',
  fields: Record<string, string | number | boolean | null | undefined>,
): void {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  api.logger.info(
    `keyoku: TEMP capture_diag event=${eventName}${parts.length ? ` ${parts.join(' ')}` : ''}`,
  );
}

function stripInjectedBlocks(text: string): string {
  return text
    .replace(/<your-memories>[\s\S]*?<\/your-memories>/gi, '')
    .replace(/<heartbeat-signals>[\s\S]*?<\/heartbeat-signals>/gi, '')
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/gi, '');
}

function readContentText(content?: string | Array<{ type?: string; text?: string }>): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join(' ');
}

function extractLatestUserMessage(messages?: OpenClawMessage[]): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = readContentText(msg.content);
    if (text) return text;
  }
  return '';
}

function cleanPromptForCapture(prompt: string): string {
  if (!prompt) return '';
  const withoutMeta = stripInboundMetadata(prompt);
  const withoutInjected = stripInjectedBlocks(withoutMeta);
  return withoutInjected.replace(/\n{3,}/g, '\n\n').trim();
}

export function registerIncrementalCapture(
  api: PluginApi,
  client: KeyokuClient,
  resolver: EntityResolver,
  agentId: string,
  config: Required<KeyokuConfig>,
): void {
  api.logger.info(
    `keyoku: TEMP capture diagnostics registered (hook=incremental entityBase=${config.entityId || 'default'} agentId=${agentId} captureMaxChars=${config.captureMaxChars})`,
  );

  // Stash for the most recent user prompt, paired with the next assistant response
  let pendingUserPrompt: string | null = null;
  let pendingEntityId: string | null = null;
  let inFlightCaptures = 0;
  let lastCaptureAt = 0;
  const clearPending = () => {
    pendingUserPrompt = null;
    pendingEntityId = null;
  };

  // Step 1: Stash user prompt (no API call yet)
  api.on(
    'before_prompt_build',
    async (event: unknown) => {
      const ev = event as BeforePromptBuildEvent;
      logCaptureDiagnostic(api, 'before_prompt_build', {
        fired: true,
        messages: ev.messages?.length ?? 0,
        prompt_len: ev.prompt?.length ?? 0,
      });
      if (!ev.prompt && (!ev.messages || ev.messages.length === 0)) {
        clearPending();
        logCaptureDiagnostic(api, 'before_prompt_build', {
          skipped: true,
          reason: 'empty_event',
          remember: 'no',
        });
        return;
      }

      if (!resolver.isAllowed(ev, 'capture')) {
        clearPending();
        logCaptureDiagnostic(api, 'before_prompt_build', {
          skipped: true,
          reason: 'capture_not_allowed',
          remember: 'no',
        });
        return;
      }

      const userMessage = extractLatestUserMessage(ev.messages).trim();
      const promptFallback = cleanPromptForCapture(ev.prompt ?? '');
      const userContent = userMessage || promptFallback;
      const source = userMessage ? 'messages' : 'prompt_fallback';
      logCaptureDiagnostic(api, 'before_prompt_build', {
        source,
        user_len: userContent.length,
      });
      if (!userContent || userContent.length < 10) {
        clearPending();
        logCaptureDiagnostic(api, 'before_prompt_build', {
          skipped: true,
          reason: !userContent ? 'empty_user_content' : 'user_content_too_short',
          source,
          user_len: userContent.length,
          remember: 'no',
        });
        return;
      }

      // Don't stash heartbeat prompts or injected blocks
      if (userContent.includes('HEARTBEAT')) {
        clearPending();
        logCaptureDiagnostic(api, 'before_prompt_build', {
          skipped: true,
          reason: 'heartbeat_prompt',
          source,
          user_len: userContent.length,
          remember: 'no',
        });
        return;
      }
      if (userContent.includes('<your-memories>') || userContent.includes('<heartbeat-signals>')) {
        clearPending();
        logCaptureDiagnostic(api, 'before_prompt_build', {
          skipped: true,
          reason: 'injected_memory_or_heartbeat_block',
          source,
          user_len: userContent.length,
          remember: 'no',
        });
        return;
      }
      if (userContent.length > config.captureMaxChars) {
        clearPending();
        logCaptureDiagnostic(api, 'before_prompt_build', {
          skipped: true,
          reason: 'user_content_too_long',
          source,
          user_len: userContent.length,
          max_len: config.captureMaxChars,
          remember: 'no',
        });
        return;
      }
      if (looksLikePromptInjection(userContent)) {
        clearPending();
        logCaptureDiagnostic(api, 'before_prompt_build', {
          skipped: true,
          reason: 'prompt_injection_detected',
          source,
          user_len: userContent.length,
          remember: 'no',
        });
        return;
      }

      pendingUserPrompt = userContent;
      pendingEntityId = resolver.resolve(ev, 'capture');
      logCaptureDiagnostic(api, 'before_prompt_build', {
        skipped: false,
        pending: true,
        source,
        user_len: userContent.length,
        entity_id: pendingEntityId,
        remember: 'no',
      });
    },
    { priority: -10 },
  ); // Low priority — runs after auto-recall

  // Step 2: On agent_end, extract the last assistant response and pair with stashed prompt
  api.on('agent_end', async (event: unknown) => {
    const ev = event as {
      messages?: Array<{
        role?: string;
        content?: string | Array<{ type?: string; text?: string }>;
      }>;
      output?: string;
      success?: boolean;
    };
    logCaptureDiagnostic(api, 'agent_end', {
      fired: true,
      messages: ev.messages?.length ?? 0,
      output_len: ev.output?.length ?? 0,
      pending_user: Boolean(pendingUserPrompt),
    });

    // Extract assistant response from the event
    let assistantContent = '';
    let assistantSource: 'output' | 'messages' | 'none' = 'none';

    // Try output first (some agent modes provide this)
    if (ev.output) {
      assistantContent = ev.output;
      assistantSource = 'output';
    }

    // Fall back to last assistant message
    if (!assistantContent && ev.messages) {
      for (let i = ev.messages.length - 1; i >= 0; i--) {
        const msg = ev.messages[i];
        if (msg.role !== 'assistant') continue;

        if (typeof msg.content === 'string') {
          assistantContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          assistantContent = msg.content
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text!)
            .join(' ');
        }
        if (assistantContent) {
          assistantSource = 'messages';
          break;
        }
      }
    }

    if (!assistantContent || assistantContent.length < 20) {
      clearPending();
      logCaptureDiagnostic(api, 'agent_end', {
        skipped: true,
        reason: !assistantContent ? 'empty_assistant_content' : 'assistant_content_too_short',
        assistant_source: assistantSource,
        assistant_len: assistantContent.length,
        remember: 'no',
      });
      return;
    }

    if (!resolver.isAllowed(ev, 'capture')) {
      clearPending();
      logCaptureDiagnostic(api, 'agent_end', {
        skipped: true,
        reason: 'capture_not_allowed',
        assistant_source: assistantSource,
        assistant_len: assistantContent.length,
        remember: 'no',
      });
      return;
    }

    // Skip heartbeat/memory noise
    if (assistantContent === 'HEARTBEAT_OK' || assistantContent === 'NO_REPLY') {
      clearPending();
      logCaptureDiagnostic(api, 'agent_end', {
        skipped: true,
        reason: 'heartbeat_or_no_reply',
        assistant_source: assistantSource,
        assistant_len: assistantContent.length,
        remember: 'no',
      });
      return;
    }
    if (
      assistantContent.includes('<heartbeat-signals>') ||
      assistantContent.includes('<your-memories>')
    ) {
      clearPending();
      logCaptureDiagnostic(api, 'agent_end', {
        skipped: true,
        reason: 'assistant_contains_injected_blocks',
        assistant_source: assistantSource,
        assistant_len: assistantContent.length,
        remember: 'no',
      });
      return;
    }
    if (looksLikePromptInjection(assistantContent)) {
      clearPending();
      logCaptureDiagnostic(api, 'agent_end', {
        skipped: true,
        reason: 'prompt_injection_detected',
        assistant_source: assistantSource,
        assistant_len: assistantContent.length,
        remember: 'no',
      });
      return;
    }

    // Build the exchange: user prompt + assistant response
    let exchange: string;
    const mode = pendingUserPrompt ? 'paired' : 'assistant-only';
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

    const resolvedEntityId = pendingEntityId ?? resolver.resolve(ev, 'capture');
    pendingEntityId = null;

    // Debounce: avoid hammering /remember with near-duplicate rapid turns.
    const now = Date.now();
    if (config.captureDebounceMs > 0 && now-lastCaptureAt < config.captureDebounceMs) {
      logCaptureDiagnostic(api, 'agent_end', {
        skipped: true,
        reason: 'capture_debounced',
        debounce_ms: config.captureDebounceMs,
        since_last_ms: now - lastCaptureAt,
        remember: 'no',
      });
      return;
    }

    // Backpressure: keep capture writes bounded.
    if (inFlightCaptures >= config.captureMaxInFlight) {
      logCaptureDiagnostic(api, 'agent_end', {
        skipped: true,
        reason: 'capture_backpressure',
        inflight: inFlightCaptures,
        max_inflight: config.captureMaxInFlight,
        remember: 'no',
      });
      return;
    }

    logCaptureDiagnostic(api, 'agent_end', {
      skipped: false,
      mode,
      entity_id: resolvedEntityId,
      assistant_source: assistantSource,
      assistant_len: assistantContent.length,
      exchange_len: exchange.length,
      remember: 'call',
    });

    try {
      inFlightCaptures += 1;
      await client.remember(resolvedEntityId, exchange, {
        agent_id: agentId,
        source: 'conversation',
        timeout_ms: config.clientTimeoutMs,
      });
      lastCaptureAt = Date.now();
      logCaptureDiagnostic(api, 'agent_end', {
        mode,
        entity_id: resolvedEntityId,
        exchange_len: exchange.length,
        remember: 'success',
      });
    } catch (err) {
      api.logger.warn(
        `keyoku: TEMP capture_diag event=agent_end mode=${mode} entity_id=${resolvedEntityId} exchange_len=${exchange.length} remember=failed error=${String(err)}`,
      );
    } finally {
      inFlightCaptures = Math.max(0, inFlightCaptures - 1);
    }
  });
}
