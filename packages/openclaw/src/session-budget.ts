/**
 * Session-aware context budget management.
 *
 * All heuristic — zero LLM calls. Provides:
 * - Token estimation from message arrays
 * - Headroom calculation (how much room the plugin can use)
 * - Query strength classification (should we even inject?)
 * - Session dedup (is a candidate memory redundant with recent conversation?)
 * - Capture worthiness pre-filter (is this exchange worth remembering?)
 */

// Average chars per token — conservative estimate (English text ~4 chars/token,
// but code/JSON can be 3). Using 3.5 to err on the safe side.
const CHARS_PER_TOKEN = 3.5;

/** Default context window size (tokens). */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Headroom reserved for model output generation. */
const DEFAULT_RESERVE_TOKENS = 20_000;

/** Max fraction of available budget the plugin should use for memory injection. */
const MAX_MEMORY_FRACTION = 0.15;

/** Absolute cap on memory injection tokens regardless of budget. */
const MAX_MEMORY_TOKENS = 8_000;

/**
 * Estimate token count from a message array.
 * Uses character-based heuristic — no tokenizer needed.
 */
export function estimateSessionTokens(messages: unknown[]): number {
  if (!Array.isArray(messages)) return 0;

  let totalChars = 0;
  for (const msg of messages) {
    const m = msg as { content?: string | Array<{ type?: string; text?: string }> };
    if (!m.content) continue;
    if (typeof m.content === 'string') {
      totalChars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.text) totalChars += block.text.length;
      }
    }
  }

  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

export interface SessionBudget {
  /** Estimated tokens currently in the session. */
  sessionTokens: number;
  /** Available token budget for the plugin to use. */
  availableBudget: number;
  /** Token budget specifically for memory injection. */
  memoryBudget: number;
  /** 0.0–1.0 ratio of how much room the session has. 1.0 = empty, 0.0 = full. */
  headroom: number;
  /** Recommended topK based on headroom. */
  effectiveTopK: number;
  /** Whether heartbeat injection should be allowed. */
  allowHeartbeat: boolean;
  /** Whether capture should be allowed. */
  allowCapture: boolean;
}

/**
 * Compute the session budget and adaptive limits.
 */
export function computeSessionBudget(
  messages: unknown[],
  configTopK: number,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  reserveTokens = DEFAULT_RESERVE_TOKENS,
): SessionBudget {
  const sessionTokens = estimateSessionTokens(messages);
  const usableWindow = contextWindow - reserveTokens;
  const availableBudget = Math.max(0, usableWindow - sessionTokens);
  const headroom = usableWindow > 0 ? Math.max(0, Math.min(1, availableBudget / usableWindow)) : 0;

  // Memory budget: fraction of available space, capped
  const memoryBudget = Math.min(
    Math.floor(availableBudget * MAX_MEMORY_FRACTION),
    MAX_MEMORY_TOKENS,
  );

  // Adaptive topK: scale with headroom
  const effectiveTopK = headroom > 0.1 ? Math.max(1, Math.round(configTopK * headroom)) : 0;

  // Heartbeat: skip below 20% headroom
  const allowHeartbeat = headroom > 0.2;

  // Capture: skip below 10% headroom
  const allowCapture = headroom > 0.1;

  return {
    sessionTokens,
    availableBudget,
    memoryBudget,
    headroom,
    effectiveTopK,
    allowHeartbeat,
    allowCapture,
  };
}

// --- Query Strength ---

export type QueryStrength = 'strong' | 'medium' | 'weak';

