import { describe, it, expect } from 'vitest';
import {
  estimateSessionTokens,
  computeSessionBudget,
  classifyQueryStrength,
  adaptiveMinScore,
  extractKeyTerms,
  computeSessionOverlap,
  assessCaptureWorthiness,
  detectMemoryUsage,
} from '../src/session-budget.js';

describe('estimateSessionTokens', () => {
  it('returns 0 for empty messages', () => {
    expect(estimateSessionTokens([])).toBe(0);
  });

  it('estimates tokens from string content', () => {
    const messages = [
      { role: 'user', content: 'Hello world' }, // 11 chars
      { role: 'assistant', content: 'Hi there!' }, // 9 chars
    ];
    const tokens = estimateSessionTokens(messages);
    // (11 + 9) / 3.5 = ~6 tokens
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  it('estimates tokens from content block arrays', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First block' },
          { type: 'text', text: 'Second block' },
        ],
      },
    ];
    const tokens = estimateSessionTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('handles messages without content', () => {
    const messages = [{ role: 'user' }, { role: 'assistant', content: 'hi' }];
    expect(estimateSessionTokens(messages)).toBeGreaterThan(0);
  });

  it('scales roughly linearly with message count', () => {
    const oneMsg = [{ role: 'user', content: 'A'.repeat(100) }];
    const tenMsgs = Array.from({ length: 10 }, () => ({ role: 'user', content: 'A'.repeat(100) }));
    const t1 = estimateSessionTokens(oneMsg);
    const t10 = estimateSessionTokens(tenMsgs);
    // Allow small rounding variance from Math.ceil
    expect(t10).toBeGreaterThanOrEqual(t1 * 9);
    expect(t10).toBeLessThanOrEqual(t1 * 10 + 1);
  });
});

describe('computeSessionBudget', () => {
  it('returns full budget for empty session', () => {
    const budget = computeSessionBudget([], 5);
    expect(budget.headroom).toBe(1);
    expect(budget.effectiveTopK).toBe(5);
    expect(budget.allowHeartbeat).toBe(true);
    expect(budget.allowCapture).toBe(true);
    expect(budget.memoryBudget).toBeGreaterThan(0);
  });

  it('reduces topK as session fills', () => {
    // Create a large session (~100k tokens worth of content)
    const bigMessages = Array.from({ length: 500 }, () => ({
      role: 'user',
      content: 'A'.repeat(700), // ~200 tokens each → ~100k total
    }));
    const budget = computeSessionBudget(bigMessages, 5, 200_000, 20_000);
    expect(budget.effectiveTopK).toBeLessThan(5);
    expect(budget.headroom).toBeLessThan(1);
  });

  it('disables heartbeat below 20% headroom', () => {
    // ~160k tokens in session with 200k window
    const hugeMessages = Array.from({ length: 1600 }, () => ({
      role: 'user',
      content: 'A'.repeat(350),
    }));
    const budget = computeSessionBudget(hugeMessages, 5, 200_000, 20_000);
    expect(budget.allowHeartbeat).toBe(false);
  });

  it('disables capture below 10% headroom', () => {
    // ~170k tokens in session with 200k window
    const hugeMessages = Array.from({ length: 1700 }, () => ({
      role: 'user',
      content: 'A'.repeat(350),
    }));
    const budget = computeSessionBudget(hugeMessages, 5, 200_000, 20_000);
    expect(budget.allowCapture).toBe(false);
  });

  it('caps memory budget at 8000 tokens', () => {
    const budget = computeSessionBudget([], 5, 1_000_000, 20_000);
    expect(budget.memoryBudget).toBeLessThanOrEqual(8000);
  });
});

describe('classifyQueryStrength', () => {
  it('classifies trivial messages as weak', () => {
    expect(classifyQueryStrength('hi')).toBe('weak');
    expect(classifyQueryStrength('thanks')).toBe('weak');
    expect(classifyQueryStrength('ok')).toBe('weak');
    expect(classifyQueryStrength('yes')).toBe('weak');
    expect(classifyQueryStrength('go ahead')).toBe('weak');
    expect(classifyQueryStrength('sounds good')).toBe('weak');
  });

  it('classifies questions as strong', () => {
    expect(classifyQueryStrength('What is the deadline for the Q3 launch?')).toBe('strong');
    expect(classifyQueryStrength('How do I configure the heartbeat system?')).toBe('strong');
    expect(classifyQueryStrength('When is the meeting with Alice?')).toBe('strong');
  });

  it('classifies short questions as strong (not weak)', () => {
    expect(classifyQueryStrength('Why?')).toBe('strong');
    expect(classifyQueryStrength('What time?')).toBe('strong');
    expect(classifyQueryStrength('How?')).toBe('strong');
    expect(classifyQueryStrength('Who did it?')).toBe('strong');
  });

  it('classifies messages with proper nouns as strong', () => {
    expect(classifyQueryStrength('tell me about Alice and the project')).toBe('strong');
    expect(classifyQueryStrength('check on the Keyoku deployment status')).toBe('strong');
  });

  it('classifies medium-length messages as medium', () => {
    expect(classifyQueryStrength('update the configuration file')).toBe('medium');
    expect(classifyQueryStrength('check the latest logs please')).toBe('medium');
  });
});

