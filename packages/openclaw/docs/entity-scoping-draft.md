# Dynamic Entity Scoping (Draft)

Status: **implemented (initial slice)** — runtime resolver + strategy config landed; further hardening/testing can iterate.

Tracked by issue: https://github.com/Keyoku-ai/keyoku/issues/1

## Background

`@keyoku/openclaw` currently resolves `entityId` once at plugin startup.
If `entityId` is not configured, the plugin falls back to a shared default namespace.

That behavior is acceptable for single-user/local setups, but risky for shared
workspace channels (Slack/Discord/Teams) where one OpenClaw instance serves
multiple people.

## Goal

Allow memory namespaces to be derived from runtime chat/session context so
operators can prevent cross-user memory recall/capture leakage.

## Proposed config surface

```ts
entityId?: string; // existing
entityStrategy?: 'static' | 'per-user' | 'per-channel' | 'per-session' | 'template';
entityTemplate?: string; // e.g. "{channel}:{workspace}:{scope}:{id}"
captureInGroups?: boolean;
recallInGroups?: boolean;
```

Back-compat defaults:

- `entityStrategy = 'static'`
- existing `entityId` behavior unchanged

## Expected strategy behavior

- `static`: current behavior
- `per-user`: namespace by sender identity (best default for org DMs)
- `per-channel`: shared memory per channel
- `per-session`: isolate memory by session key
- `template`: advanced custom naming for operators

## Safety expectations

For `per-user` strategy:

- User A memory is never recalled in User B context
- Group behavior is explicit (`captureInGroups`/`recallInGroups`), not implicit

## Implementation sketch

1. Add resolver utility in `packages/openclaw/src/` to compute runtime entity key from hook/tool context.
2. Wire resolver through:
   - `hooks.ts` auto-recall + heartbeat
   - `incremental-capture.ts`
   - `tools.ts` memory/schedule tools
3. Keep `agentId` attribution unchanged.
4. Add unit tests for resolver and non-leakage cases.

## Migration notes

- Existing users on static namespace keep behavior.
- Docs should explicitly call out that static/default namespace is shared.
- Optional one-time migration utility can copy/tag memories into new namespaces.
