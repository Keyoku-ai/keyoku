# Keyoku

**Always-on activity tracing and workflow automation for Claude Code, Cursor, and Codex.**

Keyoku watches what you do inside your coding agent, learns your patterns, and turns them into reusable MCP-native workflows you can run with a single command.

```bash
npx keyoku init   # wire into Claude Code in 10 seconds
```

---

## What it does

Every time you run a Bash command, edit a file, or call an MCP tool inside Claude Code, Keyoku records it. Over time it detects repeated sequences — your deploy routine, your test-and-commit loop, your PR prep steps — and offers to turn them into named, one-click workflows.

**Without Keyoku:** you describe the same multi-step process to your agent every session.

**With Keyoku:** you approve a workflow once, then call `workflow_execute` (or trigger it from a hook). The agent never has to rediscover it.

---

## Quick start

```bash
# Install globally
npm install -g keyoku

# Wire into Claude Code (adds MCP server + PostToolUse hook)
keyoku init

# Restart Claude Code — Keyoku is now live
# Check what's been recorded
keyoku status
```

Inside Claude Code you now have access to the full Keyoku tool suite via MCP.

---

## How it works

### 1. Activity tracing (automatic)

A `PostToolUse` hook fires after every Bash/Edit/Write/Read call in Claude Code. Keyoku records a lightweight `ActivityEvent` — tool name, summary, extracted entities — to `~/.keyoku/activity.jsonl`.

No cloud. No telemetry. Purely local.

### 2. Pattern detection

```
workflow_suggest
```

Runs a sliding-window pattern detector over your recent activity. Sequences that repeat 3+ times become draft workflow templates with auto-generated steps.

### 3. Workflow approval

```
workflow_approve { slug: "...", name: "Deploy staging", steps: [...] }
```

Review the draft, adjust steps if needed, then approve. The template is saved to `~/.keyoku/templates.json`.

### 4. Execution

```
workflow_execute { slug: "deploy-staging" }
```

- **bash steps** run directly, output captured
- **agent_prompt steps** pause execution and return the prompt to you (the coding agent handles it, then calls `execution_complete` to resume)
- **human_review steps** pause for explicit sign-off

Fully observable: every execution is stored in `~/.keyoku/executions.json`.

---

## MCP tools

| Tool | What it does |
|---|---|
| `activity_record` | Manually log an event |
| `activity_list` | Browse recent activity |
| `workflow_suggest` | Detect patterns, return draft workflows |
| `workflow_approve` | Save an approved template |
| `workflow_template_list` | List all templates |
| `workflow_template_delete` | Remove a template |
| `workflow_execute` | Run a template |
| `execution_complete` | Resume a paused execution |
| `execution_list` | Browse past executions |
| `goal_create` / `goal_list` / `goal_assess` | Declare goals with machine-checkable criteria |
| `connector_add` / `connector_list` | Connect external MCP services |

---

## CLI

```
keyoku [serve]          Start MCP server on stdio (Claude Code calls this automatically)
keyoku init             Wire up hook + MCP config
keyoku status           Show goals, templates, connectors
keyoku record           Process a PostToolUse hook event from stdin
keyoku learn            Mine patterns from activity log
keyoku assess <goal>    One-shot convergence check
keyoku watch <goal>     Re-assess on an interval
keyoku audit [n]        Last n audit entries
```

---

## Goals (convergence mode)

Keyoku also supports goal-based convergence — declare a goal with machine-checkable success criteria and the harness steers your coding session toward it:

```
goal_create {
  objective: "All tests pass and coverage > 80%",
  criteria: [
    { id: "tests", check: "bash", command: "npm test", expect_exit: 0 },
    { id: "coverage", check: "bash", command: "npm run coverage:check", expect_exit: 0 }
  ]
}
```

---

## Architecture

```
Your machine
├── Claude Code (or Cursor, Codex)
│   ├── PostToolUse hook → keyoku record   (activity logging)
│   └── MCP connection  → keyoku serve     (tool calls)
│
└── ~/.keyoku/
    ├── activity.jsonl    (raw event stream, capped 10k)
    ├── templates.json    (approved workflows)
    ├── executions.json   (run history)
    ├── goals.json        (convergence targets)
    └── connectors.json   (external MCP services)
```

**keyoku-engine** (separate Go repo) provides the cloud backend, knowledge graph, and LLM classification layer for teams that want cross-device sync and cloud triggers. The core harness here is fully local and model-free.

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `KEYOKU_HOME` | `~/.keyoku` | State directory |
| `KEYOKU_DEBUG` | — | Show full error stacks |
| `GEMINI_API_KEY` | — | Enable Gemini-based pattern mining |
| `ANTHROPIC_API_KEY` | — | Enable Claude-based pattern mining |

---

## License

MIT — see [LICENSE](LICENSE).

---

## keyoku-engine

The Go backend for teams: knowledge graph, pgvector embeddings, Ebbinghaus decay, LLM classification, cloud triggers, and cross-device sync. Coming soon at [github.com/Keyoku-ai/keyoku-engine](https://github.com/Keyoku-ai/keyoku-engine).
