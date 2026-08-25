# Legacy Omnigent fleet runner

Archived: 2026-08-09
Reason: Keyoku’s primary product is now a provider-neutral repository outcome and contribution gate. Owning a special-purpose Omnigent fleet/session/policy runtime made Keyoku look like another agent orchestrator and duplicated the responsibility of full agent-workplace products such as QM.

## Contents

- `src/run.ts` — create and drive Omnigent sessions
- `src/dispatch.ts` — select an Omnigent agent
- `src/omnigent-guardrails.ts` — install/remove Omnigent runtime policies
- `src/policy-compiler.ts` — compile constraints into Omnigent policy handlers
- `src/presets.ts` — Omnigent-only connector preset
- `tests/` — the dedicated regression suite for those modules

## What remains active

- Provider-neutral MCP/OpenAPI connectors and their autonomy/approval controls
- Machine-checkable command, HTTP, and MCP outcome probes
- Constraints as human-readable contribution boundaries
- Agent identity, harness, and model provenance
- Deterministic goal assessment and workflow learning

## Recovery

The move preserves Git history. To revive this integration, copy the files back to `src/` and `tests/`, restore the exports/imports plus `run`, `converge`, `guardrails`, `connect` CLI commands and `goal_run`, `goal_converge`, `goal_guardrails` MCP tools, then update the active product contract and tests. Do not revive it as a hidden dependency of the provider-neutral gate.