describe('adaptiveMinScore', () => {
  it('returns lower threshold for strong queries', () => {
    expect(adaptiveMinScore('strong')).toBe(0.25);
  });

  it('returns higher threshold for medium queries', () => {
    expect(adaptiveMinScore('medium')).toBe(0.35);
  });

  it('returns 1.0 for weak queries (effectively skip)', () => {
    expect(adaptiveMinScore('weak')).toBe(1.0);
  });
});

describe('extractKeyTerms', () => {
  it('extracts words ≥4 chars', () => {
    const terms = extractKeyTerms('the quick brown fox jumped over the lazy dog');
    expect(terms.has('quick')).toBe(true);
    expect(terms.has('brown')).toBe(true);
    expect(terms.has('jumped')).toBe(true);
    expect(terms.has('lazy')).toBe(true); // 4 chars, not a stop word
    expect(terms.has('the')).toBe(false); // <4 chars
    expect(terms.has('fox')).toBe(false); // <4 chars
  });

  it('filters stop words', () => {
    const terms = extractKeyTerms('this is about what they have been doing');
    expect(terms.has('this')).toBe(false);
    expect(terms.has('about')).toBe(false);
    expect(terms.has('what')).toBe(false);
    expect(terms.has('they')).toBe(false);
    expect(terms.has('have')).toBe(false);
    expect(terms.has('been')).toBe(false);
    expect(terms.has('doing')).toBe(true); // not a stop word
  });

  it('lowercases everything', () => {
    const terms = extractKeyTerms('Alice works at Keyoku');
    expect(terms.has('alice')).toBe(true);
    expect(terms.has('works')).toBe(true);
    expect(terms.has('keyoku')).toBe(true);
  });

  it('returns empty set for empty input', () => {
    expect(extractKeyTerms('').size).toBe(0);
  });
});

describe('computeSessionOverlap', () => {
  it('returns 0 for empty messages', () => {
    expect(computeSessionOverlap('Alice works at Keyoku', [])).toBe(0);
  });

  it('returns 0 for no overlap', () => {
    const messages = [{ content: 'The weather is nice today' }];
    expect(computeSessionOverlap('Alice works at Keyoku', messages)).toBe(0);
  });

  it('returns high overlap when memory is redundant', () => {
    const messages = [
      { content: 'Alice mentioned she works at Keyoku as an engineer' },
    ];
    const overlap = computeSessionOverlap('Alice works at Keyoku', messages);
    expect(overlap).toBeGreaterThan(0.5);
  });

  it('only checks last N messages', () => {
    const old = Array.from({ length: 20 }, () => ({
      content: 'Alice works at Keyoku doing engineering',
    }));
    const recent = [{ content: 'The weather is nice today' }];
    const messages = [...old, ...recent];
    // maxMessages=1 should only check the last message
    const overlap = computeSessionOverlap('Alice works at Keyoku', messages, 1);
    expect(overlap).toBe(0);
  });
});

describe('assessCaptureWorthiness', () => {
  it('captures preference statements', () => {
    const result = assessCaptureWorthiness('I prefer TypeScript over JavaScript', 'Noted.');
    expect(result.shouldCapture).toBe(true);
    expect(result.reason).toBe('preference_signal');
  });

  it('captures corrections', () => {
    const result = assessCaptureWorthiness("No, that's wrong, it should be port 3000", 'I stand corrected.');
    expect(result.shouldCapture).toBe(true);
    expect(result.reason).toBe('correction_signal');
  });

  it('captures decisions', () => {
    const result = assessCaptureWorthiness("Let's go with option A for the deployment", 'Proceeding with option A.');
    expect(result.shouldCapture).toBe(true);
    expect(result.reason).toBe('decision_signal');
  });

  it('skips trivial exchanges', () => {
    const result = assessCaptureWorthiness('thanks', 'You are welcome!');
    expect(result.shouldCapture).toBe(false);
    expect(result.reason).toBe('trivial_user_message');
  });

  it('skips very short exchanges', () => {
    const result = assessCaptureWorthiness('ok sure', 'Done.');
    expect(result.shouldCapture).toBe(false);
    // "ok" matches trivial pattern before length check
    expect(result.reason).toBe('trivial_user_message');
  });

  it('defaults to capture for normal exchanges', () => {
    const result = assessCaptureWorthiness(
      'Can you check the deployment status of the keyoku engine?',
      'The deployment is running on v0.6.9 and all health checks pass.',
    );
    expect(result.shouldCapture).toBe(true);
    expect(result.reason).toBe('default');
  });
});

describe('detectMemoryUsage', () => {
  it('detects when a memory is referenced in response', () => {
    const memories = [
      { content: 'Alice works at Keyoku as a senior engineer', id: 'mem-1' },
      { content: 'Bob prefers Python for data science', id: 'mem-2' },
    ];
    const response = 'Alice is a senior engineer at Keyoku, so she would be the right person to ask.';
    const usage = detectMemoryUsage(memories, response);
    expect(usage[0].used).toBe(true); // Alice/Keyoku/engineer all appear
    expect(usage[1].used).toBe(false); // Bob/Python not mentioned
  });

  it('returns all unused for empty response', () => {
    const memories = [{ content: 'Some important fact', id: 'mem-1' }];
    const usage = detectMemoryUsage(memories, '');
    expect(usage[0].used).toBe(false);
  });

  it('handles empty memories array', () => {
    const usage = detectMemoryUsage([], 'Some response text');
    expect(usage).toHaveLength(0);
  });
});
