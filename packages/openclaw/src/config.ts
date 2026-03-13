/**
 * Plugin configuration types and defaults
 */

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
  /** Base memory namespace key (default: "default") */
  entityId?: string;
  /** Agent identifier for memory attribution */
  agentId?: string;
  /** Maximum characters to consider for auto-capture (default: 2000) */
  captureMaxChars?: number;
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
}

export const DEFAULT_CONFIG: Required<KeyokuConfig> = {
  keyokuUrl: 'http://localhost:18900',
  autoRecall: true,
  autoCapture: true,
  heartbeat: true,
  topK: 5,
  entityId: '',
  agentId: '',
  captureMaxChars: 2000,
  autonomy: 'suggest',
  incrementalCapture: true,
  entityStrategy: 'static',
  entityTemplate: '{base}',
  captureInGroups: true,
  recallInGroups: true,
};

export function resolveConfig(config?: KeyokuConfig): Required<KeyokuConfig> {
  return { ...DEFAULT_CONFIG, ...config };
}
