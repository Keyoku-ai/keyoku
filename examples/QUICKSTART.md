# Quickstart — your first convergence

Two scenarios: a 2-minute toy loop to feel the mechanics, then a real one.

## 0. Wire it up

```bash
cd keyoku-harness
npm install && npm run build
claude mcp add keyoku -- node "$(pwd)/dist/index.js" serve
```

Open a new Claude Code session (or run `/mcp` and reconnect) — you should see
the **keyoku** server with 22 tools.

## 1. The toy loop (2 minutes, zero risk)

Set the scene:

```bash
mkdir -p /tmp/keyoku-demo/inbox && touch /tmp/keyoku-demo/inbox/{a,b,c}.task
```

Paste this into Claude Code:

> Using the keyoku harness: create a goal slugged `inbox-zero` — objective
> "the demo inbox at /tmp/keyoku-demo/inbox is empty", autonomy `autonomous`,
> max 5 iterations, one criterion: command probe
> `ls /tmp/keyoku-demo/inbox | wc -l` parsed as number must equal 0.
> Then converge it: assess, act, record, re-assess until done.

Watch the loop run: the baseline assess fails (3 files), Claude clears the
inbox, records the action, re-assesses — **CONVERGED ✓** — and
`workflow_list` now shows the learned `inbox-zero` workflow.

Now test drift detection:

```bash
touch /tmp/keyoku-demo/inbox/new.task
```

> Assess the `inbox-zero` goal again.

The harness reports **DRIFT DETECTED**, reactivates the goal, and steers the
agent to re-converge.

## 2. A real one: keep this repo healthy

> Using the keyoku harness: create a goal slugged `harness-healthy` —
> objective "the keyoku-harness package builds clean and passes its tests",
> autonomy `approve`, max 10 iterations, criteria:
> 1. command probe `cd <repo>/keyoku-harness && npx tsc --noEmit; echo $?`
>    parsed as text, assert eq "0"
> 2. command probe `cd <repo>/keyoku-harness && npx vitest run --reporter=basic >/dev/null 2>&1; echo $?`
>    parsed as text, assert eq "0"
> Then assess it.

Converged immediately (everything passes today) — but now break something and
re-assess: the harness pinpoints which criterion regressed and walks Claude
through fixing it, asking your approval before each action.

Steady-state monitoring from a terminal, no agent needed:

```bash
node dist/index.js watch harness-healthy --interval 300
```

## 3. Add a connector

```text
> Add a connector named "github" running
> npx -y @modelcontextprotocol/server-github
> (with GITHUB_PERSONAL_ACCESS_TOKEN in its env), list its tools, then create
> a goal that asserts my repo has zero open issues labeled "bug" using an mcp
> probe against the search_issues tool.
```

That's the context layer: any MCP server becomes both hands (connector_call)
and eyes (mcp probes) for your goals.

## 4. Synthesize a connector from an OpenAPI spec (M3)

No MCP server needed — any API with a spec works:

> Add an openapi connector named "petstore" from
> https://petstore3.swagger.io/api/v3/openapi.json and list its tools.

You get read-only tools synthesized from the spec (GET/HEAD only by default),
at autonomy `approve`. Probe it, build criteria on it, or call it.

## 5. Watch the harness learn (M2) and gate itself (M4)

After you've converged a goal or two:

> Run harness_learn, then pattern_list.

With no API key it mines heuristically; set `GEMINI_API_KEY` or
`ANTHROPIC_API_KEY` in `.mcp.json`'s `env` for SLM-powered mining. Mined
patterns start appearing in `goal_assess` guidance for similar goals.

Now the trust ladder:

> Set the petstore connector's autonomy to approve, then try to call one of
> its tools.

The call queues instead of executing. Check `keyoku-harness approvals` in a
terminal, approve or deny it there (or via approval_approve), then look at
`keyoku-harness audit` — every step of what just happened is in the trail.

Steady-state, fleet-wide:

```bash
node dist/index.js watch --all --interval 300   # perceive drift everywhere
node dist/index.js learn                        # mine what it saw
```