const WEAK_PATTERNS = /^(hi|hey|hello|thanks|thank you|ok|okay|yes|no|sure|cool|nice|bye|lol|haha|hmm|yep|nope|got it|sounds good|go ahead|do it|please)\s*[.!?]*$/i;
const FOLLOW_UP_PATTERNS = /^(yes|yeah|yep|do it|go ahead|please|sure|ok|okay|sounds good|let's do it|that works|perfect)\s*[.!?]*$/i;
const QUESTION_WORDS = /^(what|how|why|when|where|who|which|can|could|would|should|is|are|do|does|did|will)\b/i;

/**
 * Classify query strength to determine injection behavior.
 * - strong: specific query with entities/questions → full injection
 * - medium: moderate signal → standard injection
 * - weak: trivial/short → skip injection
 */
export function classifyQueryStrength(query: string): QueryStrength {
  const trimmed = query.trim();
  // Check question words BEFORE length gate — short questions like "Why?" are strong
  if (QUESTION_WORDS.test(trimmed)) return 'strong';
  if (WEAK_PATTERNS.test(trimmed)) return 'weak';
  if (trimmed.length < 15) return 'weak';
  if (FOLLOW_UP_PATTERNS.test(trimmed)) return 'weak';
  if (trimmed.length > 80) return 'strong';
  // Check for proper nouns (capitalized words not at start)
  const words = trimmed.split(/\s+/);
  const hasProperNoun = words.slice(1).some((w) => /^[A-Z][a-z]/.test(w));
  if (hasProperNoun) return 'strong';
  return 'medium';
}

/**
 * Compute adaptive min_score based on query strength.
 */
export function adaptiveMinScore(strength: QueryStrength): number {
  switch (strength) {
    case 'strong': return 0.25;
    case 'medium': return 0.35;
    case 'weak': return 1.0; // effectively skip
  }
}

// --- Session Dedup ---

const STOP_WORDS = new Set([
  'this', 'that', 'with', 'from', 'they', 'them', 'their', 'have', 'been',
  'will', 'would', 'could', 'should', 'about', 'which', 'there', 'where',
  'when', 'what', 'some', 'than', 'then', 'also', 'just', 'into', 'your',
  'more', 'very', 'most', 'each', 'only', 'over', 'such', 'here', 'does',
  'like', 'make', 'made', 'know', 'need', 'want', 'look', 'think', 'well',
]);

/**
 * Extract key terms from text for overlap detection.
 * Returns lowercase unique terms ≥4 chars (filters noise words).
 */
export function extractKeyTerms(text: string): Set<string> {
  const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? [];
  const terms = new Set<string>();
  for (const w of words) {
    if (!STOP_WORDS.has(w)) terms.add(w);
  }
  return terms;
}

/**
 * Check if a memory's content is redundant with recent conversation messages.
 * Returns overlap ratio 0.0–1.0.
 */
export function computeSessionOverlap(
  memoryContent: string,
  recentMessages: unknown[],
  maxMessages = 10,
): number {
  const memoryTerms = extractKeyTerms(memoryContent);
  if (memoryTerms.size === 0) return 0;

  // Collect terms from recent messages
  const recent = recentMessages.slice(-maxMessages);
  const sessionTerms = new Set<string>();
  for (const msg of recent) {
    const m = msg as { content?: string | Array<{ type?: string; text?: string }> };
    if (!m.content) continue;
    const text = typeof m.content === 'string'
      ? m.content
      : (m.content as Array<{ text?: string }>).map((b) => b.text ?? '').join(' ');
    for (const term of extractKeyTerms(text)) {
      sessionTerms.add(term);
    }
  }

  if (sessionTerms.size === 0) return 0;

  let overlap = 0;
  for (const term of memoryTerms) {
    if (sessionTerms.has(term)) overlap++;
  }

  return overlap / memoryTerms.size;
}

// --- Capture Intelligence ---

const TRIVIAL_EXCHANGES = /^(hi|hey|hello|thanks|thank you|ok|okay|yes|no|sure|cool|bye|goodbye|see you|take care|good morning|good night)\b/i;
const PREFERENCE_SIGNALS = /\b(i prefer|i like|i use|i want|i need|i always|i never|i usually|my favorite|i work at|i live in|my name is|call me|i'm a|i am a)\b/i;
const CORRECTION_SIGNALS = /\b(no[,.]? (that's|it's|actually)|wrong|incorrect|not right|the real|actually it's|correction)\b/i;
const DECISION_SIGNALS = /\b(let's go with|i decided|i'll go with|i choose|we should|i want to|let's do|the plan is)\b/i;

export interface CaptureDecision {
  /** Whether to capture this exchange. */
  shouldCapture: boolean;
  /** Reason for the decision. */
  reason: string;
}

/**
 * Pre-filter whether an exchange is worth sending to /remember.
 * Runs before the API call — saves engine work on trivial content.
 */
export function assessCaptureWorthiness(userContent: string, assistantContent: string): CaptureDecision {
  // Always capture preference statements, corrections, decisions
  if (PREFERENCE_SIGNALS.test(userContent)) {
    return { shouldCapture: true, reason: 'preference_signal' };
  }
  if (CORRECTION_SIGNALS.test(userContent) || CORRECTION_SIGNALS.test(assistantContent)) {
    return { shouldCapture: true, reason: 'correction_signal' };
  }
  if (DECISION_SIGNALS.test(userContent)) {
    return { shouldCapture: true, reason: 'decision_signal' };
  }

  // Skip trivial exchanges
  if (userContent.length < 30 && TRIVIAL_EXCHANGES.test(userContent.trim())) {
    return { shouldCapture: false, reason: 'trivial_user_message' };
  }

  // Skip very short exchanges with no signal
  if (userContent.length < 20 && assistantContent.length < 50) {
    return { shouldCapture: false, reason: 'exchange_too_short' };
  }

  // Default: capture (let the engine decide on dedup/significance)
  return { shouldCapture: true, reason: 'default' };
}

// --- Feedback Signal ---

/**
 * Check which injected memories were actually referenced in the model's response.
 * Uses key term overlap between each memory and the response text.
 * Returns memory content strings that were "used" (referenced).
 */
export function detectMemoryUsage(
  injectedMemories: Array<{ content: string; id?: string }>,
  responseText: string,
): Array<{ content: string; id?: string; used: boolean }> {
  const responseTerms = extractKeyTerms(responseText);
  if (responseTerms.size === 0) {
    return injectedMemories.map((m) => ({ ...m, used: false }));
  }

  return injectedMemories.map((memory) => {
    const memTerms = extractKeyTerms(memory.content);
    if (memTerms.size === 0) return { ...memory, used: false };

    let overlap = 0;
    for (const term of memTerms) {
      if (responseTerms.has(term)) overlap++;
    }
    // Consider "used" if >30% of memory terms appear in response
    const ratio = overlap / memTerms.size;
    return { ...memory, used: ratio > 0.3 };
  });
}
