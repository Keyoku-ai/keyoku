/**
 * CLI subcommand registration for memory management.
 * Registers `memory` command with search, list, stats, clear subcommands.
 */

import type { KeyokuClient } from '@keyoku/memory';
import type { PluginApi, PluginLogger } from './types.js';
import { formatMemoryList } from './context.js';
import { importMemoryFiles } from './migration.js';

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
        .description('Import OpenClaw memory files (MEMORY.md, memory/*.md) into Keyoku')
        .option('--dir <path>', 'Workspace directory containing memory files', '.')
        .option('--dry-run', 'Show what would be imported without storing')
        .action(async (opts: unknown) => {
          const options = opts as { dir: string; dryRun?: boolean };
          const result = await importMemoryFiles({
            client,
            entityId,
            workspaceDir: options.dir,
            dryRun: options.dryRun,
            logger: console,
          });
          console.log(
            `\nImport complete: ${result.imported} imported, ${result.skipped} skipped, ${result.errors} errors`,
          );
        });
    },
    { commands: ['memory'] },
  );
}
