# @keyoku/openclaw

[Keyoku](https://github.com/keyoku-ai/keyoku) memory plugin for [OpenClaw](https://github.com/openclaw/openclaw) — persistent memory, heartbeat signals, and scheduling for your AI assistant.

## Install

```bash
npm install @keyoku/openclaw
```

Or use the setup wizard:

```bash
npx keyoku-init
```

## Usage

In your `openclaw.json`:

```json
{
  "extensions": ["@keyoku/openclaw"]
}
```

Or programmatically:

```typescript
import keyokuMemory from '@keyoku/openclaw';

const plugin = keyokuMemory({
  autoRecall: true,
  autoCapture: true,
  heartbeat: true,
  topK: 5,
  autonomy: 'suggest',
});
```

## What It Does

- **Auto-recall** — Injects relevant memories into context before every response
- **Auto-capture** — Extracts facts, preferences, and relationships from conversations in real-time
- **Heartbeat** — Surfaces deadlines, follow-ups, decaying memories, and conflicts proactively
- **Scheduling** — Cron-based reminders with acknowledgment tracking

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `keyokuUrl` | `http://localhost:18900` | Keyoku engine URL |
| `autoRecall` | `true` | Inject memories before responses |
| `autoCapture` | `true` | Extract facts from conversations |
| `heartbeat` | `true` | Enable proactive signals |
| `incrementalCapture` | `true` | Capture per-message vs. session-end |
| `topK` | `5` | Memories to inject per prompt |
| `autonomy` | `"suggest"` | Action level: `observe`, `suggest`, `act` |
| `captureMaxChars` | `2000` | Max characters for auto-capture |

## Tools

The plugin registers 7 tools for your assistant:

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search over memories |
| `memory_get` | Read a specific memory |
| `memory_store` | Save important information |
| `memory_forget` | Delete a memory |
| `memory_stats` | View memory statistics |
| `schedule_create` | Create a recurring reminder |
| `schedule_list` | View active schedules |

## License

MIT
