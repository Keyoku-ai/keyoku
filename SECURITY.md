# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository, or email
**support@keyoku.ai**. Please do not open public issues for security reports.
We aim to acknowledge reports within 72 hours.

## Supported versions

Only the latest published 0.x release receives security fixes.

## Execution model — read this before installing

Keyoku is a local automation tool. Be aware of what it does by design:

- **Approved workflow templates execute shell commands** on your machine with
  your privileges via `workflow_execute`. The approval step
  (`workflow_approve`) is the trust boundary: review every step of a template
  before approving it, exactly as you would review a shell script before
  running it. Steps time out (30s, SIGTERM→SIGKILL) and output is captured.
- **The activity log** (`~/.keyoku/activity.jsonl`) records summaries of your
  tool usage (commands, file paths). It stays on your machine. There is no
  telemetry and no network calls unless you configure an SLM key
  (GEMINI_API_KEY / ANTHROPIC_API_KEY), in which case pattern summaries are
  sent to that provider for refinement.
- **State files** under `~/.keyoku` are written with mode 0600 (dir 0700),
  the same posture as `~/.aws`. Connector configs may contain credentials —
  treat the directory accordingly.
- **Connector autonomy**: external MCP connectors default to gated execution;
  write-capable calls can be routed through an approvals queue
  (`keyoku approvals`).
