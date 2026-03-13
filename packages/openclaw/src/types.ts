/**
 * Minimal OpenClaw plugin API types.
 * These mirror the types from openclaw/src/plugins/types.ts
 * so that @keyoku/openclaw can compile without importing openclaw directly.
 * At runtime, the actual OpenClaw API object is passed in.
 */

export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
};

export type AgentTool = {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    context?: unknown,
  ) => Promise<ToolResult>;
};

export type PluginApi = {
  id: string;
  name: string;
  logger: PluginLogger;
  pluginConfig?: Record<string, unknown>;
  registerTool: (tool: AgentTool, opts?: { name?: string; names?: string[] }) => void;
  registerHook?: (
    events: string | string[],
    handler: (...args: unknown[]) => unknown,
    opts?: Record<string, unknown>,
  ) => void;
  registerCli: (
    registrar: (ctx: { program: unknown; config: unknown; logger: PluginLogger }) => void,
    opts?: { commands?: string[] },
  ) => void;
  registerService: (service: {
    id: string;
    start: (ctx: unknown) => void | Promise<void>;
    stop?: (ctx: unknown) => void | Promise<void>;
  }) => void;
  resolvePath: (input: string) => string;
  on: (
    hookName: string,
    handler: (...args: unknown[]) => unknown,
    opts?: { priority?: number },
  ) => void;
  config?: Record<string, unknown>;
};
