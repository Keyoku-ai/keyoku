# @keyoku/types

Shared TypeScript type definitions for the [Keyoku](https://github.com/keyoku-ai/keyoku) memory engine.

## Install

```bash
npm install @keyoku/types
```

## What's Included

Core data contracts used across all Keyoku packages:

| Type | Description |
|------|-------------|
| `Memory` | Core memory entity — content, importance, confidence, sentiment, tags, timestamps, expiry |
| `SearchResult` | Semantic search result with similarity and composite scores |
| `RememberResult` | Outcome of `remember()` — created, updated, deleted, skipped counts |
| `HeartbeatResult` | Zero-token signal scan — deadlines, scheduled, decaying, conflicts |
| `HeartbeatAnalysis` | LLM-analyzed signals with recommended actions and urgency |
| `HeartbeatContextResult` | Combined heartbeat + context search with escalation and graph data |
| `MemoryStats` | Memory statistics — totals, breakdowns by type and state |

Extended signal types for nuanced agent behavior:

`GoalProgress` · `SessionContinuity` · `SentimentTrend` · `RelationshipAlert` · `KnowledgeGap` · `BehavioralPattern`

## Usage

```typescript
import type { Memory, SearchResult, HeartbeatResult } from '@keyoku/types';
```

## License

MIT
