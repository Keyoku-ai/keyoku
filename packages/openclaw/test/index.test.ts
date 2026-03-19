import keyokuMemory, { createKeyokuMemoryPlugin } from '../src/index.js';
import type { PluginApi } from '../src/types.js';

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

    expect(api.registerTool).toHaveBeenCalledTimes(7);
    expect(api.on).toHaveBeenCalled();
    expect(api.registerService).toHaveBeenCalledTimes(1);
    expect(api.registerCli).toHaveBeenCalledTimes(1);
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('keyoku: TEMP capture diagnostics enabled'),
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

    expect(api.registerTool).toHaveBeenCalledTimes(7);
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
});
