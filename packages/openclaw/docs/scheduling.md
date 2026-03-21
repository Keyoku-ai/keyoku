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
      → Keyoku heartbeat check queries scheduled memories
        → due schedules appear in <heartbeat-signals>
          → agent reads signals and acts on them
```

**OpenClaw cron** is the execution layer — it decides *when* to wake up an agent. **Keyoku scheduling** is the memory layer — it decides *what the agent should be reminded about* when it wakes up.

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
2. **Keyoku schedule** — stores the memory "Review user's inbox and summarize" with a `cron:0 9 * * *` tag
3. When the cron fires → agent session starts → heartbeat runs → Keyoku surfaces the "review inbox" memory → agent acts on it

Without OpenClaw cron, there's no session to run in. Without Keyoku scheduling, the agent wouldn't know *what* to do when it wakes up.

## API Reference

### Keyoku Schedule Tools (registered by plugin)

- `memory_schedule` — Create a scheduled memory with a cron expression
- `memory_list_schedules` — List all active schedules
- `memory_cancel_schedule` — Cancel a scheduled memory

### OpenClaw Cron (configured in openclaw.json)

See the [OpenClaw documentation](https://openclaw.dev/docs/cron) for cron job configuration.
