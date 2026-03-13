import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { createEntityResolver } from '../src/entity-resolver.js';

describe('entity resolver', () => {
  it('keeps static entity by default', () => {
    const resolver = createEntityResolver('base', resolveConfig());
    expect(resolver.resolve({}, 'recall')).toBe('base');
  });

  it('supports per-session strategy', () => {
    const resolver = createEntityResolver('base', resolveConfig({ entityStrategy: 'per-session' }));
    expect(resolver.resolve({ sessionKey: 'sess-1' }, 'recall')).toBe('base:session:sess-1');
  });

  it('supports per-user strategy from sender metadata', () => {
    const resolver = createEntityResolver('base', resolveConfig({ entityStrategy: 'per-user' }));
    const prompt = [
      'Sender (untrusted metadata):',
      '```json',
      '{"id":"U123"}',
      '```',
      'Conversation info (untrusted metadata):',
      '```json',
      '{"provider":"slack"}',
      '```',
      'hello',
    ].join('\n');

    expect(resolver.resolve({ prompt }, 'recall')).toBe('base:user:slack:U123');
  });

  it('blocks recall in group chats when disabled', () => {
    const resolver = createEntityResolver('base', resolveConfig({ recallInGroups: false }));
    expect(resolver.isAllowed({ chat_type: 'group' }, 'recall')).toBe(false);
  });

  it('renders template strategy', () => {
    const resolver = createEntityResolver(
      'base',
      resolveConfig({ entityStrategy: 'template', entityTemplate: '{base}:{provider}:{senderId}' }),
    );

    expect(resolver.resolve({ provider: 'slack', sender: { id: 'U1' } }, 'capture')).toBe(
      'base:slack:U1',
    );
  });
});
