import type { KeyokuConfig } from './config.js';

export type MemoryUse = 'recall' | 'capture' | 'heartbeat' | 'tool';

export type EntityResolver = {
  resolve: (event: unknown, use: MemoryUse) => string;
  isAllowed: (event: unknown, use: MemoryUse) => boolean;
};

type ScopeContext = {
  sessionKey?: string;
  provider?: string;
  channel?: string;
  chatType?: string;
  senderId?: string;
  chatId?: string;
};

const GROUP_LIKE_CHAT_TYPES = new Set(['group', 'supergroup', 'channel', 'room']);

function sanitizePart(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9:_\-.]/g, '_')
    .slice(0, 180);
}

function readString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim().length > 0 ? input.trim() : undefined;
}

function pluck(obj: unknown, ...path: string[]): unknown {
  let current = obj as Record<string, unknown> | undefined;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[key] as Record<string, unknown> | undefined;
  }
  return current;
}

function extractJsonBlock(prompt: string, heading: string): Record<string, unknown> | null {
  const headingIndex = prompt.indexOf(heading);
  if (headingIndex === -1) return null;

  const fencedStart = prompt.indexOf('```json', headingIndex);
  if (fencedStart === -1) return null;

  const jsonStart = fencedStart + '```json'.length;
  const fencedEnd = prompt.indexOf('```', jsonStart);
  if (fencedEnd === -1) return null;

  const raw = prompt.slice(jsonStart, fencedEnd).trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractContext(event: unknown): ScopeContext {
  const ev = (event ?? {}) as Record<string, unknown>;

  const prompt = readString(ev.prompt) ?? '';
  const senderMeta = prompt ? extractJsonBlock(prompt, 'Sender (untrusted metadata):') : null;
  const convoMeta = prompt
    ? extractJsonBlock(prompt, 'Conversation info (untrusted metadata):')
    : null;

  const channel =
    readString(ev.channel) ??
    readString(pluck(ev, 'inboundMeta', 'channel')) ??
    readString(pluck(ev, 'deliveryContext', 'channel')) ??
    readString(convoMeta?.channel);

  const provider =
    readString(ev.provider) ??
    readString(pluck(ev, 'inboundMeta', 'provider')) ??
    readString(convoMeta?.provider) ??
    channel;

  const chatType =
    readString(ev.chat_type) ??
    readString(ev.chatType) ??
    readString(pluck(ev, 'inboundMeta', 'chat_type')) ??
    readString(pluck(ev, 'inboundMeta', 'chatType')) ??
    readString(convoMeta?.chat_type) ??
    readString(convoMeta?.chatType);

  const senderId =
    readString(pluck(ev, 'sender', 'id')) ??
    readString(pluck(ev, 'sender', 'username')) ??
    readString(pluck(ev, 'inboundMeta', 'sender', 'id')) ??
    readString(pluck(ev, 'inboundMeta', 'sender', 'username')) ??
    readString(senderMeta?.id) ??
    readString(senderMeta?.username);

  const chatId =
    readString(ev.chatId) ??
    readString(ev.channelId) ??
    readString(ev.threadId) ??
    readString(ev.conversationId) ??
    readString(pluck(ev, 'inboundMeta', 'chat_id')) ??
    readString(pluck(ev, 'inboundMeta', 'chatId'));

  const sessionKey =
    readString(ev.sessionKey) ??
    readString(pluck(ev, 'session', 'key')) ??
    readString(pluck(ev, 'ctx', 'sessionKey'));

  return { sessionKey, provider, channel, chatType, senderId, chatId };
}

function isGroupLike(chatType?: string): boolean {
  if (!chatType) return false;
  const normalized = chatType.toLowerCase();
  if (GROUP_LIKE_CHAT_TYPES.has(normalized)) return true;
  return normalized.includes('group') || normalized.includes('channel') || normalized.includes('room');
}

export function createEntityResolver(
  baseEntityId: string,
  config: Required<KeyokuConfig>,
): EntityResolver {
  function resolve(event: unknown, _use: MemoryUse): string {
    const strategy = config.entityStrategy;
    if (strategy === 'static') return baseEntityId;

    const ctx = extractContext(event);
    const provider = sanitizePart(ctx.provider ?? ctx.channel ?? 'unknown');
    const session = ctx.sessionKey ? sanitizePart(ctx.sessionKey) : undefined;
    const sender = ctx.senderId ? sanitizePart(ctx.senderId) : undefined;
    const chat = ctx.chatId ? sanitizePart(ctx.chatId) : undefined;

    if (strategy === 'per-session') {
      return session ? `${baseEntityId}:session:${session}` : baseEntityId;
    }

    if (strategy === 'per-user') {
      if (sender) return `${baseEntityId}:user:${provider}:${sender}`;
      if (session) return `${baseEntityId}:session:${session}`;
      return baseEntityId;
    }

    if (strategy === 'per-channel') {
      if (chat) return `${baseEntityId}:channel:${provider}:${chat}`;
      if (session) return `${baseEntityId}:session:${session}`;
      return baseEntityId;
    }

    // template strategy
    const template = config.entityTemplate || '{base}';
    const rendered = template
      .replaceAll('{base}', baseEntityId)
      .replaceAll('{provider}', provider)
      .replaceAll('{channel}', sanitizePart(ctx.channel ?? 'unknown'))
      .replaceAll('{chatType}', sanitizePart(ctx.chatType ?? 'unknown'))
      .replaceAll('{senderId}', sender ?? 'unknown')
      .replaceAll('{chatId}', chat ?? 'unknown')
      .replaceAll('{sessionKey}', session ?? 'unknown');

    const trimmed = rendered.trim();
    return trimmed.length > 0 ? trimmed : baseEntityId;
  }

  function isAllowed(event: unknown, use: MemoryUse): boolean {
    const ctx = extractContext(event);
    if (!isGroupLike(ctx.chatType)) return true;

    if (use === 'capture') return config.captureInGroups;
    if (use === 'recall' || use === 'heartbeat') return config.recallInGroups;
    return true;
  }

  return { resolve, isAllowed };
}
