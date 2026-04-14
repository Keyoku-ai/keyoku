import type { KeyokuClient } from '@keyoku/memory';
import type { EntityResolver } from './entity-resolver.js';
import type {
  MemoryPluginRuntime,
  MemoryRuntimeBackendConfig,
  MemorySearchManager,
  MemorySearchResult,
  PluginLogger,
} from './types.js';

class KeyokuMemorySearchManager implements MemorySearchManager {
  constructor(
    private readonly client: KeyokuClient,
    private readonly entityId: string,
    private readonly keyokuUrl: string,
  ) {}

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
    },
  ): Promise<MemorySearchResult[]> {
    const results = await this.client.search(this.entityId, query, {
      limit: opts?.maxResults,
      min_score: opts?.minScore,
    });

    return results.map((r) => ({
      path: `mem:${r.memory.id}`,
      startLine: 1,
      endLine: 1,
      score: r.score ?? r.similarity ?? 0,
      snippet: r.memory.content,
      source: 'memory',
      citation: `mem:${r.memory.id}`,
    }));
  }

  async readFile(params: { relPath: string }): Promise<{ text: string; path: string }> {
    const relPath = params.relPath ?? '';
    if (!relPath.startsWith('mem:')) {
      throw new Error('keyoku runtime only supports mem:<id> paths');
    }
    const id = relPath.slice(4).trim();
    if (!id) {
      throw new Error('memory id is required');
    }
    const memory = await this.client.getMemory(id);
    return {
      text: memory.content,
      path: relPath,
    };
  }

  status() {
    return {
      backend: 'qmd' as const,
      provider: 'keyoku',
      sources: ['memory'] as Array<'memory' | 'sessions'>,
      custom: {
        keyokuUrl: this.keyokuUrl,
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.search(this.entityId, 'health', { limit: 1 });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    const probe = await this.probeEmbeddingAvailability();
    return probe.ok;
  }

  async close(): Promise<void> {
    return;
  }
}

export function createMemoryRuntime(params: {
  client: KeyokuClient;
  resolver: EntityResolver;
  entityBase: string;
  keyokuUrl: string;
  logger: PluginLogger;
}): MemoryPluginRuntime {
  return {
    async getMemorySearchManager() {
      try {
        const entityId = params.resolver.resolve({}, 'tool') || params.entityBase || 'default';
        return {
          manager: new KeyokuMemorySearchManager(params.client, entityId, params.keyokuUrl),
        };
      } catch (err) {
        return {
          manager: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    resolveMemoryBackendConfig(): MemoryRuntimeBackendConfig {
      return {
        backend: 'qmd',
        qmd: {
          command: process.env.KEYOKU_ENGINE_BIN || 'keyoku',
        },
      };
    },

    async closeAllMemorySearchManagers() {
      params.logger.debug?.('keyoku: memory runtime closeAllMemorySearchManagers noop');
    },
  };
}
