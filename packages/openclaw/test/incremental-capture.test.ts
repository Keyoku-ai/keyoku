import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerIncrementalCapture } from '../src/incremental-capture.js';
import { resolveConfig } from '../src/config.js';
import { createEntityResolver } from '../src/entity-resolver.js';
import type { PluginApi } from '../src/types.js';

function createMockClient() {
  return {
    remember: vi.fn(),
  };
}

function createMockApi() {
  const hooks: Record<string, (...args: unknown[]) => unknown> = {};
  return {
    api: {
      id: 'test',
      name: 'test',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

describe('incremental capture', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockApi: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockApi = createMockApi();
    const cfg = resolveConfig({
      autoRecall: false,
      autoCapture: false,
      heartbeat: false,
      captureMaxChars: 2000,
    });
    registerIncrementalCapture(
      mockApi.api,
      mockClient as any,
      createEntityResolver('entity-1', cfg),
      'agent-1',
      cfg,
    );
  });

  it('captures a small user + assistant exchange', async () => {
    await mockApi.hooks['before_prompt_build']({
      prompt: 'User says hello',
      messages: [{ role: 'user', content: 'I prefer TypeScript for scripts.' }],
    });

    await mockApi.hooks['agent_end']({
      messages: [
        { role: 'user', content: 'I prefer TypeScript for scripts.' },
        { role: 'assistant', content: 'Noted. I will remember that.' },
      ],
    });

    expect(mockClient.remember).toHaveBeenCalledTimes(1);
    const exchange = mockClient.remember.mock.calls[0]?.[1] as string;
    expect(exchange).toContain('User: I prefer TypeScript for scripts.');
    expect(exchange).toContain('Assistant: Noted. I will remember that.');
  });

  it('uses the latest user message even when the expanded prompt is huge', async () => {
    const hugePrompt = 'X'.repeat(3000);
    await mockApi.hooks['before_prompt_build']({
      prompt: hugePrompt,
      messages: [{ role: 'user', content: 'Remember that I use bun.' }],
    });

    await mockApi.hooks['agent_end']({
      messages: [
        { role: 'user', content: 'Remember that I use bun.' },
        { role: 'assistant', content: 'Got it. I will keep that in mind going forward.' },
      ],
    });

    expect(mockClient.remember).toHaveBeenCalledTimes(1);
    const exchange = mockClient.remember.mock.calls[0]?.[1] as string;
    expect(exchange).toContain('User: Remember that I use bun.');
    expect(exchange).toContain('Assistant: Got it.');
  });

  it('strips injected metadata blocks from the fallback prompt', async () => {
    const prompt = `Conversation info (untrusted metadata):\n\
\n\
\`\`\`json\n\
{ "channel": "discord" }\n\
\`\`\`\n\
\n\
<your-memories>\n\
never store this\n\
</your-memories>\n\
\n\
Actual user message that should be captured.`;

    await mockApi.hooks['before_prompt_build']({
      prompt,
      messages: [],
    });

    await mockApi.hooks['agent_end']({
      messages: [
        { role: 'assistant', content: 'Understood. I will store that preference.' },
      ],
    });

    expect(mockClient.remember).toHaveBeenCalledTimes(1);
    const exchange = mockClient.remember.mock.calls[0]?.[1] as string;
    expect(exchange).toContain('User: Actual user message that should be captured.');
    expect(exchange).not.toContain('Conversation info (untrusted metadata)');
    expect(exchange).not.toContain('<your-memories>');
  });

  it('clears a skipped pending prompt before the next assistant-only capture', async () => {
    await mockApi.hooks['before_prompt_build']({
      prompt: 'Remember that I prefer fish shell.',
      messages: [{ role: 'user', content: 'Remember that I prefer fish shell.' }],
    });

    await mockApi.hooks['agent_end']({
      messages: [{ role: 'assistant', content: 'Too short.' }],
    });

    await mockApi.hooks['agent_end']({
      messages: [
        {
          role: 'assistant',
          content: 'Tool-only follow-up response that should not inherit an earlier user prompt.',
        },
      ],
    });

    expect(mockClient.remember).toHaveBeenCalledTimes(1);
    const exchange = mockClient.remember.mock.calls[0]?.[1] as string;
    expect(exchange).toBe(
      'Tool-only follow-up response that should not inherit an earlier user prompt.',
    );
  });
});
