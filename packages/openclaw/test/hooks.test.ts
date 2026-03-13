import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerHooks } from '../src/hooks.js';
import { resolveConfig } from '../src/config.js';
import { createEntityResolver } from '../src/entity-resolver.js';
import type { PluginApi } from '../src/types.js';

function createMockClient() {
  return {
    search: vi.fn(),
    remember: vi.fn(),
    heartbeatContext: vi.fn(),
  };
}

function createMockApi() {
  const hooks: Record<string, (...args: unknown[]) => unknown> = {};
  return {
    api: {
      id: 'test',
      name: 'test',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      resolvePath: (p: string) => p,
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        hooks[hookName] = handler;
      }),
    } as unknown as PluginApi,
    hooks,
  };
}

describe('hooks', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockApi: ReturnType<typeof createMockApi>;

  describe('before_prompt_build (auto-recall)', () => {
    beforeEach(() => {
      mockClient = createMockClient();
      mockApi = createMockApi();
      const cfg = resolveConfig({ autoRecall: true, heartbeat: false, autoCapture: false });
      registerHooks(mockApi.api, mockClient as any, createEntityResolver('entity-1', cfg), 'agent-1', cfg);
    });

    it('registers before_prompt_build hook', () => {
      expect(mockApi.hooks['before_prompt_build']).toBeDefined();
    });

    it('injects memory context when results found', async () => {
      mockClient.search.mockResolvedValue([
        { memory: { content: 'User likes TypeScript' }, similarity: 0.9, score: 0.8 },
      ]);

      const result = await mockApi.hooks['before_prompt_build']({ prompt: 'What do I prefer?' });

      expect(mockClient.search).toHaveBeenCalledWith('entity-1', 'What do I prefer?', { limit: 5, min_score: 0.15 });
      expect(result).toHaveProperty('prependContext');
      expect((result as { prependContext: string }).prependContext).toContain('User likes TypeScript');
    });

    it('returns undefined when no results', async () => {
      mockClient.search.mockResolvedValue([]);

      const result = await mockApi.hooks['before_prompt_build']({ prompt: 'Hello there' });
      expect(result).toBeUndefined();
    });

    it('skips short prompts', async () => {
      const result = await mockApi.hooks['before_prompt_build']({ prompt: 'Hi' });
      expect(mockClient.search).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('handles search errors gracefully', async () => {
      mockClient.search.mockRejectedValue(new Error('Network error'));

      const result = await mockApi.hooks['before_prompt_build']({ prompt: 'What do I prefer?' });
      expect(result).toBeUndefined();
      expect(mockApi.api.logger.warn).toHaveBeenCalled();
    });

    it('supports per-session entity strategy', async () => {
      const cfg = resolveConfig({
        autoRecall: true,
        heartbeat: false,
        autoCapture: false,
        entityStrategy: 'per-session',
      });
      mockApi = createMockApi();
      registerHooks(mockApi.api, mockClient as any, createEntityResolver('entity-1', cfg), 'agent-1', cfg);
      mockClient.search.mockResolvedValue([]);

      await mockApi.hooks['before_prompt_build']({ prompt: 'What do I prefer?', sessionKey: 'sess-123' });

      expect(mockClient.search).toHaveBeenCalledWith(
        'entity-1:session:sess-123',
        'What do I prefer?',
        { limit: 5, min_score: 0.15 },
      );
    });

    it('respects recallInGroups=false policy', async () => {
      const cfg = resolveConfig({
        autoRecall: true,
        heartbeat: false,
        autoCapture: false,
        recallInGroups: false,
      });
      mockApi = createMockApi();
      registerHooks(mockApi.api, mockClient as any, createEntityResolver('entity-1', cfg), 'agent-1', cfg);

      const result = await mockApi.hooks['before_prompt_build']({
        prompt: 'What do I prefer?',
        chat_type: 'group',
      });

      expect(result).toBeUndefined();
      expect(mockClient.search).not.toHaveBeenCalled();
    });
  });

  describe('before_prompt_build (heartbeat)', () => {
    beforeEach(() => {
      mockClient = createMockClient();
      mockApi = createMockApi();
      const cfg = resolveConfig({ autoRecall: false, heartbeat: true, autoCapture: false });
      registerHooks(mockApi.api, mockClient as any, createEntityResolver('entity-1', cfg), 'agent-1', cfg);
    });

    it('injects heartbeat data when HEARTBEAT is in prompt', async () => {
      mockClient.heartbeatContext.mockResolvedValue({
        should_act: true,
        pending_work: [],
        deadlines: [{ content: 'Report due', expires_at: '2024-03-15', importance: 0.9 }],
        scheduled: [],
        conflicts: [],
        relevant_memories: [],
        goal_progress: [],
      });

      const result = await mockApi.hooks['before_prompt_build']({
        prompt: 'Read HEARTBEAT.md and follow instructions',
      });

      expect(mockClient.heartbeatContext).toHaveBeenCalledWith('entity-1', expect.objectContaining({
        agent_id: 'agent-1',
        max_results: 10,
        analyze: true,
      }));
      expect(result).toHaveProperty('prependContext');
      expect((result as { prependContext: string }).prependContext).toContain('Report due');
    });

    it('does not inject heartbeat data for normal prompts', async () => {
      const result = await mockApi.hooks['before_prompt_build']({
        prompt: 'Tell me about the weather',
      });

      expect(mockClient.heartbeatContext).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  describe('disabled hooks', () => {
    it('does not register hooks when all disabled', () => {
      mockClient = createMockClient();
      mockApi = createMockApi();
      const cfg = resolveConfig({
        autoRecall: false,
        heartbeat: false,
        autoCapture: false,
      });
      registerHooks(mockApi.api, mockClient as any, createEntityResolver('entity-1', cfg), 'agent-1', cfg);

      expect(mockApi.api.on).not.toHaveBeenCalled();
    });
  });
});
