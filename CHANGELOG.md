# Changelog

## Unreleased

- **Codex out of the box**: `keyoku import` reads `~/.codex/sessions`
  rollouts (both line shapes, cwd-aware, redacted); `keyoku init` wires the
  MCP server into `~/.codex/config.toml`; `keyoku export --agents-md` bakes
  workflows into an AGENTS.md managed block.
- **Proactive intelligence**: background ripeness in the server; PostToolUse
  nudges, SessionStart brief, and prompt-time practice injection — the agent
  offers workflows, nobody has to ask. Each pattern surfaces exactly once.
- **Engine integration v1**: knowledge mirrors into keyoku-engine via
  `/api/v1/seed` (`KEYOKU_ENGINE_URL`); `knowledge_query` upgrades to
  semantic search with silent local fallback.
- **Context layer**: `knowledge_submit`/`knowledge_query`, connector tool
  descriptions captured at registration, CLAUDE.md conventions ingested on
  import, knowledge grounds SLM refinement.
- **Capture & lifecycle**: `workflow_capture` ("save what I just did"),
  `workflow_update`, `execution_cancel`, run-milestone bake hints,
  `keyoku pause`/`resume`, `keyoku doctor`.
- **Accuracy**: session-partitioned mining, automation-vs-practice routing,
  secret redaction at record time, real `{{placeholder}}` params on execute,
  native SLM via any OpenAI-compatible endpoint (Ollama, LiteLLM, Groq, …).

## 0.1.0 — 2026-06-10 (relaunch)

Keyoku is reinvented as an always-on activity tracer and workflow automation
layer for Claude Code and other MCP coding agents.

- **Activity tracing**: PostToolUse hook records every Bash/Edit/Write/Read to
  `~/.keyoku/activity.jsonl`; `keyoku init` wires hook + MCP server in one step.
- **Pattern detection**: non-overlapping sliding-window mining of repeated
  sequences; identical-run suppression; longest-chain collapsing.
- **Model-assisted suggestions**: with an SLM key configured, drafts are
  filtered, named, and parameterized by the model; heuristic-only otherwise.
- **Workflow execution**: bash and mcp_call steps run directly (per-step cwd,
  timeouts); agent_prompt steps pause and hand off to the connected coding
  agent; human_review steps wait for sign-off; executions persist step-by-step.
- **Goal convergence** (carried forward): machine-checkable criteria, probes,
  watch loop, approvals queue, audit trail, MCP connector manager.
- **Transcript import**: `keyoku import` backfills months of activity from
  Claude Code session transcripts — workflows are minable minutes after
  install instead of days.
- **MCP prompts catalog**: approved workflows publish as MCP prompts (native
  slash commands in Claude Code), kept current as templates change.
- **Skill baking**: `keyoku export <slug>` writes a workflow into the repo as
  a `.claude/skills` SKILL.md with provenance — reviewable and team-shareable.
- 205 tests including end-to-end MCP lifecycle, connector gating, import, and
  export suites; CI on every PR.

The previous incarnation of this repository (an OpenClaw memory plugin,
versions ≤ 1.6.x) is preserved in git history and tags.
