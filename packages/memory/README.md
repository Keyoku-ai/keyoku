# @keyoku/memory

HTTP client for the [Keyoku](https://github.com/keyoku-ai/keyoku) memory engine. Use this to add persistent memory to any Node.js agent or application.

## Install

```bash
npm install @keyoku/memory
```

## Quick Start

```typescript
import { KeyokuClient } from '@keyoku/memory';

const keyoku = new KeyokuClient({
  baseUrl: 'http://localhost:18900',
});

// Store memories
await keyoku.remember('user-123', 'Prefers dark mode and TypeScript');

// Semantic search
const results = await keyoku.search('user-123', 'what are their preferences?');

// Heartbeat — proactive signal scan
const signals = await keyoku.heartbeatCheck('user-123');
if (signals.should_act) {
  console.log(signals.priority_action);
}
```

## API

### Constructor

```typescript
new KeyokuClient({
  baseUrl?: string;    // default: http://localhost:18900
  timeout?: number;    // default: 30000ms
  token?: string | (() => string | undefined);
})
```

### Memory Operations

| Method | Description |
|--------|-------------|
| `remember(entityId, content, options?)` | Store memories (auto-extracts facts) |
| `search(entityId, query, options?)` | Semantic search over memories |
| `listMemories(entityId, limit?)` | List all memories for an entity |
| `getMemory(id)` | Get a single memory by ID |
| `deleteMemory(id)` | Delete a specific memory |
| `deleteAllMemories(entityId)` | Wipe all memories for an entity |
| `getStats(entityId)` | Memory statistics |

### Heartbeat Operations

| Method | Description |
|--------|-------------|
| `heartbeatCheck(entityId, options?)` | Zero-token signal scan (deadlines, decaying, conflicts) |
| `heartbeatContext(entityId, options?)` | Combined heartbeat + context search with LLM analysis |
| `recordHeartbeatMessage(entityId, message)` | Log heartbeat messages for deduplication |

### Scheduling

| Method | Description |
|--------|-------------|
| `createSchedule(entityId, agentId, content, cronTag)` | Create recurring reminder (`daily`, `weekly`, `monthly`, or cron) |
| `listSchedules(entityId, agentId?)` | List active schedules |
| `ackSchedule(memoryId)` | Acknowledge a schedule |
| `cancelSchedule(id)` | Cancel a schedule |

### Error Handling

```typescript
import { KeyokuError } from '@keyoku/memory';

try {
  await keyoku.search('user-123', 'query');
} catch (err) {
  if (err instanceof KeyokuError) {
    console.log(err.status, err.path);
  }
}
```

All types from `@keyoku/types` are re-exported for convenience.

## License

MIT
