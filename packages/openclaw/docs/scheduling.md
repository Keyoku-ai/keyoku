# Scheduling: Keyoku vs OpenClaw Cron

Keyoku scheduling and OpenClaw's built-in cron are **complementary systems** that work at different layers. They do not overlap or conflict.

## At a Glance

| | Keyoku Scheduling | OpenClaw Cron |
|---|---|---|
| **Purpose** | Memory reminders ("tell me about X later") | Execution triggers (spawn agent session) |
| **Storage** | Memories with `cron:*` tags in Keyoku DB | Config-driven croner jobs in OpenClaw |
| **Detection** | Zero-token heartbeat check (no LLM call) | croner timer fires on schedule |
| **Action** | Surfaced in `<heartbeat-signals>` block | Isolated agent run in new session |
| **Cost** | Free — just a DB query | Triggers a full agent session (LLM calls) |

## How They Work Together

```
OpenClaw cron timer fires
  → spawns agent session
    → heartbeat hook runs
      → Keyoku heartbeat check queries scheduled memories (auto_ack_scheduled=false)
        → due schedules appear in <heartbeat-signals>
          → agent emits a real heartbeat message
            → integration acknowledges due schedule IDs via /schedule/ack
```

**OpenClaw cron** is the execution layer — it decides *when* to wake up an agent. **Keyoku scheduling** is the memory layer — it decides *what the agent should be reminded about* when it wakes up.

## Ownership Model

Keyoku and the runtime have clearly separated responsibilities:

| Concern | Owner | Description |
|---|---|---|
| **Reminder semantics** | Keyoku | Stores scheduled memories, evaluates due detection, manages cron tags |
| **Wake / delivery** | Runtime (OpenClaw) | Wakes heartbeat on a schedule, delivers surfaced signals to user |
| **Acknowledgment** | Integration | Acks schedules after confirmed delivery (not before) |

The runtime should **not** maintain a parallel reminder model. If Keyoku heartbeat is enabled and OpenClaw's built-in heartbeat is disabled (`target: "none"`), then reminder semantics are unambiguously Keyoku-owned.

## Reminder Lifecycle

Every scheduled reminder follows this lifecycle:

```
created → due → surfaced → delivered → acked → waiting (next cycle)
                                                  ↓
                                              retired (one-shot)
```

| State | Description |
|---|---|
| **created** | Memory stored with `cron:*` tag, `state=active` |
| **due** | `IsDue(lastRun, now)` returns true — the next interval has arrived |
| **surfaced** | Heartbeat included the memory in `result.Scheduled` and recorded it as surfaced |
| **delivered** | Runtime emitted a user-facing message containing the reminder |
| **acked** | Integration called `/schedule/ack` after confirming delivery |
| **waiting** | Ack advanced `last_accessed_at`, schedule waits for next interval |
| **retired** | One-shot (`cron:once:*`) archived after firing |

### Surfacing Cooldown

To prevent resurfacing loops when integration hasn't acked yet, the engine applies a **30-minute surfacing cooldown**. If a cron memory was already surfaced recently, it won't re-fire even if `IsDue()` returns true.

### Missed Windows

If a schedule fires significantly past its expected due time (>2x interval for interval-based, >24h for fixed-time schedules), the engine tags it with `missed_window` metadata. This lets delivery note the delay to the user.

## Diagnosing Schedule Issues

Use the `schedule_diagnose` tool (or `GET /api/v1/schedule/diagnose`) to inspect why a reminder isn't firing. It returns lifecycle state for every cron-tagged memory:

- **State**: active, stale, archived, resolved
- **Due time**: when it will next fire
- **Missed window**: whether it fired past its grace period
- **Reason**: human-readable explanation (e.g., "due since 2026-03-28T09:00:00Z, missed by 2h — heartbeat may not have been woken")

Common issues:
- **State is `stale` or `archived`**: the memory decayed or was cancelled. Use `schedule_list` to check active schedules.
- **Missed window**: the runtime (OpenClaw cron) didn't wake heartbeat at the expected time. Check cron configuration.
- **Recently surfaced but not acked**: the 30-minute cooldown is active. Integration needs to ack after delivery.

## When to Use Which

### Use Keyoku Scheduling when:
- An agent says "remind me to check on this in 2 hours"
- You want to surface a memory at a specific time
- The reminder is conversational and context-dependent
- You want zero overhead until the next heartbeat

### Use OpenClaw Cron when:
- You need a recurring agent session (e.g., daily standup at 9am)
- The task requires a fresh agent session with tools
- You need guaranteed execution at exact times
- The trigger is infrastructure-level, not memory-level

## Example: Daily Review

A user tells their agent: "Every morning, review my inbox and summarize what needs attention."

This uses **both** systems:
1. **OpenClaw cron** — configured to spawn the agent session at 9:00 AM daily
2. **Keyoku schedule** — stores the memory "Review user's inbox and summarize" with a `cron:daily:09:00` tag
3. When the cron fires → agent session starts → heartbeat runs → Keyoku surfaces the "review inbox" memory → agent acts on it

Without OpenClaw cron, there's no session to run in. Without Keyoku scheduling, the agent wouldn't know *what* to do when it wakes up.

## Reminder lifecycle (integration contract)

For the OpenClaw + Keyoku integration path, scheduled reminders are treated as handled only after this sequence:

1. **Created** — memory stored with a `cron:*` tag
2. **Due** — heartbeat context includes the reminder in `scheduled`
3. **Surfaced** — plugin injects it into `<heartbeat-signals>`
4. **Delivered** — assistant sends a real heartbeat message (not `HEARTBEAT_OK`/`NO_REPLY`)
5. **Acked** — plugin calls `/schedule/ack` for due schedule IDs

This keeps reminder semantics in Keyoku while ensuring delivery semantics stay in the runtime/integration layer.

## API Reference

### Keyoku Schedule Tools (registered by plugin)

- `schedule_create` — Create a scheduled memory with a cron tag
- `schedule_list` — List all active schedules
- `schedule_diagnose` — Diagnose schedule lifecycle issues (why didn't my reminder fire?)

### Keyoku Schedule HTTP API

- `POST /api/v1/schedule` — Create schedule
- `POST /api/v1/schedule/ack` — Acknowledge a schedule run
- `PUT /api/v1/schedule/:id` — Update schedule tag/content
- `DELETE /api/v1/schedule/:id` — Cancel (archive) schedule
- `GET /api/v1/scheduled` — List active schedules
- `GET /api/v1/schedule/diagnose` — Lifecycle diagnostics for all schedules

### OpenClaw Cron (configured in openclaw.json)

See the [OpenClaw documentation](https://openclaw.dev/docs/cron) for cron job configuration.
