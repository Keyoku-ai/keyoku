/**
 * CLI subcommand registration for memory management.
 * Registers `memory` command with search, list, stats, clear subcommands.
 */

import { join } from 'node:path';
import type { KeyokuClient } from '@keyoku/memory';
import type { PluginApi, PluginLogger } from './types.js';
import { formatMemoryList } from './context.js';
import { importMemoryFiles } from './migration.js';
import {
  migrateVectorStore,
  migrateAllVectorStores,
  discoverVectorDbs,
} from './migrate-vector-store.js';

// Minimal Commander-like interface for chaining
interface CommandChain {
  description(desc: string): CommandChain;
  command(name: string): CommandChain;
  argument(name: string, desc: string): CommandChain;
  option(flags: string, desc: string, defaultVal?: string): CommandChain;
  action(fn: (...args: unknown[]) => Promise<void> | void): CommandChain;
}

export function registerCli(api: PluginApi, client: KeyokuClient, entityId: string): void {
  api.registerCli(
    ({ program }: { program: unknown; logger: PluginLogger }) => {
      const prog = program as CommandChain;
      const memory = prog.command('memory').description('Keyoku memory commands');

      memory
        .command('search')
        .description('Search memories')
        .argument('<query>', 'Search query')
        .option('--limit <n>', 'Max results', '5')
        .action(async (query: unknown, opts: unknown) => {
          const q = query as string;
          const limit = parseInt((opts as { limit: string }).limit, 10);
          const results = await client.search(entityId, q, { limit });

          if (results.length === 0) {
            console.log('No matching memories found.');
            return;
          }

          for (const r of results) {
            console.log(`[${(r.similarity * 100).toFixed(0)}%] ${r.memory.content}`);
          }
        });

      memory
        .command('list')
        .description('List recent memories')
        .option('--limit <n>', 'Max results', '20')
        .action(async (opts: unknown) => {
          const limit = parseInt((opts as { limit: string }).limit, 10);
          const memories = await client.listMemories(entityId, limit);
          console.log(formatMemoryList(memories));
        });

      memory
        .command('stats')
        .description('Show memory statistics')
        .action(async () => {
          const stats = await client.getStats(entityId);
          console.log(`Total: ${stats.total_memories} | Active: ${stats.active_memories}`);
          console.log(`By type: ${JSON.stringify(stats.by_type)}`);
          console.log(`By state: ${JSON.stringify(stats.by_state)}`);
        });

      memory
        .command('clear')
        .description('Delete all memories for this entity')
        .action(async () => {
          await client.deleteAllMemories(entityId);
          console.log('All memories cleared.');
        });

      memory
        .command('import')
        .description('Import files into Keyoku (md, txt, json, yaml — recursive)')
        .option('--dir <path>', 'Root directory to scan', '.')
        .option('--depth <n>', 'Max recursion depth (-1 = unlimited, 0 = no recursion)', '5')
        .option('--types <list>', 'Comma-separated file extensions', 'md,txt,json,yaml,yml')
        .option('--dry-run', 'Show what would be imported without storing')
        .action(async (opts: unknown) => {
          const options = opts as { dir: string; depth: string; types: string; dryRun?: boolean };
          const types = options.types.split(',').map((t) => (t.startsWith('.') ? t : `.${t}`));
          const result = await importMemoryFiles({
            client,
            entityId,
            workspaceDir: options.dir,
            depth: parseInt(options.depth, 10),
            types,
            dryRun: options.dryRun,
            logger: console,
          });
          console.log(
            `\nImport complete: ${result.imported} imported, ${result.skipped} skipped, ${result.errors} errors`,
          );
        });
      memory
        .command('migrate')
        .description('Migrate OpenClaw vector store (SQLite) into Keyoku')
        .option('--agent-id <id>', 'Agent ID to scope the migration')
        .option('--sqlite <path>', 'Path to a specific OpenClaw .sqlite file')
        .option('--include-markdown', 'Also import MEMORY.md and memory/*.md files')
        .option('--dry-run', 'Show what would be imported without storing')
        .action(async (opts: unknown) => {
          const options = opts as {
            agentId?: string;
            sqlite?: string;
            includeMarkdown?: boolean;
            dryRun?: boolean;
          };

          const home = process.env.HOME ?? '';

          // Vector store migration
          if (options.sqlite) {
            // Migrate a specific SQLite file
            const result = await migrateVectorStore({
              client,
              entityId,
              sqlitePath: options.sqlite,
              agentId: options.agentId,
              dryRun: options.dryRun,
              logger: console,
            });
            console.log(
              `\nVector migration: ${result.totalChunks} total, ${result.imported} imported, ${result.skipped} skipped, ${result.errors} errors`,
            );
          } else {
            // Auto-discover OpenClaw memory directory
            const memoryDir = join(home, '.openclaw', 'memory');
            const dbs = discoverVectorDbs(memoryDir);

            if (dbs.length === 0) {
              console.log('No OpenClaw vector stores found at ~/.openclaw/memory/*.sqlite');
            } else {
              const result = await migrateAllVectorStores({
                client,
                entityId,
                memoryDir,
                agentId: options.agentId,
                dryRun: options.dryRun,
                logger: console,
              });
              console.log(
                `\nVector migration: ${result.totalChunks} total, ${result.imported} imported, ${result.skipped} skipped, ${result.errors} errors`,
              );
            }
          }

          // Optionally also import markdown files
          if (options.includeMarkdown) {
            const workspaceDir = join(home, '.openclaw');
            const mdResult = await importMemoryFiles({
              client,
              entityId,
              workspaceDir,
              agentId: options.agentId,
              dryRun: options.dryRun,
              logger: console,
            });
            console.log(
              `Markdown import: ${mdResult.imported} imported, ${mdResult.skipped} skipped, ${mdResult.errors} errors`,
            );
          }
        });
      // === Watcher commands ===

      memory
        .command('watcher')
        .description('Show watcher status and recent ticks')
        .option('--limit <n>', 'Number of recent ticks to show', '5')
        .action(async (opts: unknown) => {
          const limit = parseInt((opts as { limit: string }).limit, 10);

          try {
            const status = await client.watcherStatus();
            console.log(`Watcher: ${status.running ? 'RUNNING' : 'STOPPED'}`);
            if (status.running) {
              console.log(`  Entity IDs: ${status.entity_ids.join(', ')}`);
              console.log(`  Interval: ${status.interval_ms}ms`);
              console.log(`  Ticks: ${status.tick_count}`);
              console.log(`  Adaptive: ${status.adaptive}`);
              if (status.last_tick) console.log(`  Last tick: ${status.last_tick}`);
            }
          } catch {
            console.log('Watcher: unable to reach engine');
            return;
          }

          try {
            const history = await client.watcherHistory({ limit });
            if (history.ticks.length > 0) {
              console.log(`\nRecent ticks (${history.ticks.length} of ${history.total}):`);
              for (const tick of history.ticks) {
                const acted = tick.should_act ? 'ACT' : 'skip';
                console.log(
                  `  #${tick.tick_number} [${acted}] signals=${tick.signals_found} urgency=${tick.urgency ?? 'none'} | ${tick.decision_reason}`,
                );
              }
            }
          } catch {
            // History endpoint may not be available
          }
        });

      // === Heartbeat commands ===

      memory
        .command('heartbeat')
        .description('Run a heartbeat check and show active signals')
        .action(async () => {
          const result = await client.heartbeatCheck(entityId);
          console.log(`Should act: ${result.should_act}`);

          const sections: [string, unknown[]][] = [
            ['Pending work', result.pending_work],
            ['Deadlines', result.deadlines],
            ['Scheduled', result.scheduled],
            ['Decaying', result.decaying],
            ['Conflicts', result.conflicts],
            ['Stale monitors', result.stale_monitors],
          ];

          for (const [label, items] of sections) {
            const arr = items as unknown[];
            if (arr && arr.length > 0) {
              console.log(`\n${label} (${arr.length}):`);
              for (const item of arr) {
                const m = item as { content: string; importance?: number };
                const imp = m.importance ? ` [${(m.importance * 100).toFixed(0)}%]` : '';
                console.log(`  ${imp} ${m.content.slice(0, 100)}`);
              }
            }
          }

          if (result.summary) console.log(`\nSummary: ${result.summary}`);
          if (result.priority_action) console.log(`Priority: ${result.priority_action}`);
        });

      // === Schedule commands ===

      memory
        .command('schedules')
        .description('List active scheduled tasks')
        .action(async () => {
          const schedules = await client.listSchedules(entityId);
          if (schedules.length === 0) {
            console.log('No active schedules.');
            return;
          }
          console.log(`Active schedules (${schedules.length}):`);
          for (const s of schedules) {
            const tags = s.tags?.join(', ') ?? '';
            console.log(`  [${s.id}] ${s.content.slice(0, 80)} ${tags ? `(${tags})` : ''}`);
          }
        });

      // === Health command ===

      memory
        .command('health')
        .description('Check engine health and memory stats')
        .action(async () => {
          try {
            const h = await client.health();
            console.log(`Engine: ${h.status} | SSE clients: ${h.sse_clients}`);
          } catch {
            console.log('Engine: unreachable');
            return;
          }

          try {
            const stats = await client.getStats(entityId);
            console.log(`Memories: ${stats.total_memories} total, ${stats.active_memories} active`);
            console.log(`By type: ${JSON.stringify(stats.by_type)}`);
            console.log(`By state: ${JSON.stringify(stats.by_state)}`);
          } catch {
            // Stats may fail if no entity
          }
        });
    },
    { commands: ['memory'] },
  );
}
