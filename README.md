<div align="center">

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
    <img alt="keyoku" src="assets/banner-light.svg" width="800">
  </picture>

  <p>
    <strong>The harness with muscle memory.</strong><br>
    <sub>Keyoku watches what you do in Claude Code, Cursor, or Codex, learns your patterns, and turns them into one-command workflows — automatically.</sub>
  </p>

  <p>
    <a href="#get-started">Get Started</a> &bull;
    <a href="#how-it-works">How It Works</a> &bull;
    <a href="#mcp-tools">MCP Tools</a> &bull;
    <a href="#architecture">Architecture</a> &bull;
    <a href="#keyoku-engine">keyoku-engine</a>
  </p>

  [![npm](https://img.shields.io/npm/v/keyoku?label=keyoku&style=flat-square&color=6366f1)](https://www.npmjs.com/package/keyoku)
  [![CI](https://img.shields.io/github/actions/workflow/status/Keyoku-ai/keyoku/ci.yml?style=flat-square&label=CI)](https://github.com/Keyoku-ai/keyoku/actions/workflows/ci.yml)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)](LICENSE)

</div>

<br>

## Get Started

One command. That's it.

```bash
npx keyoku init
```

The init command wires everything automatically:

1. **Registers the MCP server** — via `claude mcp add --scope user`, so Claude Code connects on next launch
2. **Installs the activity hook** — a `PostToolUse` hook records every Bash/Edit/Write/Read to `~/.keyoku/activity.jsonl`
3. **Stays local** — no cloud, no telemetry; state lives in `~/.keyoku` with the same file permissions as `~/.aws`

Restart Claude Code and keyoku is live. Use your agent normally for a while, then ask it to run `workflow_suggest` — keyoku will show you the workflows it learned from watching you work.

## How It Works

**Without Keyoku:** you describe the same multi-step process to your agent every session.

**With Keyoku:** you approve a workflow once, then run it with one command. The agent never has to rediscover it.

### 1. Activity tracing — automatic

Every tool call your agent makes is recorded as a lightweight `ActivityEvent` — tool name, summary, extracted entities. Purely local.

### 2. Pattern detection — heuristics for recall, a model for precision

`workflow_suggest` mines recurring sequences from your recent activity (non-overlapping counting, noise suppression, longest-chain collapsing — no model required). If an SLM key is configured (`GEMINI_API_KEY` or `ANTHROPIC_API_KEY`), the model then refines the drafts: filters coincidences, names workflows properly, and parameterizes run-specific values with `{{placeholders}}`.

### 3. Approval — you are the trust boundary

```
workflow_approve { slug: "deploy-staging", name: "Deploy staging", steps: [...] }
```

Review the draft like you'd review a shell script, then approve. Templates live in `~/.keyoku/templates.json`.

### 4. Execution — bash runs, judgment pauses

```
workflow_execute { slug: "deploy-staging" }
```

- **bash** steps run directly (per-step `cwd`, timeouts, output captured)
- **agent_prompt** steps pause and hand the step to your coding agent, which resumes with `execution_complete`
- **human_review** steps wait for your explicit sign-off

Every execution persists step-by-step — crash-safe, fully inspectable via `execution_list`.

## MCP Tools

| Tool | What it does |
|---|---|
| `activity_record` / `activity_list` | Log and browse the observation stream |
| `workflow_suggest` | Mine patterns → model-refined draft workflows |
| `workflow_approve` | Save an approved template |
| `workflow_template_list` / `workflow_template_delete` | Manage the catalog |
| `workflow_execute` | Run a template |
| `execution_complete` / `execution_list` | Resume paused runs; browse history |
| `goal_create` / `goal_assess` / … | Goals with machine-checkable success criteria |
| `connector_add` / `connector_call` / … | Plug in external MCP servers (GitHub, GCP, …) with autonomy gating |

## CLI

```
keyoku [serve]          Start the MCP server on stdio (Claude Code does this automatically)
keyoku init             Wire up the hook + MCP registration
keyoku status           Show goals, templates, connectors
keyoku learn            Mine patterns from the activity log
keyoku assess <goal>    One-shot convergence check
keyoku watch <goal>     Re-assess on an interval
keyoku approvals        Approve/deny gated connector calls
keyoku audit [n]        Show the audit trail
```

## Architecture

```
Your machine
├── Claude Code (or Cursor, Codex)
│   ├── PostToolUse hook → keyoku record   (activity logging)
│   └── MCP connection  → keyoku serve     (tool calls)
│
└── ~/.keyoku/
    ├── activity.jsonl    (event stream, capped)
    ├── templates.json    (approved workflows)
    ├── executions.json   (run history)
    ├── goals.json        (convergence targets)
    └── connectors.json   (external MCP services)
```

The division of labor: **heuristics** generate candidates for free, the **small model** refines them cheaply, and your **coding agent** does the heavy lifting on the subscription you already pay for. Keyoku orchestrates; it never burns frontier tokens.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `KEYOKU_HOME` | `~/.keyoku` | State directory |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | — | Enable model-refined suggestions |
| `KEYOKU_SLM_PROVIDER` | auto | `gemini`, `anthropic`, or `none` |
| `KEYOKU_DEBUG` | — | Full error stacks |

## Security

Approved templates execute shell commands with your privileges — the approval step is the trust boundary. Read [SECURITY.md](SECURITY.md) before installing.

## keyoku-engine

The Go backend for teams: knowledge graph, semantic search, memory decay, and cross-device sync. Available at [github.com/Keyoku-ai/keyoku-engine](https://github.com/Keyoku-ai/keyoku-engine).

## License

MIT — see [LICENSE](LICENSE).
