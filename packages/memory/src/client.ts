/**
 * Typed HTTP client for the Keyoku memory engine API
 */

import type {
  Memory,
  SearchResult,
  RememberResult,
  HeartbeatResult,
  HeartbeatContextResult,
  MemoryStats,
} from '@keyoku/types';

export { type Memory, type SearchResult, type RememberResult, type HeartbeatResult, type HeartbeatContextResult, type MemoryStats } from '@keyoku/types';

export class KeyokuError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly path: string,
  ) {
    super(`Keyoku error (${status}) on ${path}: ${message}`);
    this.name = 'KeyokuError';
  }
}

export class KeyokuClient {
  private baseUrl: string;
  private timeout: number;

  constructor(options: { baseUrl?: string; timeout?: number }) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:18900').replace(/\/$/, '');
    this.timeout = options.timeout ?? 10000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {};
      if (body) headers['Content-Type'] = 'application/json';

      const res = await fetch(url, {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new KeyokuError(res.status, (errBody as Record<string, string>).error || res.statusText, path);
      }

      return await res.json() as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // === Memory ===

  async remember(entityId: string, content: string, options?: {
    session_id?: string;
    agent_id?: string;
    source?: string;
    team_id?: string;
    visibility?: string;
  }): Promise<RememberResult> {
    return this.request<RememberResult>('POST', '/api/v1/remember', {
      entity_id: entityId,
      content,
      ...options,
    });
  }

  async search(entityId: string, query: string, options?: {
    limit?: number;
    mode?: string;
    agent_id?: string;
    team_aware?: boolean;
    min_score?: number;
  }): Promise<SearchResult[]> {
    return this.request<SearchResult[]>('POST', '/api/v1/search', {
      entity_id: entityId,
      query,
      ...options,
    });
  }

  async listMemories(entityId: string, limit = 100): Promise<Memory[]> {
    return this.request<Memory[]>('GET', `/api/v1/memories?entity_id=${entityId}&limit=${limit}`);
  }

  async getMemory(id: string): Promise<Memory> {
    return this.request<Memory>('GET', `/api/v1/memories/${id}`);
  }

  async deleteMemory(id: string): Promise<{ status: string }> {
    return this.request<{ status: string }>('DELETE', `/api/v1/memories/${id}`);
  }

  async deleteAllMemories(entityId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>('DELETE', '/api/v1/memories', { entity_id: entityId });
  }

  async getStats(entityId: string): Promise<MemoryStats> {
    return this.request<MemoryStats>('GET', `/api/v1/stats/${entityId}`);
  }

  // === Heartbeat ===

  async heartbeatCheck(entityId: string, options?: {
    deadline_window?: string;
    decay_threshold?: number;
    importance_floor?: number;
    max_results?: number;
    agent_id?: string;
    team_id?: string;
  }): Promise<HeartbeatResult> {
    return this.request<HeartbeatResult>('POST', '/api/v1/heartbeat/check', {
      entity_id: entityId,
      ...options,
    });
  }

  /** Combined heartbeat + context search in a single call, with optional LLM analysis. */
  async heartbeatContext(entityId: string, options?: {
    query?: string;
    top_k?: number;
    min_score?: number;
    deadline_window?: string;
    max_results?: number;
    agent_id?: string;
    team_id?: string;
    analyze?: boolean;
    activity_summary?: string;
    autonomy?: 'observe' | 'suggest' | 'act';
  }): Promise<HeartbeatContextResult> {
    return this.request<HeartbeatContextResult>('POST', '/api/v1/heartbeat/context', {
      entity_id: entityId,
      ...options,
    });
  }

  // === Schedules ===

  async createSchedule(entityId: string, agentId: string, content: string, cronTag: string): Promise<Memory> {
    return this.request<Memory>('POST', '/api/v1/schedule', {
      entity_id: entityId,
      agent_id: agentId,
      content,
      cron_tag: cronTag,
    });
  }

  async listSchedules(entityId: string, agentId?: string): Promise<Memory[]> {
    const params = new URLSearchParams({ entity_id: entityId });
    if (agentId) params.set('agent_id', agentId);
    return this.request<Memory[]>('GET', `/api/v1/scheduled?${params}`);
  }

  async ackSchedule(memoryId: string): Promise<{ status: string; memory_id: string }> {
    return this.request<{ status: string; memory_id: string }>('POST', '/api/v1/schedule/ack', {
      memory_id: memoryId,
    });
  }

  async cancelSchedule(id: string): Promise<{ status: string; memory_id: string }> {
    return this.request<{ status: string; memory_id: string }>('DELETE', `/api/v1/schedule/${id}`);
  }
}
