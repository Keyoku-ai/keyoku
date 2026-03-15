import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeyokuClient, KeyokuError } from '../src/client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
  };
}

describe('KeyokuClient', () => {
  let client: KeyokuClient;

  beforeEach(() => {
    client = new KeyokuClient({ baseUrl: 'http://localhost:18900' });
    mockFetch.mockReset();
  });

  describe('constructor', () => {
    it('defaults to localhost:18900', () => {
      const c = new KeyokuClient({});
      mockFetch.mockResolvedValue(jsonResponse([]));
      c.listMemories('entity-1');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('http://localhost:18900');
    });

    it('strips trailing slash', () => {
      const c = new KeyokuClient({ baseUrl: 'http://example.com/' });
      mockFetch.mockResolvedValue(jsonResponse([]));
      c.listMemories('e1');

      const url = mockFetch.mock.calls[0][0];
      expect(url.startsWith('http://example.com/api')).toBe(true);
    });
  });

  describe('remember', () => {
    it('calls POST /api/v1/remember with content', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        memories_created: 1,
        memories_updated: 0,
        memories_deleted: 0,
        skipped: 0,
      }));

      const result = await client.remember('entity-1', 'Important fact', {
        agent_id: 'agent-1',
        team_id: 'team-1',
      });

      expect(result.memories_created).toBe(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.entity_id).toBe('entity-1');
      expect(body.content).toBe('Important fact');
      expect(body.agent_id).toBe('agent-1');
    });
  });

  describe('search', () => {
    it('calls POST /api/v1/search', async () => {
      mockFetch.mockResolvedValue(jsonResponse([
        { memory: { id: 'm1', content: 'test' }, similarity: 0.9, score: 0.85 },
      ]));

      const results = await client.search('entity-1', 'test query', { limit: 5 });

      expect(results).toHaveLength(1);
      expect(results[0].similarity).toBe(0.9);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.query).toBe('test query');
      expect(body.limit).toBe(5);
    });
  });

  describe('listMemories', () => {
    it('calls GET with entity_id and limit', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));

      await client.listMemories('entity-1', 50);

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('entity_id=entity-1');
      expect(url).toContain('limit=50');
    });

    it('defaults limit to 100', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));
      await client.listMemories('entity-1');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('limit=100');
    });
  });

  describe('getMemory', () => {
    it('calls GET /api/v1/memories/:id', async () => {
      const memory = { id: 'm1', content: 'test', entity_id: 'e1' };
      mockFetch.mockResolvedValue(jsonResponse(memory));

      const result = await client.getMemory('m1');
      expect(result.id).toBe('m1');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:18900/api/v1/memories/m1',
        expect.anything(),
      );
    });
  });

  describe('deleteMemory', () => {
    it('calls DELETE /api/v1/memories/:id', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 'deleted' }));

      const result = await client.deleteMemory('m1');
      expect(result.status).toBe('deleted');
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });
  });

  describe('deleteAllMemories', () => {
    it('calls DELETE with entity_id body', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 'deleted' }));

      await client.deleteAllMemories('entity-1');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.entity_id).toBe('entity-1');
    });
  });

  describe('getStats', () => {
    it('calls GET /api/v1/stats/:entityId', async () => {
      const stats = { total_memories: 42, active_memories: 30, by_type: {}, by_state: {} };
      mockFetch.mockResolvedValue(jsonResponse(stats));

      const result = await client.getStats('entity-1');
      expect(result.total_memories).toBe(42);
    });
  });

  describe('heartbeatCheck', () => {
    it('calls POST /api/v1/heartbeat/check', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        should_act: false,
        pending_work: [],
        deadlines: [],
        scheduled: [],
        decaying: [],
        conflicts: [],
        stale_monitors: [],
        summary: 'All clear',
      }));

      const result = await client.heartbeatCheck('entity-1', {
        deadline_window: '1h',
        max_results: 10,
      });

      expect(result.should_act).toBe(false);
      expect(result.summary).toBe('All clear');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.entity_id).toBe('entity-1');
      expect(body.deadline_window).toBe('1h');
    });
  });

  describe('schedules', () => {
    it('createSchedule sends correct body', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 's1' }));

      await client.createSchedule('entity-1', 'agent-1', 'Daily standup', 'daily');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.entity_id).toBe('entity-1');
      expect(body.agent_id).toBe('agent-1');
      expect(body.content).toBe('Daily standup');
      expect(body.cron_tag).toBe('daily');
    });

    it('listSchedules filters by agent', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));

      await client.listSchedules('entity-1', 'agent-1');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('entity_id=entity-1');
      expect(url).toContain('agent_id=agent-1');
    });

    it('ackSchedule calls POST', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 'acknowledged', memory_id: 'm1' }));

      const result = await client.ackSchedule('m1');
      expect(result.status).toBe('acknowledged');
    });

    it('cancelSchedule calls DELETE', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 'cancelled', memory_id: 's1' }));

      const result = await client.cancelSchedule('s1');
      expect(result.status).toBe('cancelled');
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });
  });

  describe('seed', () => {
    it('calls POST /api/v1/seed with memories array', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ created: 2, ids: ['m1', 'm2'] }));

      const result = await client.seed([
        { content: 'Fact one', entity_id: 'entity-1', type: 'identity', importance: 0.8 },
        { content: 'Fact two', entity_id: 'entity-1', tags: ['tag1'] },
      ]);

      expect(result.created).toBe(2);
      expect(result.ids).toEqual(['m1', 'm2']);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.memories).toHaveLength(2);
      expect(body.memories[0].content).toBe('Fact one');
      expect(body.memories[0].type).toBe('identity');
      expect(body.memories[1].tags).toEqual(['tag1']);
    });
  });

  describe('updateTags', () => {
    it('calls PUT /api/v1/memories/:id/tags', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        status: 'updated',
        memory_id: 'm1',
        tags: ['important', 'project-x'],
      }));

      const result = await client.updateTags('m1', ['important', 'project-x']);

      expect(result.status).toBe('updated');
      expect(result.tags).toEqual(['important', 'project-x']);
      expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/memories/m1/tags');
      expect(mockFetch.mock.calls[0][1].method).toBe('PUT');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tags).toEqual(['important', 'project-x']);
    });
  });

  describe('listEntities', () => {
    it('calls GET /api/v1/entities', async () => {
      mockFetch.mockResolvedValue(jsonResponse(['entity-1', 'entity-2', 'entity-3']));

      const result = await client.listEntities();

      expect(result).toEqual(['entity-1', 'entity-2', 'entity-3']);
      expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/entities');
      expect(mockFetch.mock.calls[0][1].method).toBe('GET');
    });
  });

  describe('getGlobalStats', () => {
    it('calls GET /api/v1/stats (no entity_id)', async () => {
      const stats = {
        total_memories: 100,
        active_memories: 80,
        entity_count: 5,
        by_type: { identity: 20, preference: 30 },
        by_state: { active: 80, archived: 20 },
      };
      mockFetch.mockResolvedValue(jsonResponse(stats));

      const result = await client.getGlobalStats();

      expect(result.total_memories).toBe(100);
      expect(result.entity_count).toBe(5);
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:18900/api/v1/stats');
    });
  });

  describe('sampleMemories', () => {
    it('calls GET /api/v1/memories/sample with params', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ id: 'm1', content: 'sample' }]));

      const result = await client.sampleMemories({ entity_id: 'entity-1', limit: 10 });

      expect(result).toHaveLength(1);
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/api/v1/memories/sample');
      expect(url).toContain('entity_id=entity-1');
      expect(url).toContain('limit=10');
    });

    it('works without params', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));

      await client.sampleMemories();

      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe('http://localhost:18900/api/v1/memories/sample');
    });
  });

  describe('consolidate', () => {
    it('calls POST /api/v1/consolidate', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 'ok' }));

      const result = await client.consolidate();

      expect(result.status).toBe('ok');
      expect(mockFetch.mock.calls[0][1].method).toBe('POST');
      expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/consolidate');
    });
  });

  describe('updateSchedule', () => {
    it('calls PUT /api/v1/schedule/:id', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 's1', content: 'Updated task' }));

      const result = await client.updateSchedule('s1', 'weekly', 'Updated task');

      expect(result.id).toBe('s1');
      expect(mockFetch.mock.calls[0][1].method).toBe('PUT');
      expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/schedule/s1');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.cron_tag).toBe('weekly');
      expect(body.new_content).toBe('Updated task');
    });

    it('omits new_content when undefined', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 's1' }));

      await client.updateSchedule('s1', 'daily');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.cron_tag).toBe('daily');
      expect(body).not.toHaveProperty('new_content');
    });
  });

  describe('watcherWatch', () => {
    it('calls POST /api/v1/watcher/watch', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 'watching', entity_id: 'entity-1' }));

      const result = await client.watcherWatch('entity-1');

      expect(result.status).toBe('watching');
      expect(result.entity_id).toBe('entity-1');
      expect(mockFetch.mock.calls[0][1].method).toBe('POST');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.entity_id).toBe('entity-1');
    });
  });

  describe('watcherUnwatch', () => {
    it('calls POST /api/v1/watcher/unwatch', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 'unwatched', entity_id: 'entity-1' }));

      const result = await client.watcherUnwatch('entity-1');

      expect(result.status).toBe('unwatched');
      expect(result.entity_id).toBe('entity-1');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.entity_id).toBe('entity-1');
    });
  });

  describe('watcherStatus', () => {
    it('calls GET /api/v1/watcher/status', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        running: true,
        entity_ids: ['entity-1'],
        interval_ms: 300000,
        tick_count: 42,
        last_tick: '2026-03-14T10:00:00Z',
        adaptive: true,
      }));

      const result = await client.watcherStatus();

      expect(result.running).toBe(true);
      expect(result.entity_ids).toEqual(['entity-1']);
      expect(result.tick_count).toBe(42);
      expect(mockFetch.mock.calls[0][1].method).toBe('GET');
    });
  });

  describe('watcherHistory', () => {
    it('calls GET /api/v1/watcher/history with limit', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        ticks: [{ tick_number: 1, entity_id: 'e1', signals_found: 0, should_act: false }],
        total: 100,
      }));

      const result = await client.watcherHistory({ limit: 5 });

      expect(result.total).toBe(100);
      expect(result.ticks).toHaveLength(1);
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('limit=5');
    });
  });

  describe('teams', () => {
    it('createTeam sends name and description', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        id: 't1',
        name: 'Engineering',
        description: 'Engineering team',
        default_visibility: 'team',
        created_at: '2026-03-14T10:00:00Z',
        updated_at: '2026-03-14T10:00:00Z',
      }));

      const result = await client.createTeam('Engineering', 'Engineering team');

      expect(result.id).toBe('t1');
      expect(result.name).toBe('Engineering');
      expect(mockFetch.mock.calls[0][1].method).toBe('POST');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.name).toBe('Engineering');
      expect(body.description).toBe('Engineering team');
    });

    it('getTeam calls GET /api/v1/teams/:id', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        id: 't1',
        name: 'Engineering',
        description: 'Eng team',
        default_visibility: 'team',
        created_at: '2026-03-14T10:00:00Z',
        updated_at: '2026-03-14T10:00:00Z',
      }));

      const result = await client.getTeam('t1');

      expect(result.id).toBe('t1');
      expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/teams/t1');
    });

    it('deleteTeam calls DELETE /api/v1/teams/:id', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 'deleted' }));

      const result = await client.deleteTeam('t1');

      expect(result.status).toBe('deleted');
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });

    it('addTeamMember sends agent_id', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        status: 'added',
        team_id: 't1',
        agent_id: 'agent-1',
      }));

      const result = await client.addTeamMember('t1', 'agent-1');

      expect(result.status).toBe('added');
      expect(result.agent_id).toBe('agent-1');
      expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/teams/t1/members');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.agent_id).toBe('agent-1');
    });

    it('listTeamMembers calls GET', async () => {
      mockFetch.mockResolvedValue(jsonResponse([
        { team_id: 't1', agent_id: 'agent-1', role: 'member', joined_at: '2026-03-14T10:00:00Z' },
        { team_id: 't1', agent_id: 'agent-2', role: 'member', joined_at: '2026-03-14T11:00:00Z' },
      ]));

      const result = await client.listTeamMembers('t1');

      expect(result).toHaveLength(2);
      expect(result[0].agent_id).toBe('agent-1');
      expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/teams/t1/members');
    });

    it('removeTeamMember calls DELETE with agent_id in path', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 'removed' }));

      const result = await client.removeTeamMember('t1', 'agent-1');

      expect(result.status).toBe('removed');
      expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/teams/t1/members/agent-1');
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });
  });

  describe('health', () => {
    it('calls GET /api/v1/health', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        status: 'ok',
        timestamp: '2026-03-14T10:00:00Z',
        sse_clients: 2,
      }));

      const result = await client.health();

      expect(result.status).toBe('ok');
      expect(result.sse_clients).toBe(2);
      expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/health');
    });
  });

  describe('subscribeEvents', () => {
    it('connects to SSE endpoint with auth header', async () => {
      const authedClient = new KeyokuClient({
        baseUrl: 'http://localhost:18900',
        token: 'test-token',
      });

      const mockReader = {
        read: vi.fn()
          .mockResolvedValueOnce({
            done: false,
            value: new TextEncoder().encode('event: connected\ndata: {"status":"ok"}\n\n'),
          })
          .mockResolvedValueOnce({
            done: false,
            value: new TextEncoder().encode('event: heartbeat\ndata: {"type":"heartbeat","entity_id":"e1"}\n\n'),
          })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      };

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        body: { getReader: () => mockReader },
      });

      const events: unknown[] = [];
      const cancel = authedClient.subscribeEvents({
        onEvent: (event) => events.push(event),
      });

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/events');
      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
      expect(mockFetch.mock.calls[0][1].headers.Accept).toBe('text/event-stream');
      expect(events).toHaveLength(2);
      expect((events[0] as { event: string }).event).toBe('connected');
      expect((events[1] as { event: string }).event).toBe('heartbeat');

      cancel();
    });

    it('calls onError for non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        body: null,
      });

      const errors: Error[] = [];
      client.subscribeEvents({
        onError: (err) => errors.push(err),
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(KeyokuError);
    });
  });

  describe('error handling', () => {
    it('throws KeyokuError on non-OK response', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: 'Not found' }, 404));

      await expect(client.getMemory('bad-id')).rejects.toThrow(KeyokuError);
    });

    it('includes status and path in error', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: 'Server error' }, 500));

      try {
        await client.getStats('e1');
      } catch (err) {
        expect(err).toBeInstanceOf(KeyokuError);
        expect((err as KeyokuError).status).toBe(500);
        expect((err as KeyokuError).path).toContain('/api/v1/stats/e1');
      }
    });
  });
});
