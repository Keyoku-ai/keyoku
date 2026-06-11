# Changelog

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
