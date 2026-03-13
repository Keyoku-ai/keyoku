<div align="center">

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
    <img alt="keyoku" src="assets/banner-light.svg" width="800">
  </picture>

  <p>
    <strong>Supercharge your OpenClaw assistant with persistent memory.</strong><br>
    <sub>Your agent remembers everything, learns from every conversation, and acts on what it knows — automatically.</sub>
  </p>

  <p>
    <a href="#get-started">Get Started</a> &bull;
    <a href="#why-keyoku">Why Keyoku?</a> &bull;
    <a href="#the-heartbeat">The Heartbeat</a> &bull;
    <a href="#autonomy-levels">Autonomy Levels</a>
  </p>

  [![npm](https://img.shields.io/npm/v/@keyoku/openclaw?label=%40keyoku%2Fopenclaw&style=flat-square&color=6366f1)](https://www.npmjs.com/package/@keyoku/openclaw)
  [![npm](https://img.shields.io/npm/v/@keyoku/memory?label=%40keyoku%2Fmemory&style=flat-square&color=6366f1)](https://www.npmjs.com/package/@keyoku/memory)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)](LICENSE)

</div>

<br>

## Get Started

One command. That's it.

```bash
npx @keyoku/openclaw init
```

The init script handles everything automatically:

1. **Detects your OpenClaw installation** — finds your `~/.openclaw/openclaw.json` config
2. **Downloads keyoku-engine** — fetches the right binary for your platform (macOS/Linux, Intel/ARM) from [GitHub Releases](https://github.com/keyoku-ai/keyoku-engine/releases) and installs it to `~/.keyoku/bin/`
3. **Registers the plugin** — adds `keyoku-memory` to your OpenClaw config and sets it as the active memory slot
4. **Migrates existing memories** — if you have existing `MEMORY.md` files or vector stores from OpenClaw's built-in memory, it offers to import them into Keyoku so you don't lose anything

After init completes, restart OpenClaw. The plugin auto-starts keyoku-engine and everything is live — auto-recall, auto-capture, heartbeat, all 7 memory tools.

```
Your Agent ──▶ @keyoku/openclaw ──▶ keyoku-engine ──▶ SQLite + HNSW
               (plugin)              (local server)     (your machine)
```

> [!NOTE]
> All data stays local. keyoku-engine stores everything in SQLite on your machine — no cloud databases, no external API keys for storage. The only external calls are to your LLM provider for memory extraction (configurable).

<details>
<summary><strong>Manual installation</strong></summary>

<br>

If you prefer to set things up manually:

**1. Install the plugin**

```bash
openclaw plugins install @keyoku/openclaw --pin
```

**2. Enable the plugin and set the memory slot**

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "keyoku-memory"
    },
    "entries": {
      "keyoku-memory": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

**3. Install keyoku-engine**

Download the binary for your platform from [GitHub Releases](https://github.com/keyoku-ai/keyoku-engine/releases) and place it at `~/.keyoku/bin/keyoku`, or build from source:

```bash
git clone https://github.com/keyoku-ai/keyoku-engine.git
cd keyoku-engine
make build
cp bin/keyoku-server ~/.keyoku/bin/keyoku
```

**4. Set your LLM API key**

keyoku-engine needs an LLM provider for memory extraction. Set one of:

```bash
export OPENAI_API_KEY="sk-..."      # OpenAI
export ANTHROPIC_API_KEY="sk-ant-..." # Anthropic
export GEMINI_API_KEY="AI..."       # Google Gemini
```

**5. Restart OpenClaw**

The plugin will auto-start keyoku-engine on port 18900.

</details>

---

## Why Keyoku?

OpenClaw already has memory. The built-in default stores facts in `MEMORY.md` with a SQLite search index, and the optional `memory-lancedb` extension adds auto-recall and auto-capture via LanceDB vectors.

So why Keyoku?

Because **memory storage is the easy part**. The hard part is what happens *after* you store something — and that's where OpenClaw's memory system stops and Keyoku starts.

### What OpenClaw already does well

Credit where it's due:

- **Search** — hybrid keyword + vector search across memory files (built-in) or LanceDB vectors (extension)
- **Auto-recall** — the LanceDB extension can inject up to 3 memories before each prompt
- **Auto-capture** — the LanceDB extension can extract and store facts after conversations
- **Session memory** — saves conversation transcripts on `/new` or `/reset`

### What's missing

Even with the LanceDB extension enabled, OpenClaw's memory is **store-and-retrieve**. It saves things and finds them when asked. That's table stakes. Here's what it doesn't do:

#### No memory intelligence

- **No deduplication.** "Prefers TypeScript" and "likes TS" get stored as two separate memories. Over time, your memory fills with redundant facts.
- **No conflict detection.** You changed your mind? Both the old preference and the new one sit in memory. The agent might surface the wrong one.
- **No decay.** A preference from 6 months ago is treated the same as one from yesterday. Stale information never fades.
- **Capped results.** Built-in search returns max 6 snippets at ~700 characters each. The LanceDB extension injects 3 memories. If the answer is buried deeper, it's invisible.

#### No proactive heartbeat

This is the big one. OpenClaw's heartbeat reads a **static `HEARTBEAT.md` file** every 30 minutes.

- **No data.** The file contains tasks you wrote manually. The agent has zero context about what's actually happening — no memory awareness, no deadline tracking, no sentiment analysis.
- **Stateless.** Each heartbeat is isolated. No trends, no patterns, no history across runs.
- **Guesswork.** The agent reads "Check for pending approvals" and has to figure out on its own what that means. Usually it just replies `HEARTBEAT_OK`.
- **No autonomy control.** The agent either acts or doesn't. No structured levels of freedom.

#### No knowledge graph

OpenClaw stores memories as flat text chunks. It doesn't understand that "Alice" is a person who works at ClientCo and is connected to the Q3 launch plan. No entities, no relationships, no graph traversal.

### What Keyoku adds

Keyoku replaces OpenClaw's memory slot with a **full cognitive engine**:

- **Auto-recall + auto-capture** — like the LanceDB extension, but backed by a purpose-built engine with HNSW vectors, full-text fallback, and no result caps
- **Three-tier deduplication** — exact hash, semantic similarity (0.95), and near-duplicate merging (0.75). Your memory stays clean.
- **Conflict detection** — contradictory memories are flagged and resolved automatically
- **Memory decay** — Ebbinghaus-curve retention with access-frequency reinforcement. Stale facts fade. Fresh knowledge surfaces first.
- **Knowledge graph** — entities and relationships are extracted automatically. 20 relationship patterns, BFS traversal up to 5 hops, alias tracking.
- **12 signal heartbeat** — not a file read. 12 SQL-driven checks against your actual memory store, every tick: scheduled tasks, deadlines, pending work, conflicts, goal progress, session continuity, sentiment trends, relationship alerts, knowledge gaps, behavioral patterns, stale monitors, and decaying memories.
- **LLM analysis** — when signals fire, an LLM evaluates the situation with knowledge graph context and generates structured action briefs
- **Three autonomy levels** — `observe` (log only), `suggest` (recommend to user), `act` (execute immediately)
- **Idle check-ins** — personalized nudges based on what it knows you're working on. Not "how are you?" but "Hey, how did that API migration go?"

### Side-by-side

<table>
<tr>
<th width="33%"></th>
<th width="33%">OpenClaw (with LanceDB ext)</th>
<th width="33%">With Keyoku</th>
</tr>
<tr>
<td><strong>Memory storage</strong></td>
<td>Markdown files + LanceDB vectors</td>
<td>SQLite + HNSW vector index + knowledge graph</td>
</tr>
<tr>
<td><strong>Auto-recall</strong></td>
<td>Yes — up to 3 memories injected</td>
<td>Yes — configurable top-K, full memories with metadata</td>
</tr>
<tr>
<td><strong>Auto-capture</strong></td>
<td>Yes — post-conversation extraction</td>
<td>Yes — real-time per-message extraction with dedup</td>
</tr>
<tr>
<td><strong>Deduplication</strong></td>
<td>None</td>
<td>Three-tier: hash + semantic (0.95) + near-duplicate merge (0.75)</td>
</tr>
<tr>
<td><strong>Conflict detection</strong></td>
<td>None</td>
<td>Automatic — old fact updated when you change your mind</td>
</tr>
<tr>
<td><strong>Memory decay</strong></td>
<td>None</td>
<td>Ebbinghaus curve + access reinforcement</td>
</tr>
<tr>
<td><strong>Knowledge graph</strong></td>
<td>None — flat text chunks</td>
<td>Entities, relationships, aliases, graph traversal</td>
</tr>
<tr>
<td><strong>Heartbeat input</strong></td>
<td>Static HEARTBEAT.md file</td>
<td>12 SQL-driven signal categories from actual memory</td>
</tr>
<tr>
<td><strong>Heartbeat intelligence</strong></td>
<td>Agent reads file and guesses</td>
<td>LLM analysis with knowledge graph context</td>
</tr>
<tr>
<td><strong>Heartbeat state</strong></td>
<td>Stateless</td>
<td>Memory-aware — tracks trends, patterns, and history</td>
</tr>
<tr>
<td><strong>Autonomy control</strong></td>
<td>None</td>
<td>Three levels: observe, suggest, act</td>
</tr>
<tr>
<td><strong>Scheduling</strong></td>
<td>Basic cron events</td>
<td>Cron-tagged memories with acknowledgment tracking</td>
</tr>
<tr>
<td><strong>Multi-agent</strong></td>
<td>Isolated per agent</td>
<td>Private, team, and global memory scopes</td>
</tr>
</table>

---

## What Your Agent Gets

Once the plugin is registered, your agent gains these capabilities with **zero additional code**:

### Auto-Recall

Before every response, Keyoku searches your agent's memory for anything relevant to what you're talking about and silently injects it into the prompt. Your agent doesn't "look up" memories — it just *knows* things about you, like a person would.

> **Example:** You mentioned you prefer dark mode three weeks ago. Today you ask about UI settings — your agent already knows your preference without you saying anything.

### Auto-Capture

Every message you exchange is analyzed in real-time. Keyoku extracts the important parts — preferences, decisions, facts, relationships — and stores them as discrete memories. It captures the *pair* (what you said + what the agent responded) for full context.

The engine automatically:
- **Deduplicates** — won't store the same fact twice (checks by hash and meaning)
- **Detects conflicts** — if you change your mind, the old memory gets updated
- **Decays stale info** — old, unused memories fade over time so the freshest knowledge surfaces first

### 7 Memory Tools

Your agent can also *actively* use memory through these tools (registered automatically):

| Tool | What it does |
|------|-------------|
| `memory_search` | Find memories by meaning — "what does this user like?" |
| `memory_store` | Save something important for later |
| `memory_get` | Read a specific memory |
| `memory_forget` | Delete something that's no longer true |
| `memory_stats` | See how many memories exist, by type and state |
| `schedule_create` | Set a recurring reminder (daily, weekly, monthly, or custom cron) |
| `schedule_list` | View all active schedules |

---

## The Heartbeat

This is where Keyoku gets powerful.

Most memory systems are passive — they store things and retrieve them when asked. Keyoku's heartbeat is **active**. On every heartbeat tick, your agent doesn't just sit idle. It reviews everything it knows and decides if there's something it should do *right now*.

### How it works

1. **OpenClaw fires a heartbeat tick** (every few minutes by default)
2. **Keyoku scans all memory signals** — 12 SQL-driven checks, zero LLM tokens
3. **If something needs attention**, Keyoku runs an LLM analysis enriched with knowledge graph context and generates an action brief
4. **The agent receives structured signals** telling it what to do, what to say, and how urgent it is

### What the heartbeat detects

| Signal | What it catches |
|--------|----------------|
| **Scheduled tasks** | Recurring reminders that are due (daily standup, weekly report, etc.) |
| **Deadlines** | Memories with expiration dates that are approaching |
| **Pending work** | Unfinished tasks or commitments the agent made |
| **Conflicts** | Contradictory information that needs resolution |
| **Goal progress** | How far along tracked goals are, with time remaining |
| **Session continuity** | Interrupted conversations that should be resumed |
| **Sentiment trends** | Shifts in user mood across recent conversations |
| **Relationship alerts** | People or contacts the user hasn't engaged with in a while |
| **Knowledge gaps** | Questions the agent couldn't answer — flagged for follow-up |
| **Behavioral patterns** | Recurring habits or preferences detected over time |
| **Stale monitors** | Tracked plans that haven't been touched in 24h |
| **Decaying memories** | Important memories approaching decay threshold |

### The Brain

The heartbeat isn't just a signal scanner — it's a decision engine that uses your agent's full cognitive system:

- **Combines weak signals.** Five "meh" signals that individually don't matter can combine to trigger action. Your agent doesn't miss things just because no single signal was urgent enough.

- **Learns from silence.** If you ignore nudges, the system notices. Response rates below 30% trigger 3x longer cooldowns. Below 10%, it basically stops bothering you until something critical happens.

- **Won't repeat itself.** Same topic won't come up again just because the underlying memory changed. The brain tracks which *entities* (people, projects, topics) it already brought up.

- **Understands urgency as a gradient.** A deadline in 45 minutes isn't the same as one tomorrow. The closer it gets, the more urgently it's treated — and critical deadlines bypass quiet hours.

- **Notices when things improve.** If a goal goes from "at risk" to "on track," or someone you lost touch with messages again, the brain surfaces it. Agents that only nag feel robotic. Agents that acknowledge progress feel human.

- **Matches your patterns.** If you always do code reviews on Tuesdays, the brain knows. It'll surface relevant plans and memories on the right day instead of generic check-ins.

- **Uses the knowledge graph.** Before asking the LLM what to say, the brain enriches every signal with entity relationships — so the LLM knows that "Alice" is a person who works at ClientCo and is connected to the Q3 launch plan, not just a name in a memory.

### What your agent actually sees

A `HEARTBEAT.md` file is static. It tells the agent to "check in" but gives it no context. The agent has to guess.

Keyoku injects **real, structured signals** directly into the agent's context:

```
<heartbeat-signals>
## Action Brief
The user has a project deadline in 2 days and hasn't mentioned it recently.

## Suggested Actions
- Remind the user about the Friday deadline for the API migration
- Ask if they need help prioritizing remaining tasks

## Tell the User
Hey — just a heads up, your API migration deadline is this Friday.
Looks like there are still 3 open tasks. Want me to help prioritize?

## Knowledge Graph Context
- Alice (person) -[works_at]-> ClientCo (org)
- API Migration (project) -[assigned_to]-> Alice (person)
- API Migration (project) -[blocked_by]-> Auth Refactor (project)

## What You Know
- User is working on API migration from REST to GraphQL
- Deadline is Friday March 14th
- Prefers to tackle hardest tasks first
- Last mentioned the project 4 days ago

## Positive Changes
- [goal_improved] "Auth Refactor" moved from at_risk to on_track

Urgency: soon | Mode: suggest
</heartbeat-signals>
```

The agent gets what's happening, what to do about it, who's involved, what's improving, and the memory context to say it well.

### Idle check-ins

When nothing is urgent, Keyoku notices the silence. After a few quiet ticks, it triggers a personalized check-in — matched to your behavioral patterns and what it knows you're working on. Not "how are you?" but "Hey, how did that API migration go?"

---

## Autonomy Levels

You control how much freedom your agent has when the heartbeat detects something. Set the `autonomy` option to one of three levels:

### `observe` — Watch and log

The agent sees the signals but **does not act on them**. Heartbeat data is logged for debugging or review, but the agent won't message the user or take any action.

**Best for:** Testing, debugging, understanding what Keyoku detects before enabling actions.

### `suggest` — Recommend actions (default)

The agent receives the signals and **suggests actions to the user**. It will surface reminders, ask about deadlines, and flag conflicts — but it frames everything as a suggestion, not an instruction.

**Best for:** Most users. Your agent is helpful and proactive without being pushy. It says things like "Hey, your deadline is Friday — want me to help?" rather than just doing things.

### `act` — Take action immediately

The agent receives the signals and **executes recommended actions directly**. If a reminder is due, it sends it. If a task is overdue, it follows up. No waiting for permission.

**Best for:** Power users who want a fully autonomous assistant that handles things on its own.

Set it in your `openclaw.json` plugin config:

```json
{
  "plugins": {
    "entries": {
      "keyoku-memory": {
        "enabled": true,
        "config": {
          "autonomy": "suggest"
        }
      }
    }
  }
}
```

| Level | Agent sees signals | Agent messages user | Agent takes action |
|-------|:-:|:-:|:-:|
| `observe` | Yes | No | No |
| `suggest` | Yes | Yes (as suggestions) | No |
| `act` | Yes | Yes | Yes |

---

## Configuration

Everything works out of the box with defaults. Customize only what you need in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "keyoku-memory": {
        "enabled": true,
        "config": {
          "keyokuUrl": "http://localhost:18900",
          "autoRecall": true,
          "autoCapture": true,
          "heartbeat": true,
          "incrementalCapture": true,
          "topK": 5,
          "autonomy": "suggest"
        }
      }
    }
  }
}
```

| Option | Default | What it does |
|--------|---------|-------------|
| `autoRecall` | `true` | Before every response, search memory and inject relevant context |
| `autoCapture` | `true` | After every message, extract and store important facts |
| `heartbeat` | `true` | Enable the heartbeat system (proactive signals) |
| `incrementalCapture` | `true` | Capture in real-time per message, not just at session end |
| `topK` | `5` | How many memories to inject per prompt (higher = more context) |
| `entityId` | `'default'` fallback when unset | Base memory namespace key used by resolver |
| `agentId` | `'default'` fallback when unset | Identify which agent stored a memory (useful for multi-agent attribution) |
| `entityStrategy` | `'static'` | Runtime entity scoping mode (`static`, `per-user`, `per-channel`, `per-session`, `template`) |
| `entityTemplate` | `'{base}'` | Template used when `entityStrategy = 'template'` |
| `captureInGroups` | `true` | Allow memory writes (capture/store/schedule) in group-like chats |
| `recallInGroups` | `true` | Allow memory recall/search in group-like chats |
| `autonomy` | `'suggest'` | How the agent responds to heartbeat signals (see [Autonomy Levels](#autonomy-levels)) |
| `keyokuUrl` | `localhost:18900` | Where keyoku-engine is running |

> ⚠️ **Shared-workspace note:** with `entityStrategy: 'static'` (or unset), memories are shared inside the same `entityId` namespace.
> For Slack/Discord/Teams org deployments, prefer `per-user` (or stricter) and consider `captureInGroups: false` / `recallInGroups: false`.

---

## For Developers: Standalone Memory Client

Building a custom agent without OpenClaw? Use `@keyoku/memory` directly for full programmatic access to the memory engine.

```bash
npm install @keyoku/memory
```

```typescript
import { KeyokuClient } from '@keyoku/memory';

const keyoku = new KeyokuClient();

// Store a memory
await keyoku.remember('user-123', 'Prefers dark mode and TypeScript');

// Semantic search
const results = await keyoku.search('user-123', 'UI preferences');
// => [{ memory: { content: 'Prefers dark mode...' }, similarity: 0.91 }]

// Heartbeat check (zero tokens)
const heartbeat = await keyoku.heartbeatCheck('user-123');
if (heartbeat.should_act) {
  console.log(heartbeat.priority_action);
}

// Full heartbeat with LLM analysis
const ctx = await keyoku.heartbeatContext('user-123', {
  analyze: true,
  autonomy: 'suggest',
  activity_summary: 'User was working on API migration',
});

// Scheduling
await keyoku.createSchedule('user-123', 'my-agent', 'Weekly standup prep', 'weekly');
```

<details>
<summary><strong>Full Client API</strong></summary>

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

---

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`@keyoku/openclaw`](packages/openclaw) | **OpenClaw plugin** — the main package. Auto-recall, auto-capture, heartbeat, tools, CLI | [![npm](https://img.shields.io/npm/v/@keyoku/openclaw?style=flat-square&color=6366f1)](https://www.npmjs.com/package/@keyoku/openclaw) |
| [`@keyoku/memory`](packages/memory) | Standalone HTTP client for developers building custom agents | [![npm](https://img.shields.io/npm/v/@keyoku/memory?style=flat-square&color=6366f1)](https://www.npmjs.com/package/@keyoku/memory) |
| [`@keyoku/types`](packages/types) | Shared TypeScript type definitions | [![npm](https://img.shields.io/npm/v/@keyoku/types?style=flat-square&color=6366f1)](https://www.npmjs.com/package/@keyoku/types) |

## How It Works

```
Your OpenClaw Assistant
    │
    ▼
@keyoku/openclaw (plugin)
    │  Every message:
    │    1. Recall — search memory, inject relevant context
    │    2. Respond — agent replies with full memory awareness
    │    3. Capture — extract facts from the exchange
    │  Every heartbeat tick:
    │    4. Scan — check all 12 signal categories
    │    5. Analyze — LLM evaluates what needs attention
    │    6. Act — agent responds based on autonomy level
    ▼
keyoku-engine (runs locally)
    │  extraction, semantic search, dedup, decay, consolidation
    ▼
SQLite + HNSW Vector Index (your machine, your data)
```

## Development

```bash
npm install   # install dependencies
npm run build # build all packages
npm test      # run tests
npm run clean # clean build artifacts
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
