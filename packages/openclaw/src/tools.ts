/**
 * OpenClaw tool registrations for Keyoku memory operations.
 * Registers 7 tools:
 *   memory_search, memory_get (OpenClaw standard — replaces built-in file-based memory)
 *   memory_store, memory_forget, memory_stats (Keyoku memory management)
 *   schedule_create, schedule_list (Keyoku scheduling)
 */

import { Type } from '@sinclair/typebox';
import type { KeyokuClient } from '@keyoku/memory';
import type { PluginApi } from './types.js';
import type { EntityResolver } from './entity-resolver.js';

export function registerTools(
  api: PluginApi,
  client: KeyokuClient,
  resolver: EntityResolver,
  agentId: string,
): void {
  // memory_search — OpenClaw-standard search tool (replaces memory-core's built-in)
  api.registerTool(
    {
      name: 'memory_search',
      label: 'Memory Search',
      description:
        'Search through memories for relevant information. Returns semantically similar memories ranked by relevance.',
      parameters: Type.Object({
        query: Type.String({ description: 'Search query' }),
        maxResults: Type.Optional(Type.Number({ description: 'Max results (default: 5)' })),
        minScore: Type.Optional(Type.Number({ description: 'Minimum relevance score 0-1' })),
      }),
      async execute(_toolCallId, params, context) {
        const {
          query,
          maxResults = 5,
          minScore = 0.1,
        } = params as {
          query: string;
          maxResults?: number;
          minScore?: number;
        };
        if (!resolver.isAllowed(context, 'recall')) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ results: [], provider: 'memory', mode: 'semantic' }),
              },
            ],
            details: { count: 0 },
          };
        }

        const entityId = resolver.resolve(context, 'tool');
        const results = await client.search(entityId, query, {
          limit: maxResults,
          min_score: minScore,
        });

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ results: [], provider: 'memory', mode: 'semantic' }),
              },
            ],
            details: { count: 0 },
          };
        }

        const mapped = results.map((r) => ({
          path: `mem:${r.memory.id}`,
          startLine: 1,
          endLine: 1,
          score: r.similarity,
          snippet: r.memory.content,
          source: 'memory',
          citation: `mem:${r.memory.id}`,
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ results: mapped, provider: 'memory', mode: 'semantic' }),
            },
          ],
          details: { count: mapped.length },
        };
      },
    },
    { name: 'memory_search' },
  );

  // memory_get — OpenClaw-standard memory read tool (replaces file-based reads)
  api.registerTool(
    {
      name: 'memory_get',
      label: 'Memory Get',
      description: 'Read a specific memory by its ID (mem:<id>) or search for a memory by keyword.',
      parameters: Type.Object({
        path: Type.String({ description: 'Memory path (mem:<id>) or keyword to search' }),
        from: Type.Optional(Type.Number({ description: 'Line offset (unused)' })),
        lines: Type.Optional(Type.Number({ description: 'Line count (unused)' })),
      }),
      async execute(_toolCallId, params, context) {
        const { path: memPath } = params as { path: string; from?: number; lines?: number };

        if (memPath.startsWith('mem:') || memPath.startsWith('keyoku:')) {
          const id = memPath.startsWith('mem:') ? memPath.slice(4) : memPath.slice(7);
          try {
            const memory = await client.getMemory(id);
            return {
              content: [
                { type: 'text', text: JSON.stringify({ text: memory.content, path: memPath }) },
              ],
            };
          } catch {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ text: '', path: memPath, error: 'Memory not found' }),
                },
              ],
            };
          }
        }

        // Fallback: treat path as a search query
        if (!resolver.isAllowed(context, 'recall')) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ text: '', path: memPath, error: 'Not found' }),
              },
            ],
          };
        }

        const entityId = resolver.resolve(context, 'tool');
        const results = await client.search(entityId, memPath, { limit: 1 });
        if (results.length > 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  text: results[0].memory.content,
                  path: `mem:${results[0].memory.id}`,
                }),
              },
            ],
          };
        }

        return {
          content: [
            { type: 'text', text: JSON.stringify({ text: '', path: memPath, error: 'Not found' }) },
          ],
        };
      },
    },
    { name: 'memory_get' },
  );

  // memory_store — store a new memory
  api.registerTool(
    {
      name: 'memory_store',
      label: 'Memory Store',
      description:
        'Save important information in long-term memory. Use for preferences, facts, decisions.',
      parameters: Type.Object({
        text: Type.String({ description: 'Information to remember' }),
      }),
      async execute(_toolCallId, params, context) {
        const { text } = params as { text: string };
        if (!resolver.isAllowed(context, 'capture')) {
          return {
            content: [{ type: 'text', text: 'Skipped: memory capture disabled for this chat context.' }],
            details: { skipped: true },
          };
        }

        const entityId = resolver.resolve(context, 'tool');
        const result = await client.remember(entityId, text, { agent_id: agentId });

        return {
          content: [
            {
              type: 'text',
              text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`,
            },
          ],
          details: { memories_created: result.memories_created },
        };
      },
    },
    { name: 'memory_store' },
  );

  // memory_forget — delete a memory by ID
  api.registerTool(
    {
      name: 'memory_forget',
      label: 'Memory Forget',
      description: 'Delete a specific memory by ID.',
      parameters: Type.Object({
        memory_id: Type.String({ description: 'The memory ID to delete' }),
      }),
      async execute(_toolCallId, params) {
        const { memory_id } = params as { memory_id: string };
        const result = await client.deleteMemory(memory_id);

        return {
          content: [{ type: 'text', text: `Memory ${memory_id} deleted.` }],
          details: { status: result.status },
        };
      },
    },
    { name: 'memory_forget' },
  );

  // memory_stats — get memory statistics
  api.registerTool(
    {
      name: 'memory_stats',
      label: 'Memory Stats',
      description: 'Get memory statistics for the current entity.',
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, context) {
        const entityId = resolver.resolve(context, 'tool');
        const stats = await client.getStats(entityId);

        const text = [
          `Total memories: ${stats.total_memories}`,
          `Active memories: ${stats.active_memories}`,
          `By type: ${JSON.stringify(stats.by_type)}`,
          `By state: ${JSON.stringify(stats.by_state)}`,
        ].join('\n');

        return {
          content: [{ type: 'text', text }],
          details: { ...stats } as Record<string, unknown>,
        };
      },
    },
    { name: 'memory_stats' },
  );

  // schedule_create — create a scheduled memory
  api.registerTool(
    {
      name: 'schedule_create',
      label: 'Schedule Create',
      description:
        'Create a scheduled task/reminder. Cron tags: "daily", "weekly", "monthly", or a cron expression.',
      parameters: Type.Object({
        content: Type.String({ description: 'What to schedule' }),
        cron_tag: Type.String({
          description: 'Cron tag: "daily", "weekly", "monthly", or cron expression',
        }),
      }),
      async execute(_toolCallId, params, context) {
        const { content, cron_tag } = params as { content: string; cron_tag: string };
        if (!resolver.isAllowed(context, 'capture')) {
          return {
            content: [{ type: 'text', text: 'Skipped: scheduling disabled for this chat context.' }],
            details: { skipped: true },
          };
        }

        const entityId = resolver.resolve(context, 'tool');
        const result = await client.createSchedule(entityId, agentId, content, cron_tag);

        return {
          content: [{ type: 'text', text: `Scheduled: "${content}" (${cron_tag})` }],
          details: { id: result.id },
        };
      },
    },
    { name: 'schedule_create' },
  );

  // schedule_list — list schedules
  api.registerTool(
    {
      name: 'schedule_list',
      label: 'Schedule List',
      description: 'List active schedules.',
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, context) {
        if (!resolver.isAllowed(context, 'recall')) {
          return {
            content: [{ type: 'text', text: 'No active schedules.' }],
            details: { count: 0 },
          };
        }

        const entityId = resolver.resolve(context, 'tool');
        const schedules = await client.listSchedules(entityId, agentId);

        if (schedules.length === 0) {
          return {
            content: [{ type: 'text', text: 'No active schedules.' }],
            details: { count: 0 },
          };
        }

        const text = schedules.map((s, i) => `${i + 1}. ${s.content} (id: ${s.id})`).join('\n');

        return {
          content: [{ type: 'text', text: `${schedules.length} schedules:\n\n${text}` }],
          details: { count: schedules.length },
        };
      },
    },
    { name: 'schedule_list' },
  );
}
