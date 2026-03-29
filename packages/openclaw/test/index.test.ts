import keyokuMemory, { createKeyokuMemoryPlugin } from '../src/index.js';
import type { PluginApi } from '../src/types.js';

const expectedToolNames = [
  'memory_search',
  'memory_get',
  'memory_store',
  'memory_forget',
  'memory_stats',
  'schedule_create',
  'schedule_list',
  'schedule_diagnose',
];

function createMockApi(pluginConfig?: Record<string, unknown>): PluginApi {
  return {
    id: 'keyoku-memory',
    name: 'Keyoku Memory',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    pluginConfig,
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    resolvePath: vi.fn((input: string) => input),
    on: vi.fn(),
    config: {},
  };
}

describe('keyokuMemory entrypoint', () => {
  it('registers directly when loaded as a runtime function export', () => {
    const api = createMockApi({ topK: 9, incrementalCapture: false });

    keyokuMemory(api);

    expect(api.registerTool).toHaveBeenCalledTimes(expectedToolNames.length);
    expect(api.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(expectedToolNames);
    expect(api.on).toHaveBeenCalled();
    expect(api.registerService).toHaveBeenCalledTimes(1);
    expect(api.registerCli).toHaveBeenCalledTimes(1);
    expect(api.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('keyoku: capture diagnostics'),
    );
  });

  it('still returns a plugin object when used as a factory', () => {
    const api = createMockApi();
    const plugin = keyokuMemory({ topK: 3, incrementalCapture: false });

    expect(plugin).toMatchObject({
      id: 'keyoku-memory',
      kind: 'memory',
      register: expect.any(Function),
    });

    plugin!.register(api);

    expect(api.registerTool).toHaveBeenCalledTimes(expectedToolNames.length);
    expect(api.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(expectedToolNames);
    expect(api.registerService).toHaveBeenCalledTimes(1);
  });

  it('supports the explicit plugin factory export', () => {
    const plugin = createKeyokuMemoryPlugin();

    expect(plugin).toMatchObject({
      id: 'keyoku-memory',
      kind: 'memory',
      register: expect.any(Function),
    });
  });

  it('disables OpenClaw heartbeat runner via target: "none" when heartbeat is enabled', () => {
    const api = createMockApi({ heartbeat: true });

    keyokuMemory(api);

    // Verify the canonical disable mechanism is used (target: "none", not every: "0")
    const config = api.config as Record<string, unknown>;
    const agents = config.agents as Record<string, unknown>;
    const defaults = agents.defaults as Record<string, unknown>;
    const heartbeat = defaults.heartbeat as Record<string, unknown>;
    expect(heartbeat.target).toBe('none');
    expect(api.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('disabled OpenClaw heartbeat runner'),
    );
  });

  it('does not disable OpenClaw heartbeat runner when heartbeat is false', () => {
    const api = createMockApi({ heartbeat: false });

    keyokuMemory(api);

    const config = api.config as Record<string, unknown>;
    expect(config.agents).toBeUndefined();
  });
});
