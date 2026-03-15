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

export {
  type Memory,
  type SearchResult,
  type RememberResult,
  type HeartbeatResult,
  type HeartbeatContextResult,
  type MemoryStats,
} from '@keyoku/types';

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
  private token?: string;
  private tokenFn?: () => string | undefined;

  constructor(options: {
    baseUrl?: string;
    timeout?: number;
    token?: string | (() => string | undefined);
  }) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:18900').replace(/\/$/, '');
    this.timeout = options.timeout ?? 30000;
    if (typeof options.token === 'function') {
      this.tokenFn = options.token;
    } else {
      this.token = options.token;
    }
  }

  private resolveToken(): string | undefined {
    return this.tokenFn ? this.tokenFn() : this.token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const token = this.resolveToken();

    try {
      const headers: Record<string, string> = {};
      if (body) headers['Content-Type'] = 'application/json';
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(url, {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new KeyokuError(
          res.status,
          (errBody as Record<string, string>).error || res.statusText,
          path,
        );
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // === Memory ===

  async remember(
    entityId: string,
    content: string,
    options?: {
      session_id?: string;
      agent_id?: string;
      source?: string;
      team_id?: string;
      visibility?: string;
    },
  ): Promise<RememberResult> {
    return this.request<RememberResult>('POST', '/api/v1/remember', {
      entity_id: entityId,
      content,
      ...options,
    });
  }

  async search(
    entityId: string,
    query: string,
    options?: {
      limit?: number;
      mode?: string;
      agent_id?: string;
      team_aware?: boolean;
      min_score?: number;
    },
  ): Promise<SearchResult[]> {
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

  async seed(memories: SeedMemoryInput[]): Promise<SeedResult> {
    return this.request<SeedResult>('POST', '/api/v1/seed', { memories });
  }

  async updateTags(id: string, tags: string[]): Promise<UpdateTagsResult> {
    return this.request<UpdateTagsResult>('PUT', `/api/v1/memories/${id}/tags`, { tags });
  }

  async listEntities(): Promise<string[]> {
    return this.request<string[]>('GET', '/api/v1/entities');
  }

  async getStats(entityId: string): Promise<MemoryStats> {
    return this.request<MemoryStats>('GET', `/api/v1/stats/${entityId}`);
  }

  async getGlobalStats(): Promise<GlobalStats> {
    return this.request<GlobalStats>('GET', '/api/v1/stats');
  }

  async sampleMemories(options?: {
    entity_id?: string;
    limit?: number;
  }): Promise<Memory[]> {
    const params = new URLSearchParams();
    if (options?.entity_id) params.set('entity_id', options.entity_id);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    return this.request<Memory[]>('GET', `/api/v1/memories/sample${qs ? `?${qs}` : ''}`);
  }

  async consolidate(): Promise<{ status: string }> {
    return this.request<{ status: string }>('POST', '/api/v1/consolidate');
  }

  // === Heartbeat ===

  async heartbeatCheck(
    entityId: string,
    options?: {
      deadline_window?: string;
      decay_threshold?: number;
      importance_floor?: number;
      max_results?: number;
      agent_id?: string;
      team_id?: string;
    },
  ): Promise<HeartbeatResult> {
    return this.request<HeartbeatResult>('POST', '/api/v1/heartbeat/check', {
      entity_id: entityId,
      ...options,
    });
  }

  /** Combined heartbeat + context search in a single call, with optional LLM analysis. */
  async heartbeatContext(
    entityId: string,
    options?: {
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
      in_conversation?: boolean;
    },
  ): Promise<HeartbeatContextResult> {
    return this.request<HeartbeatContextResult>('POST', '/api/v1/heartbeat/context', {
      entity_id: entityId,
      ...options,
    });
  }

  async recordHeartbeatMessage(
    entityId: string,
    message: string,
    options?: {
      agent_id?: string;
      action_id?: string;
    },
  ): Promise<{ status: string; id: string }> {
    return this.request<{ status: string; id: string }>(
      'POST',
      '/api/v1/heartbeat/record-message',
      {
        entity_id: entityId,
        message,
        ...options,
      },
    );
  }

  // === Schedules ===

  async createSchedule(
    entityId: string,
    agentId: string,
    content: string,
    cronTag: string,
  ): Promise<Memory> {
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

  async updateSchedule(
    id: string,
    cronTag: string,
    newContent?: string,
  ): Promise<Memory> {
    return this.request<Memory>('PUT', `/api/v1/schedule/${id}`, {
      cron_tag: cronTag,
      ...(newContent !== undefined && { new_content: newContent }),
    });
  }

  async cancelSchedule(id: string): Promise<{ status: string; memory_id: string }> {
    return this.request<{ status: string; memory_id: string }>('DELETE', `/api/v1/schedule/${id}`);
  }

  // === Watcher ===

  async watcherStatus(): Promise<WatcherStatus> {
    return this.request<WatcherStatus>('GET', '/api/v1/watcher/status');
  }

  async watcherHistory(options?: { limit?: number }): Promise<WatcherTickHistory> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    return this.request<WatcherTickHistory>('GET', `/api/v1/watcher/history${qs ? `?${qs}` : ''}`);
  }

  async watcherStart(
    entityIds: string[],
    options?: { interval_ms?: number },
  ): Promise<{ status: string }> {
    return this.request<{ status: string }>('POST', '/api/v1/watcher/start', {
      entity_ids: entityIds,
      ...options,
    });
  }

  async watcherStop(): Promise<{ status: string }> {
    return this.request<{ status: string }>('POST', '/api/v1/watcher/stop');
  }

  async watcherWatch(entityId: string): Promise<{ status: string; entity_id: string }> {
    return this.request<{ status: string; entity_id: string }>('POST', '/api/v1/watcher/watch', {
      entity_id: entityId,
    });
  }

  async watcherUnwatch(entityId: string): Promise<{ status: string; entity_id: string }> {
    return this.request<{ status: string; entity_id: string }>('POST', '/api/v1/watcher/unwatch', {
      entity_id: entityId,
    });
  }

  // === Teams ===

  async createTeam(name: string, description: string): Promise<Team> {
    return this.request<Team>('POST', '/api/v1/teams', { name, description });
  }

  async getTeam(id: string): Promise<Team> {
    return this.request<Team>('GET', `/api/v1/teams/${id}`);
  }

  async deleteTeam(id: string): Promise<{ status: string }> {
    return this.request<{ status: string }>('DELETE', `/api/v1/teams/${id}`);
  }

  async addTeamMember(
    teamId: string,
    agentId: string,
  ): Promise<{ status: string; team_id: string; agent_id: string }> {
    return this.request<{ status: string; team_id: string; agent_id: string }>(
      'POST',
      `/api/v1/teams/${teamId}/members`,
      { agent_id: agentId },
    );
  }

  async listTeamMembers(teamId: string): Promise<TeamMember[]> {
    return this.request<TeamMember[]>('GET', `/api/v1/teams/${teamId}/members`);
  }

  async removeTeamMember(teamId: string, agentId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(
      'DELETE',
      `/api/v1/teams/${teamId}/members/${agentId}`,
    );
  }

  // === Events (SSE) ===

  subscribeEvents(options?: {
    onEvent?: (event: SSEEvent) => void;
    onError?: (error: Error) => void;
    signal?: AbortSignal;
  }): () => void {
    const url = `${this.baseUrl}/api/v1/events`;
    const controller = new AbortController();
    const token = this.resolveToken();

    const connect = async () => {
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(url, {
          headers,
          signal: options?.signal ?? controller.signal,
        });

        if (!res.ok || !res.body) {
          options?.onError?.(new KeyokuError(res.status, res.statusText, '/api/v1/events'));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let eventType = '';
        let eventData = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7);
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6);
            } else if (line === '') {
              if (eventType && eventData) {
                try {
                  const parsed = JSON.parse(eventData);
                  options?.onEvent?.({ event: eventType, ...parsed });
                } catch {
                  options?.onEvent?.({ event: eventType, data: eventData });
                }
              }
              eventType = '';
              eventData = '';
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          options?.onError?.(err as Error);
        }
      }
    };

    connect();
    return () => controller.abort();
  }

  // === Health ===

  async health(): Promise<{ status: string; timestamp: string; sse_clients: number }> {
    return this.request<{ status: string; timestamp: string; sse_clients: number }>(
      'GET',
      '/api/v1/health',
    );
  }
}

// Seed types
export interface SeedMemoryInput {
  content: string;
  type?: string;
  importance?: number;
  entity_id: string;
  agent_id?: string;
  tags?: string[];
  expires_at?: string;
  sentiment?: number;
  confidence_factors?: string[];
  created_at?: string;
}

export interface SeedResult {
  created: number;
  ids: string[];
}

export interface UpdateTagsResult {
  status: string;
  memory_id: string;
  tags: string[];
}

export interface GlobalStats {
  total_memories: number;
  active_memories: number;
  entity_count: number;
  by_type: Record<string, number>;
  by_state: Record<string, number>;
}

// Team types
export interface Team {
  id: string;
  name: string;
  description: string;
  default_visibility: string;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  team_id: string;
  agent_id: string;
  role: string;
  joined_at: string;
}

// SSE types
export interface SSEEvent {
  event: string;
  type?: string;
  entity_id?: string;
  agent_id?: string;
  data?: unknown;
  timestamp?: string;
  [key: string]: unknown;
}

// Watcher types
export interface WatcherStatus {
  running: boolean;
  entity_ids: string[];
  interval_ms: number;
  tick_count: number;
  last_tick?: string;
  adaptive: boolean;
}

export interface WatcherTick {
  tick_number: number;
  timestamp: string;
  entity_id: string;
  signals_found: number;
  should_act: boolean;
  decision_reason: string;
  urgency?: string;
  interval_ms: number;
}

export interface WatcherTickHistory {
  ticks: WatcherTick[];
  total: number;
}
