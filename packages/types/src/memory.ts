/**
 * Keyoku memory engine types
 */

export interface Memory {
  id: string;
  entity_id: string;
  agent_id: string;
  team_id: string;
  visibility: string;
  content: string;
  type: string;
  state: string;
  importance: number;
  confidence: number;
  sentiment: number;
  tags: string[];
  access_count: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  expires_at: string | null;
}

export interface SearchResult {
  memory: Memory;
  similarity: number;
  score: number;
}

export interface RememberResult {
  memories_created: number;
  memories_updated: number;
  memories_deleted: number;
  skipped: number;
}

export interface HeartbeatResult {
  should_act: boolean;
  pending_work: Memory[];
  deadlines: Memory[];
  scheduled: Memory[];
  decaying: Memory[];
  conflicts: Array<{ memory: Memory; reason: string }>;
  stale_monitors: Memory[];
  summary: string;
  priority_action?: string;
  action_items?: string[];
  urgency?: 'immediate' | 'soon' | 'can_wait';
}

export interface HeartbeatAnalysis {
  should_act: boolean;
  action_brief: string;
  recommended_actions: string[];
  urgency: 'none' | 'low' | 'medium' | 'high' | 'critical';
  reasoning: string;
  autonomy: 'observe' | 'suggest' | 'act';
  user_facing: string;
}

export interface GoalProgress {
  plan: Memory;
  activities: Memory[];
  progress: number;
  days_left: number;
  status: 'on_track' | 'at_risk' | 'stalled' | 'no_activity';
}

export interface SessionContinuity {
  last_memories: Memory[];
  session_age_hours: number;
  was_interrupted: boolean;
  resume_suggestion: string;
}

export interface SentimentTrend {
  recent_avg: number;
  previous_avg: number;
  direction: 'improving' | 'declining' | 'stable';
  delta: number;
  notable: Memory[];
}

export interface RelationshipAlert {
  entity_name: string;
  days_silent: number;
  related_plans: Memory[];
  urgency: 'info' | 'attention' | 'urgent';
}

export interface KnowledgeGap {
  question: string;
  asked_at: string;
}

export interface BehavioralPattern {
  description: string;
  confidence: number;
  day_of_week?: number;
  topics: string[];
}

export interface HeartbeatContextResult {
  should_act: boolean;
  scheduled: Memory[];
  deadlines: Memory[];
  pending_work: Memory[];
  conflicts: Array<{ memory: Memory; reason: string }>;
  relevant_memories: SearchResult[];
  summary: string;
  analysis?: HeartbeatAnalysis;

  // Decision metadata
  decision_reason?: string;      // "act", "nudge", "suppress_cooldown", "suppress_stale", "suppress_quiet", "suppress_llm", "no_signals"
  highest_urgency_tier?: string; // "immediate", "elevated", "normal", "low"
  nudge_context?: string;        // memory content for nudge

  // Extended signals
  goal_progress?: GoalProgress[];
  continuity?: SessionContinuity;
  sentiment_trend?: SentimentTrend;
  relationship_alerts?: RelationshipAlert[];
  knowledge_gaps?: KnowledgeGap[];
  behavioral_patterns?: BehavioralPattern[];
}

export interface MemoryStats {
  total_memories: number;
  active_memories: number;
  by_type: Record<string, number>;
  by_state: Record<string, number>;
}
