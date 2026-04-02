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
    ackSchedule: vi.fn(),
    recordHeartbeatMessage: vi.fn(),
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

      // Adaptive: strong query (question word) → adaptive 0.25, floor 0.35 → max=0.35, limit=topK*2=10
      expect(mockClient.search).toHaveBeenCalledWith('entity-1', 'What do I prefer?', {
        limit: 10,
        min_score: 0.35,
        timeout_ms: 120000,
      });
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

      // Adaptive: strong query → min_score=0.25, limit=topK*2=10
      expect(mockClient.search).toHaveBeenCalledWith(
        'entity-1:session:sess-123',
        'What do I prefer?',
        { limit: 10, min_score: 0.35, timeout_ms: 120000 },
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

    it('sanitizes metadata blocks in latest-user recall mode', async () => {
      mockClient.search.mockResolvedValue([]);

      await mockApi.hooks['before_prompt_build']({
        prompt: 'fallback prompt',
        messages: [
          {
            role: 'user',
            content:
              'Conversation info (untrusted metadata):\n```json\n{"channel":"telegram"}\n```\n\nActual user request: help me deploy',
          },
        ],
      });

      // Adaptive: fetchLimit = topK*2 = 10
      expect(mockClient.search).toHaveBeenCalledWith('entity-1', 'Actual user request: help me deploy', {
        limit: 10,
        min_score: 0.35,
        timeout_ms: 120000,
      });
    });

    it('logs feedback usage for injected memories once and clears pending state after agent_end', async () => {
      mockClient.search.mockResolvedValue([
        {
          memory: {
            id: 'mem-1',
            content: 'User prefers TypeScript for backend services and testing',
          },
          similarity: 0.9,
          score: 0.8,
        },
      ]);

      await mockApi.hooks['before_prompt_build']({ prompt: 'What language stack should I use?' });

      const info = mockApi.api.logger.info as ReturnType<typeof vi.fn>;
      const baselineInfoCalls = info.mock.calls.length;

      await mockApi.hooks['agent_end']({
        output: 'We should keep this in TypeScript for the backend and testing so it matches the preference.',
      });

      const firstFeedbackLogs = info.mock.calls
        .slice(baselineInfoCalls)
        .map(([message]) => String(message))
        .filter((message) => message.includes('feedback') && message.includes('1/1 injected memories referenced'));

      expect(firstFeedbackLogs).toHaveLength(1);

      await mockApi.hooks['agent_end']({
        output: 'TypeScript is still the right choice here.',
      });

      const allFeedbackLogs = info.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('feedback') && message.includes('1/1 injected memories referenced'));

      expect(allFeedbackLogs).toHaveLength(1);
    });

    it('clears pending injected memories after short agent_end output', async () => {
      mockClient.search.mockResolvedValue([
        {
          memory: {
            id: 'mem-2',
            content: 'User prefers terminal-first workflows for repo maintenance',
          },
          similarity: 0.91,
          score: 0.81,
        },
      ]);

      await mockApi.hooks['before_prompt_build']({ prompt: 'How should I approach this repo task?' });

      const info = mockApi.api.logger.info as ReturnType<typeof vi.fn>;
      const baselineInfoCalls = info.mock.calls.length;

      await mockApi.hooks['agent_end']({ output: 'Too short.' });
      await mockApi.hooks['agent_end']({
        output: 'A terminal-first workflow still seems appropriate for this repository task.',
      });

      const feedbackLogs = info.mock.calls
        .slice(baselineInfoCalls)
        .map(([message]) => String(message))
        .filter((message) => message.includes('feedback'));

      expect(feedbackLogs).toHaveLength(0);
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
        signals_only: true,
        auto_ack_scheduled: false,
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

    it('acknowledges due schedules only after a real heartbeat response', async () => {
      mockClient.heartbeatContext.mockResolvedValue({
        should_act: true,
        pending_work: [],
        deadlines: [],
        scheduled: [
          { id: 'sched-1', content: 'Check PRs' },
          { id: 'sched-2', content: 'Review backlog' },
        ],
        conflicts: [],
        relevant_memories: [],
      });
      mockClient.ackSchedule.mockResolvedValue({ status: 'acknowledged' });
      mockClient.recordHeartbeatMessage.mockResolvedValue({ status: 'ok', id: 'hb-1' });

      await mockApi.hooks['before_prompt_build']({
        prompt: 'Read HEARTBEAT.md and follow instructions',
      });

      await mockApi.hooks['agent_end']({
        messages: [
          { role: 'user', content: 'HEARTBEAT poll' },
          { role: 'assistant', content: 'You should check PR #94 today.' },
        ],
        output: 'You should check PR #94 today.',
      });

      expect(mockClient.ackSchedule).toHaveBeenCalledTimes(2);
      expect(mockClient.ackSchedule).toHaveBeenNthCalledWith(1, 'sched-1');
      expect(mockClient.ackSchedule).toHaveBeenNthCalledWith(2, 'sched-2');
      expect(mockClient.recordHeartbeatMessage).toHaveBeenCalledWith(
        'entity-1',
        'You should check PR #94 today.',
        { agent_id: 'agent-1' },
      );
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
