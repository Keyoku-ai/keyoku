/**
 * Plugin configuration types and defaults
 */

import type { HeartbeatVerbosity } from '@keyoku/types';

export type EntityStrategy =
  | 'static'
  | 'per-user'
  | 'per-channel'
  | 'per-session'
  | 'template';

export interface KeyokuConfig {
  /** Keyoku server URL (default: http://localhost:18900) */
  keyokuUrl?: string;
  /** Inject relevant memories into prompts automatically (default: true) */
  autoRecall?: boolean;
  /** Capture facts from conversations automatically (default: true) */
  autoCapture?: boolean;
  /** Enhance heartbeat runs with Keyoku data (default: true) */
  heartbeat?: boolean;
  /** Number of memories to inject per prompt (default: 5) */
  topK?: number;
  /** Minimum similarity score for auto-recall injections (default: 0.35) */
  recallMinScore?: number;
  /** How auto-recall builds its search query (default: latest-user) */
  recallQueryMode?: 'latest-user' | 'prompt-plus-context';
  /** Base memory namespace key (default: "default") */
  entityId?: string;
  /** Agent identifier for memory attribution */
  agentId?: string;
  /** Maximum characters to consider for auto-capture (default: 2000) */
  captureMaxChars?: number;
  /** HTTP timeout used by Keyoku client calls (default: 120000ms) */
  clientTimeoutMs?: number;
  /** Minimum time between capture writes (default: 10000ms) */
  captureDebounceMs?: number;
  /** Maximum in-flight capture writes before skipping new ones (default: 1) */
  captureMaxInFlight?: number;
  /** Autonomy level for heartbeat actions (default: 'suggest') */
  autonomy?: 'observe' | 'suggest' | 'act';
  /** Capture memories incrementally per message (default: true) */
  incrementalCapture?: boolean;
  /** How entity IDs are derived at runtime (default: static) */
  entityStrategy?: EntityStrategy;
  /** Template used when entityStrategy = "template" */
  entityTemplate?: string;
  /** Allow memory capture in group chats/channels (default: true) */
  captureInGroups?: boolean;
  /** Allow memory recall in group chats/channels (default: true) */
  recallInGroups?: boolean;
  /** Heartbeat verbosity level (default: 'conversational') */
  verbosity?: HeartbeatVerbosity;
}

export const DEFAULT_CONFIG: Required<KeyokuConfig> = {
  keyokuUrl: 'http://localhost:18900',
  autoRecall: true,
  autoCapture: true,
  heartbeat: true,
  topK: 5,
  recallMinScore: 0.35,
  recallQueryMode: 'latest-user',
  entityId: '',
  agentId: '',
  captureMaxChars: 2000,
  clientTimeoutMs: 120000,
  captureDebounceMs: 10000,
  captureMaxInFlight: 1,
  autonomy: 'suggest',
  incrementalCapture: true,
  entityStrategy: 'static',
  entityTemplate: '{base}',
  captureInGroups: true,
  recallInGroups: true,
  verbosity: 'conversational',
};

export function resolveConfig(config?: KeyokuConfig): Required<KeyokuConfig> {
  return { ...DEFAULT_CONFIG, ...config };
}
