<div align="center">

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
    <img alt="keyoku" src="assets/banner-light.svg" width="800">
  </picture>

  <p>
    <strong>TypeScript SDK for AI memory.</strong><br>
    <sub>Give your agents persistent, semantic memory with auto-recall, auto-capture, and intelligent heartbeat.</sub>
  </p>

  <p>
    <a href="#quick-start">Quick Start</a> &bull;
    <a href="#packages">Packages</a> &bull;
    <a href="#features">Features</a> &bull;
    <a href="#api">API Reference</a>
  </p>

  [![npm version](https://img.shields.io/npm/v/@keyoku/memory?style=flat-square&label=%40keyoku%2Fmemory)](https://www.npmjs.com/package/@keyoku/memory)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![CI](https://img.shields.io/github/actions/workflow/status/keyoku-ai/keyoku/ci.yml?style=flat-square&label=CI)](https://github.com/keyoku-ai/keyoku/actions)
  [![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)](LICENSE)
  [![GitHub Stars](https://img.shields.io/github/stars/keyoku-ai/keyoku?style=flat-square)](https://github.com/keyoku-ai/keyoku/stargazers)

</div>

<br>

## What is Keyoku?

Keyoku is a memory system for AI agents. At its core is [**keyoku-engine**](https://github.com/keyoku-ai/keyoku-engine) — a Go-based memory engine that handles extraction, vector search, deduplication, decay, and consolidation, all locally with SQLite and an in-process HNSW index. No external databases required.

This repo provides the **TypeScript SDK** — a typed client and plugin layer that connects your agents to keyoku-engine. It handles auto-recall (injecting relevant memories into prompts), auto-capture (extracting facts from conversations), and heartbeat (proactive checks for deadlines, conflicts, and decaying knowledge).

```
Your Agent ──▶ @keyoku/openclaw ──▶ @keyoku/memory ──▶ keyoku-engine ──▶ SQLite + HNSW
               (plugin)              (HTTP client)      (Go server)
```

## Packages

This monorepo contains three packages:

| Package | Description | npm |
|---------|-------------|-----|
| [`@keyoku/types`](packages/types) | Shared TypeScript type definitions | [![npm](https://img.shields.io/npm/v/@keyoku/types?style=flat-square&label=)](https://www.npmjs.com/package/@keyoku/types) |
| [`@keyoku/memory`](packages/memory) | HTTP client for keyoku-engine | [![npm](https://img.shields.io/npm/v/@keyoku/memory?style=flat-square&label=)](https://www.npmjs.com/package/@keyoku/memory) |
| [`@keyoku/openclaw`](packages/openclaw) | OpenClaw plugin for persistent memory | [![npm](https://img.shields.io/npm/v/@keyoku/openclaw?style=flat-square&label=)](https://www.npmjs.com/package/@keyoku/openclaw) |

## Quick Start

### Using the memory client

```bash
npm install @keyoku/memory
```

```typescript
import { KeyokuClient } from '@keyoku/memory';

const keyoku = new KeyokuClient();

// Store memories
await keyoku.remember('user-123', 'Prefers dark mode and TypeScript');

// Search by meaning
const results = await keyoku.search('user-123', 'UI preferences');
// => [{ memory: { content: 'Prefers dark mode...' }, similarity: 0.91 }]

// Zero-token heartbeat check
const heartbeat = await keyoku.heartbeatCheck('user-123');
if (heartbeat.should_act) {
  console.log(heartbeat.priority_action);
}
```

### Using with OpenClaw

```bash
npm install @keyoku/openclaw
```

```typescript
import keyokuMemory from '@keyoku/openclaw';

// Register as an OpenClaw plugin
const config = {
  plugins: {
    'keyoku-memory': keyokuMemory({
      autoRecall: true,     // inject relevant memories into prompts
      autoCapture: true,    // extract facts from conversations
      heartbeat: true,      // proactive action detection
    })
  },
  slots: {
    memory: 'keyoku-memory'
  }
};
```

> [!NOTE]
> Requires [keyoku-engine](https://github.com/keyoku-ai/keyoku-engine) running locally (default: `http://localhost:18900`).

## Features

<table>
<tr>
<td align="center" width="33%">
  <strong>Auto-Recall</strong><br>
  <sub>Automatically injects relevant memories into agent prompts via semantic search</sub>
</td>
<td align="center" width="33%">
  <strong>Auto-Capture</strong><br>
  <sub>Extracts memorable facts from conversations — per-message or batch</sub>
</td>
<td align="center" width="33%">
  <strong>Heartbeat</strong><br>
  <sub>Zero-token proactive checks for deadlines, decay, conflicts, and more</sub>
</td>
</tr>
<tr>
<td align="center" width="33%">
  <strong>Scheduling</strong><br>
  <sub>Cron-tagged memories with acknowledgment tracking</sub>
</td>
<td align="center" width="33%">
  <strong>Teams</strong><br>
  <sub>Multi-agent memory visibility with private, team, and global scopes</sub>
</td>
<td align="center" width="33%">
  <strong>OpenClaw Plugin</strong><br>
  <sub>Drop-in integration with lifecycle hooks, tools, and CLI</sub>
</td>
</tr>
</table>

## API

<details>
<summary><strong>@keyoku/memory — Client API</strong></summary>

<br>

```typescript
const client = new KeyokuClient({ baseUrl?: string, timeout?: number });
```

| Method | Description |
|--------|-------------|
| `remember(entityId, content, options?)` | Store memories from content |
| `search(entityId, query, options?)` | Semantic search across memories |
| `listMemories(entityId, limit?)` | List all memories for entity |
| `getMemory(id)` | Get a single memory by ID |
| `deleteMemory(id)` | Delete a specific memory |
| `deleteAllMemories(entityId)` | Delete all memories for entity |
| `getStats(entityId)` | Get memory statistics |
| `heartbeatCheck(entityId, options?)` | Zero-token heartbeat check |
| `heartbeatContext(entityId, options?)` | Extended heartbeat with LLM analysis |
| `createSchedule(entityId, agentId, content, cronTag)` | Create a scheduled memory |
| `listSchedules(entityId, agentId?)` | List active schedules |
| `ackSchedule(memoryId)` | Acknowledge a schedule |
| `cancelSchedule(id)` | Cancel a schedule |

</details>

<details>
<summary><strong>@keyoku/openclaw — Plugin Tools</strong></summary>

<br>

The OpenClaw plugin registers these tools for agents to use:

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search across stored memories |
| `memory_get` | Read a specific memory by ID |
| `memory_store` | Persist facts to memory |
| `memory_forget` | Delete a memory |
| `memory_stats` | Get memory statistics |
| `schedule_create` | Create a scheduled memory |
| `schedule_list` | List active schedules |

</details>

<details>
<summary><strong>@keyoku/openclaw — Configuration</strong></summary>

<br>

```typescript
keyokuMemory({
  keyokuUrl: 'http://localhost:18900',  // keyoku-engine URL
  autoRecall: true,                     // inject memories into prompts
  autoCapture: true,                    // extract facts after responses
  heartbeat: true,                      // proactive action detection
  topK: 5,                              // max memories to inject
  entityId: 'user-123',                 // entity scope
  agentId: 'agent-1',                   // agent identifier
  captureMaxChars: 2000,                // max chars for capture
  autonomy: 'suggest',                  // 'observe' | 'suggest' | 'act'
  incrementalCapture: true,             // per-message extraction
})
```

</details>

## How It Works

```
Your Agent (OpenClaw / custom)
    │
    ▼
@keyoku/openclaw (plugin)
    │  auto-recall, auto-capture, heartbeat hooks
    ▼
@keyoku/memory (HTTP client)
    │  typed requests
    ▼
keyoku-engine (Go server)
    │  extract, search, decay, consolidate
    ▼
SQLite + HNSW Vector Index
```

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test

# Clean build artifacts
npm run clean
```

Requires Node.js 20+.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](LICENSE) for details.

<br>
<div align="center">
  <sub>Built by <a href="https://github.com/keyoku-ai">Keyoku</a></sub>
</div>
