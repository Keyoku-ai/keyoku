import { describe, it, expect } from 'vitest';
import {
  escapeMemoryText,
  formatMemoryContext,
  formatHeartbeatContext,
  formatMemoryList,
} from '../src/context.js';
import type { SearchResult, HeartbeatContextResult, Memory } from '@keyoku/types';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'm1',
    entity_id: 'e1',
    agent_id: 'a1',
    team_id: 't1',
    visibility: 'private',
    content: 'test content',
    type: 'fact',
    state: 'active',
    importance: 0.7,
    confidence: 0.9,
    sentiment: 0.5,
    tags: [],
    access_count: 0,
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
    last_accessed_at: '2024-01-01',
    expires_at: null,
    ...overrides,
  };
}

describe('context', () => {
  describe('escapeMemoryText', () => {
    it('escapes angle brackets', () => {
      expect(escapeMemoryText('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('passes through safe text', () => {
      expect(escapeMemoryText('Hello world')).toBe('Hello world');
    });
  });

  describe('formatMemoryContext', () => {
    it('returns empty string for no results', () => {
      expect(formatMemoryContext([])).toBe('');
    });

    it('formats search results with similarity scores', () => {
      const results: SearchResult[] = [
        { memory: makeMemory({ content: 'User likes TypeScript' }), similarity: 0.92, score: 0.85 },
        { memory: makeMemory({ content: 'Project uses vitest' }), similarity: 0.87, score: 0.80 },
      ];

      const ctx = formatMemoryContext(results);
      expect(ctx).toContain('<your-memories>');
      expect(ctx).toContain('92%');
      expect(ctx).toContain('User likes TypeScript');
      expect(ctx).toContain('87%');
      expect(ctx).toContain('Project uses vitest');
      expect(ctx).toContain('Use them naturally');
    });

    it('escapes dangerous content in memories', () => {
      const results: SearchResult[] = [
        { memory: makeMemory({ content: '<script>hack</script>' }), similarity: 0.9, score: 0.8 },
      ];

      const ctx = formatMemoryContext(results);
      expect(ctx).not.toContain('<script>');
      expect(ctx).toContain('&lt;script&gt;');
    });
  });

  describe('formatHeartbeatContext', () => {
    it('returns empty string when nothing to report', () => {
      const hb: HeartbeatContextResult = {
        should_act: false,
        pending_work: [],
        deadlines: [],
        scheduled: [],
        conflicts: [],
        relevant_memories: [],
        summary: 'All clear',
      };

      expect(formatHeartbeatContext(hb)).toBe('');
    });

    it('formats deadlines section', () => {
      const hb: HeartbeatContextResult = {
        should_act: true,
        pending_work: [],
        deadlines: [makeMemory({ content: 'Report due', expires_at: '2024-03-15' })],
        scheduled: [],
        conflicts: [],
        relevant_memories: [],
        summary: 'Deadline approaching',
      };

      const ctx = formatHeartbeatContext(hb);
      expect(ctx).toContain('<heartbeat-signals>');
      expect(ctx).toContain('</heartbeat-signals>');
      expect(ctx).toContain('DEADLINE:');
      expect(ctx).toContain('Report due');
      expect(ctx).toContain('2024-03-15');
    });

    it('formats scheduled section', () => {
      const hb: HeartbeatContextResult = {
        should_act: true,
        pending_work: [],
        deadlines: [],
        scheduled: [makeMemory({ content: 'Daily standup' })],
        conflicts: [],
        relevant_memories: [],
        summary: 'Schedule due',
      };

      const ctx = formatHeartbeatContext(hb);
      expect(ctx).toContain('DUE NOW:');
      expect(ctx).toContain('Daily standup');
    });

    it('formats conflicts', () => {
      const hb: HeartbeatContextResult = {
        should_act: true,
        pending_work: [],
        deadlines: [],
        scheduled: [],
        conflicts: [{ memory: makeMemory({ content: 'A says X' }), reason: 'Contradicts B' }],
        relevant_memories: [],
        summary: 'Conflict detected',
      };

      const ctx = formatHeartbeatContext(hb);
      expect(ctx).toContain('Conflict:');
      expect(ctx).toContain('Contradicts B');
    });

    it('formats pending work', () => {
      const hb: HeartbeatContextResult = {
        should_act: true,
        pending_work: [makeMemory({ content: 'Finish review' })],
        deadlines: [],
        scheduled: [],
        conflicts: [],
        relevant_memories: [],
        summary: 'Work pending',
      };

      const ctx = formatHeartbeatContext(hb);
      expect(ctx).toContain('Active tasks:');
      expect(ctx).toContain('Finish review');
    });

    it('formats relevant memories', () => {
      const hb: HeartbeatContextResult = {
        should_act: true,
        pending_work: [],
        deadlines: [],
        scheduled: [],
        conflicts: [],
        relevant_memories: [
          { memory: makeMemory({ content: 'Related context' }), similarity: 0.85, score: 0.8 },
        ],
        summary: 'Memories found',
      };

      const ctx = formatHeartbeatContext(hb);
      expect(ctx).toContain('What you know about them:');
      expect(ctx).toContain('Related context');
    });

    it('includes heartbeat-signals tags in raw signal mode', () => {
      const hb: HeartbeatContextResult = {
        should_act: true,
        pending_work: [makeMemory({ content: 'Something to do' })],
        deadlines: [],
        scheduled: [],
        conflicts: [],
        relevant_memories: [],
        summary: 'Work pending',
      };

      const ctx = formatHeartbeatContext(hb);
      expect(ctx).toContain('<heartbeat-signals>');
      expect(ctx).toContain('</heartbeat-signals>');
      expect(ctx).toContain('Something to do');
    });

    it('formats analyzed heartbeat with action brief', () => {
      const hb: HeartbeatContextResult = {
        should_act: true,
        pending_work: [],
        deadlines: [],
        scheduled: [],
        conflicts: [],
        relevant_memories: [],
        summary: 'Action needed',
        analysis: {
          should_act: true,
          action_brief: 'User has a meeting in 10 minutes',
          recommended_actions: ['Remind user about the meeting'],
          urgency: 'high',
          reasoning: 'Calendar event approaching',
          autonomy: 'suggest',
          user_facing: 'You have a meeting coming up soon!',
        },
      };

      const ctx = formatHeartbeatContext(hb);
      expect(ctx).toContain('<heartbeat-signals>');
      expect(ctx).toContain('User has a meeting in 10 minutes');
      expect(ctx).toContain('Key message: You have a meeting coming up soon!');
      expect(ctx).toContain('Remind user about the meeting');
    });

    it('returns empty for analysis with nothing to do', () => {
      const hb: HeartbeatContextResult = {
        should_act: false,
        pending_work: [],
        deadlines: [],
        scheduled: [],
        conflicts: [],
        relevant_memories: [],
        summary: 'All clear',
        analysis: {
          should_act: false,
          action_brief: '',
          recommended_actions: [],
          urgency: 'none',
          reasoning: 'Nothing notable',
          autonomy: 'observe',
          user_facing: '',
        },
      };

      expect(formatHeartbeatContext(hb)).toBe('');
    });
  });

  describe('formatMemoryList', () => {
    it('returns message for empty list', () => {
      expect(formatMemoryList([])).toBe('No memories found.');
    });

    it('formats memories with index and type', () => {
      const memories = [
        makeMemory({ type: 'fact', content: 'First memory' }),
        makeMemory({ type: 'preference', content: 'Second memory' }),
      ];

      const result = formatMemoryList(memories);
      expect(result).toContain('1. [fact] First memory');
      expect(result).toContain('2. [preference] Second memory');
    });

    it('truncates long content', () => {
      const longContent = 'A'.repeat(200);
      const memories = [makeMemory({ content: longContent })];

      const result = formatMemoryList(memories);
      expect(result).toContain('...');
      expect(result.length).toBeLessThan(200);
    });
  });
});
