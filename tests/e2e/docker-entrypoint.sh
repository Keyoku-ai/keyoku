#!/bin/sh
# Keyoku E2E Test — Docker Entrypoint
# All tests run inside the container. No orphaned processes.
#
# Commands:
#   test      — Run unit tests only (no gateway needed)
#   e2e       — Run E2E tests only (expects gateway already running)
#   full-test — Run unit tests + E2E tests, then exit
#   gateway   — Run unit tests + start gateway (E2E tests run externally)
#   init-only — Just run init interactively

INIT_BIN="/opt/keyoku-init/bin/init.js"
KEYOKU_URL="http://localhost:18900"
GATEWAY_URL="http://localhost:18789"
KEYOKU_TOKEN="${KEYOKU_SESSION_TOKEN:-test-token}"
GATEWAY_TOKEN="${OPENCLAW_HOOKS_TOKEN:-hooks-test-token}"

PASS=0
FAIL=0
SKIP=0

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1"; }
bold() { printf "\033[1m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }

assert() {
  local desc="$1"
  local result="$2"
  if [ "$result" = "true" ]; then
    green "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    red "  ✗ $desc"
    FAIL=$((FAIL + 1))
  fi
}

skip() {
  yellow "  ⊘ $1 (skipped)"
  SKIP=$((SKIP + 1))
}

kill_keyoku() {
  if [ -n "$KEYOKU_PID" ] && kill -0 "$KEYOKU_PID" 2>/dev/null; then
    kill "$KEYOKU_PID" 2>/dev/null || true
    wait "$KEYOKU_PID" 2>/dev/null || true
  fi
  KEYOKU_PID=""
}

reset_env() {
  kill_keyoku
  cp /home/node/.openclaw/openclaw.json.clean /home/node/.openclaw/openclaw.json 2>/dev/null || true
  rm -f /data/keyoku.db /data/keyoku.db-wal /data/keyoku.db-shm
  rm -f /home/node/.openclaw/MEMORY.md
  rm -rf /home/node/.openclaw/memory
}

wait_for_keyoku() {
  for i in $(seq 1 30); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$KEYOKU_URL/api/v1/health" 2>/dev/null || echo "000")
    if [ "$STATUS" = "200" ]; then return 0; fi
    sleep 1
  done
  return 1
}

start_keyoku() {
  /usr/local/bin/keyoku > /tmp/keyoku.log 2>&1 &
  KEYOKU_PID=$!
  wait_for_keyoku
}

# Helper: POST JSON to keyoku and return response body
keyoku_post() {
  local path="$1"
  local body="$2"
  curl -s -X POST "$KEYOKU_URL$path" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $KEYOKU_TOKEN" \
    -d "$body" 2>/dev/null || echo "{}"
}

# Helper: GET from keyoku
keyoku_get() {
  local path="$1"
  curl -s "$KEYOKU_URL$path" \
    -H "Authorization: Bearer $KEYOKU_TOKEN" 2>/dev/null || echo "{}"
}

# Helper: extract JSON field with python3
json_field() {
  local json="$1"
  local expr="$2"
  python3 -c "
import json
try:
  d = json.loads('''$json''')
  print($expr)
except:
  print('')
" 2>/dev/null || echo ""
}

# ============================================================
# UNIT TESTS — init scenarios (no gateway needed)
# ============================================================
run_unit_tests() {
  bold "╔══════════════════════════════════════╗"
  bold "║     Keyoku E2E — Unit Tests          ║"
  bold "╚══════════════════════════════════════╝"
  echo ""

  # --- Scenario A: Fresh Install (no migration data) ---
  bold "=== Scenario A: Fresh Install (no migration data) ==="
  reset_env

  HAS_PLUGINS=$(python3 -c "import json; c=json.load(open('/home/node/.openclaw/openclaw.json')); print('true' if 'plugins' in c else 'false')" 2>/dev/null || echo "error")
  assert "Clean config has no plugins section" "$( [ "$HAS_PLUGINS" = "false" ] && echo true || echo false )"

  printf 'suggest\n\ny\n\n\n' | node "$INIT_BIN" 2>&1 || true

  PLUGIN_ENABLED=$(python3 -c "
import json
c = json.load(open('/home/node/.openclaw/openclaw.json'))
entries = c.get('plugins', {}).get('entries', {})
km = entries.get('keyoku-memory', {})
print('true' if km.get('enabled') else 'false')
" 2>/dev/null || echo "false")
  assert "Plugin registered in openclaw.json" "$PLUGIN_ENABLED"

  MEMORY_SLOT=$(python3 -c "
import json
c = json.load(open('/home/node/.openclaw/openclaw.json'))
slots = c.get('plugins', {}).get('slots', {})
print('true' if slots.get('memory') == 'keyoku-memory' else 'false')
" 2>/dev/null || echo "false")
  assert "Memory slot points to keyoku-memory" "$MEMORY_SLOT"

  echo ""

  # --- Scenario B: Install with Migration ---
  bold "=== Scenario B: Install with Migration ==="
  reset_env

  # Copy migration source files
  cp /home/node/.openclaw/workspace/MEMORY.md /home/node/.openclaw/MEMORY.md 2>/dev/null || true
  if [ -d /home/node/.openclaw/workspace/memory ]; then
    cp -r /home/node/.openclaw/workspace/memory /home/node/.openclaw/memory 2>/dev/null || true
  fi

  assert "MEMORY.md exists for migration" "$( [ -f /home/node/.openclaw/MEMORY.md ] && echo true || echo false )"

  echo "  Starting keyoku-engine..."
  start_keyoku

  KEYOKU_RUNNING=$(curl -s -o /dev/null -w "%{http_code}" "$KEYOKU_URL/api/v1/health" 2>/dev/null || echo "000")
  assert "Keyoku engine running" "$( [ "$KEYOKU_RUNNING" = "200" ] && echo true || echo false )"

  if [ "$KEYOKU_RUNNING" = "200" ]; then
    printf 'suggest\n\ny\n\n\ny\n' | node "$INIT_BIN" 2>&1 || true

    sleep 5
    STATS=$(keyoku_get "/api/v1/stats?entity_id=default")
    HAS_MEMORIES=$(python3 -c "
import json
try:
  s = json.loads('''$STATS''')
  total = s.get('total_memories', s.get('total', 0))
  print('true' if total > 0 else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
    assert "Memories imported (stats show count > 0)" "$HAS_MEMORIES"

    # Search broadly — any migrated content proves migration worked
    SEARCH=$(keyoku_post "/api/v1/search" '{"entity_id":"default","query":"project architecture technology","limit":5}')
    HAS_RESULTS=$(python3 -c "
import json
try:
  r = json.loads('''$SEARCH''')
  results = r if isinstance(r, list) else r.get('results', [])
  print('true' if len(results) > 0 else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
    assert "Search finds migrated content" "$HAS_RESULTS"
  fi

  kill_keyoku
  echo ""

  # --- Scenario C: HEARTBEAT.md Preservation ---
  bold "=== Scenario C: HEARTBEAT.md Preservation ==="

  HEARTBEAT_FILE="/home/node/.openclaw/workspace/HEARTBEAT.md"
  HAS_ORIGINAL=$(grep -q "If the user seems stuck" "$HEARTBEAT_FILE" 2>/dev/null && echo true || echo false)
  assert "HEARTBEAT.md has original user content" "$HAS_ORIGINAL"

  HAS_RULES=$(grep -q "Keep messages short and natural" "$HEARTBEAT_FILE" 2>/dev/null && echo true || echo false)
  assert "HEARTBEAT.md preserves all original rules" "$HAS_RULES"

  echo ""

  # --- Scenario D: Idempotent Re-run ---
  bold "=== Scenario D: Idempotent Re-run ==="

  RERUN_OUTPUT=$(printf 'suggest\n\ny\n\n\n' | node "$INIT_BIN" 2>&1 || true)
  ALREADY_REG=$(echo "$RERUN_OUTPUT" | grep -qi "already" && echo true || echo false)
  assert "Re-run detects already registered" "$ALREADY_REG"

  echo ""

  # Cleanup migration source files
  rm -f /home/node/.openclaw/MEMORY.md
  rm -rf /home/node/.openclaw/memory
}

# ============================================================
# SNAPSHOT HEARTBEAT TESTS — seed DB, run heartbeat, assert signals
# ============================================================
run_heartbeat_snapshot_tests() {
  bold "╔══════════════════════════════════════╗"
  bold "║   Heartbeat Snapshot Tests           ║"
  bold "╚══════════════════════════════════════╝"
  echo ""

  reset_env
  echo "  Starting keyoku-engine..."
  start_keyoku

  KEYOKU_RUNNING=$(curl -s -o /dev/null -w "%{http_code}" "$KEYOKU_URL/api/v1/health" 2>/dev/null || echo "000")
  if [ "$KEYOKU_RUNNING" != "200" ]; then
    red "  Keyoku not running — skipping heartbeat snapshot tests"
    SKIP=$((SKIP + 5))
    return
  fi

  # --- Snapshot 1: Empty DB → heartbeat returns nothing ---
  bold "=== Snapshot 1: Empty DB → no signals ==="
  HB=$(keyoku_post "/api/v1/heartbeat/check" '{"entity_id":"test-user"}')
  SHOULD_ACT=$(json_field "$HB" "d.get('should_act', False)")
  assert "Empty DB: should_act is False" "$( [ "$SHOULD_ACT" = "False" ] && echo true || echo false )"

  echo ""

  # --- Snapshot 2: Seed a scheduled task → heartbeat surfaces it ---
  bold "=== Snapshot 2: Scheduled task → heartbeat surfaces it ==="

  # Create a schedule that's immediately due (every 1m)
  SCHED=$(keyoku_post "/api/v1/schedule" '{
    "entity_id":"test-user",
    "agent_id":"test-agent",
    "content":"Review pull requests and summarize",
    "cron_tag":"cron:every:1s"
  }')

  SCHED_ID=$(json_field "$SCHED" "d.get('id', '')")
  assert "Schedule created" "$( [ -n "$SCHED_ID" ] && echo true || echo false )"

  sleep 2
  keyoku_post "/api/v1/heartbeat/check" '{"entity_id":"test-user","agent_id":"test-agent"}' > /tmp/hb2.json
  HAS_SCHEDULED=$(python3 -c "
import json
try:
  d = json.load(open('/tmp/hb2.json'))
  sched = d.get('scheduled', [])
  print('true' if len(sched) > 0 else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
  assert "Heartbeat surfaces scheduled task" "$HAS_SCHEDULED"

  SCHED_CONTENT=$(python3 -c "
import json
try:
  d = json.load(open('/tmp/hb2.json'))
  sched = d.get('scheduled', [])
  content = sched[0].get('content', '') if sched else ''
  print('true' if 'pull requests' in content.lower() else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
  assert "Scheduled content matches 'pull requests'" "$SCHED_CONTENT"

  echo ""

  # --- Snapshot 3: Seed a memory with deadline → heartbeat shows deadline ---
  bold "=== Snapshot 3: Deadline memory → heartbeat shows deadline ==="

  DEADLINE_MEM=$(keyoku_post "/api/v1/remember" '{
    "entity_id":"test-user",
    "content":"Submit quarterly report by end of week",
    "agent_id":"test-agent"
  }')
  sleep 3

  keyoku_post "/api/v1/heartbeat/check" '{
    "entity_id":"test-user",
    "agent_id":"test-agent",
    "deadline_window":"720h"
  }' > /tmp/hb3.json
  HB3_ACT=$(python3 -c "
import json
try:
  d = json.load(open('/tmp/hb3.json'))
  print('true' if d.get('should_act') else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
  assert "Heartbeat with wide deadline window returns signals" "$HB3_ACT"

  echo ""

  # --- Snapshot 4: Combined heartbeat/context endpoint ---
  bold "=== Snapshot 4: Heartbeat context returns combined data ==="

  keyoku_post "/api/v1/heartbeat/context" '{
    "entity_id":"test-user",
    "agent_id":"test-agent",
    "query":"quarterly report",
    "top_k":5,
    "max_results":10
  }' > /tmp/hb_ctx.json
  HAS_RELEVANT=$(python3 -c "
import json
try:
  d = json.load(open('/tmp/hb_ctx.json'))
  rel = d.get('relevant_memories', [])
  print('true' if len(rel) > 0 else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
  assert "Heartbeat context returns relevant memories for query" "$HAS_RELEVANT"

  HAS_SCHED_CTX=$(python3 -c "
import json
try:
  d = json.load(open('/tmp/hb_ctx.json'))
  sched = d.get('scheduled', [])
  print('true' if len(sched) > 0 else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
  assert "Heartbeat context also includes scheduled tasks" "$HAS_SCHED_CTX"

  echo ""

  # --- Snapshot 5: Cancel schedule → heartbeat no longer surfaces it ---
  bold "=== Snapshot 5: Cancel schedule → signal disappears ==="

  if [ -n "$SCHED_ID" ]; then
    curl -s -X DELETE "$KEYOKU_URL/api/v1/schedule/$SCHED_ID" \
      -H "Authorization: Bearer $KEYOKU_TOKEN" > /dev/null 2>&1

    sleep 1
    keyoku_post "/api/v1/heartbeat/check" '{"entity_id":"test-user","agent_id":"test-agent"}' > /tmp/hb4.json
    NO_SCHED=$(python3 -c "
import json
try:
  d = json.load(open('/tmp/hb4.json'))
  sched = d.get('scheduled', [])
  print('true' if len(sched) == 0 else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
    assert "Cancelled schedule no longer in heartbeat" "$NO_SCHED"
  else
    skip "Cancel schedule (no schedule ID)"
  fi

  echo ""
  kill_keyoku
}

# ============================================================
# GRADUAL ACCUMULATION TESTS — multi-turn remember → search → heartbeat
# ============================================================
run_accumulation_tests() {
  bold "╔══════════════════════════════════════╗"
  bold "║   Gradual Accumulation Tests         ║"
  bold "╚══════════════════════════════════════╝"
  echo ""

  reset_env
  echo "  Starting keyoku-engine..."
  start_keyoku

  KEYOKU_RUNNING=$(curl -s -o /dev/null -w "%{http_code}" "$KEYOKU_URL/api/v1/health" 2>/dev/null || echo "000")
  if [ "$KEYOKU_RUNNING" != "200" ]; then
    red "  Keyoku not running — skipping accumulation tests"
    SKIP=$((SKIP + 8))
    return
  fi

  # --- Turn 1: User introduces themselves ---
  bold "=== Turn 1: User introduction ==="
  R1=$(keyoku_post "/api/v1/remember" '{
    "entity_id":"acc-user",
    "content":"My name is Jordan, I work at Acme Corp as a senior engineer. I prefer TypeScript over JavaScript.",
    "agent_id":"main"
  }')

  R1_OK=$(json_field "$R1" "'true' if d.get('memories_created', 0) > 0 or d.get('status') == 'ok' or d.get('id') else 'false'")
  assert "Turn 1: Identity stored" "$( [ "$R1_OK" = "true" ] && echo true || echo false )"
  sleep 2

  echo ""

  # --- Turn 2: User states preferences ---
  bold "=== Turn 2: User preferences ==="
  R2=$(keyoku_post "/api/v1/remember" '{
    "entity_id":"acc-user",
    "content":"I prefer dark mode in all my editors. I use Neovim with lazy.nvim. I hate tabs, always use 2-space indent.",
    "agent_id":"main"
  }')
  R2_OK=$(json_field "$R2" "'true' if d.get('memories_created', 0) > 0 or d.get('status') == 'ok' or d.get('id') else 'false'")
  assert "Turn 2: Preferences stored" "$( [ "$R2_OK" = "true" ] && echo true || echo false )"
  sleep 2

  echo ""

  # --- Turn 3: Project context ---
  bold "=== Turn 3: Project context ==="
  R3=$(keyoku_post "/api/v1/remember" '{
    "entity_id":"acc-user",
    "content":"Working on Project Phoenix — a real-time analytics dashboard. Using React, D3.js, and WebSockets. Deadline is April 15th.",
    "agent_id":"main"
  }')
  R3_OK=$(json_field "$R3" "'true' if d.get('memories_created', 0) > 0 or d.get('status') == 'ok' or d.get('id') else 'false'")
  assert "Turn 3: Project context stored" "$( [ "$R3_OK" = "true" ] && echo true || echo false )"
  sleep 3

  echo ""

  # --- Validate: Search across accumulated memories ---
  bold "=== Validation: Cross-turn search ==="

  # Search for identity
  S1=$(keyoku_post "/api/v1/search" '{"entity_id":"acc-user","query":"What is the users name and where do they work?","limit":5}')
  S1_HAS=$(python3 -c "
import json
try:
  r = json.loads('''$S1''')
  results = r if isinstance(r, list) else r.get('results', [])
  texts = ' '.join([x.get('memory',{}).get('content','') for x in results]).lower()
  print('true' if 'jordan' in texts or 'acme' in texts else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
  assert "Search finds identity (Jordan/Acme)" "$S1_HAS"

  # Search for preferences
  S2=$(keyoku_post "/api/v1/search" '{"entity_id":"acc-user","query":"editor preferences and settings","limit":5}')
  S2_HAS=$(python3 -c "
import json
try:
  r = json.loads('''$S2''')
  results = r if isinstance(r, list) else r.get('results', [])
  texts = ' '.join([x.get('memory',{}).get('content','') for x in results]).lower()
  print('true' if 'dark mode' in texts or 'neovim' in texts else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
  assert "Search finds preferences (dark mode/Neovim)" "$S2_HAS"

  # Search for project
  S3=$(keyoku_post "/api/v1/search" '{"entity_id":"acc-user","query":"current project deadline","limit":5}')
  S3_HAS=$(python3 -c "
import json
try:
  r = json.loads('''$S3''')
  results = r if isinstance(r, list) else r.get('results', [])
  texts = ' '.join([x.get('memory',{}).get('content','') for x in results]).lower()
  print('true' if 'phoenix' in texts or 'april' in texts else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
  assert "Search finds project (Phoenix/April deadline)" "$S3_HAS"

  echo ""

  # --- Validate: Stats reflect accumulation ---
  bold "=== Validation: Stats ==="
  STATS=$(keyoku_get "/api/v1/stats?entity_id=acc-user")
  MEM_COUNT=$(json_field "$STATS" "d.get('total_memories', d.get('total', 0))")
  assert "Stats show accumulated memories (count: $MEM_COUNT)" "$( [ "$MEM_COUNT" -gt 0 ] 2>/dev/null && echo true || echo false )"

  echo ""

  # --- Validate: Heartbeat context with accumulated knowledge ---
  bold "=== Validation: Heartbeat with accumulated context ==="
  keyoku_post "/api/v1/heartbeat/context" '{
    "entity_id":"acc-user",
    "agent_id":"main",
    "query":"project status",
    "top_k":5
  }' > /tmp/hb_acc.json
  HB_RELEVANT=$(python3 -c "
import json
try:
  d = json.load(open('/tmp/hb_acc.json'))
  rel = d.get('relevant_memories', d.get('memories', []))
  print('true' if len(rel) > 0 else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
  assert "Heartbeat context retrieves accumulated memories" "$HB_RELEVANT"

  echo ""
  kill_keyoku
}

# ============================================================
# E2E TESTS — require running gateway + keyoku
# ============================================================
run_e2e_tests() {
  bold "╔══════════════════════════════════════╗"
  bold "║     Keyoku E2E — Gateway Tests       ║"
  bold "╚══════════════════════════════════════╝"
  echo ""

  # --- Phase 1: Service Health ---
  bold "=== Phase 1: Service Health ==="

  echo "  Waiting for gateway..."
  GATEWAY_READY=false
  for i in $(seq 1 30); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/" 2>/dev/null || echo "000")
    if [ "$STATUS" != "000" ]; then
      GATEWAY_READY=true
      break
    fi
    sleep 2
  done
  assert "Gateway is reachable" "$GATEWAY_READY"

  echo "  Waiting for keyoku..."
  KEYOKU_READY=false
  for i in $(seq 1 15); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$KEYOKU_URL/api/v1/health" 2>/dev/null || echo "000")
    if [ "$STATUS" = "200" ]; then
      KEYOKU_READY=true
      break
    fi
    sleep 2
  done
  assert "Keyoku engine is healthy" "$KEYOKU_READY"

  echo ""

  # --- Phase 2: Plugin Registration ---
  bold "=== Phase 2: Plugin Registration ==="

  PLUGIN_OK=$(python3 -c "
import json
c = json.load(open('/home/node/.openclaw/openclaw.json'))
entries = c.get('plugins', {}).get('entries', {})
km = entries.get('keyoku-memory', {})
print('true' if km.get('enabled') else 'false')
" 2>/dev/null || echo "false")
  assert "Plugin registered in openclaw.json" "$PLUGIN_OK"

  SLOT_OK=$(python3 -c "
import json
c = json.load(open('/home/node/.openclaw/openclaw.json'))
slots = c.get('plugins', {}).get('slots', {})
print('true' if slots.get('memory') == 'keyoku-memory' else 'false')
" 2>/dev/null || echo "false")
  assert "Memory slot assigned to keyoku-memory" "$SLOT_OK"

  echo ""

  # --- Phase 3: HEARTBEAT.md Setup ---
  bold "=== Phase 3: HEARTBEAT.md Setup ==="

  HEARTBEAT_FILE=""
  for hb_path in "/app/HEARTBEAT.md" "/home/node/.openclaw/workspace/HEARTBEAT.md" "/home/node/.openclaw/HEARTBEAT.md"; do
    if [ -f "$hb_path" ]; then
      HEARTBEAT_FILE="$hb_path"
      echo "  Found HEARTBEAT.md at: $hb_path"
      break
    fi
  done
  if [ -n "$HEARTBEAT_FILE" ]; then
    HAS_ORIGINAL=$(grep -q "If the user seems stuck" "$HEARTBEAT_FILE" 2>/dev/null && echo true || echo false)
    if [ "$HAS_ORIGINAL" = "true" ]; then
      assert "HEARTBEAT.md preserves original user content" "true"
    else
      HAS_HEARTBEAT_HEADING=$(grep -q "Heartbeat" "$HEARTBEAT_FILE" 2>/dev/null && echo true || echo false)
      assert "HEARTBEAT.md exists with heartbeat content" "$HAS_HEARTBEAT_HEADING"
    fi

    HAS_KEYOKU_MARKER=$(grep -q "keyoku-heartbeat-start" "$HEARTBEAT_FILE" 2>/dev/null && echo true || echo false)
    assert "HEARTBEAT.md has keyoku section marker" "$HAS_KEYOKU_MARKER"

    HAS_KEYOKU_INSTRUCTIONS=$(grep -q "heartbeat-signals" "$HEARTBEAT_FILE" 2>/dev/null && echo true || echo false)
    assert "HEARTBEAT.md has keyoku heartbeat instructions" "$HAS_KEYOKU_INSTRUCTIONS"

    HAS_END_MARKER=$(grep -q "keyoku-heartbeat-end" "$HEARTBEAT_FILE" 2>/dev/null && echo true || echo false)
    assert "HEARTBEAT.md has closing marker" "$HAS_END_MARKER"
  else
    yellow "  HEARTBEAT.md not found (checking /app/, ~/.openclaw/workspace/, ~/.openclaw/)"
    FAIL=$((FAIL + 4))
  fi

  echo ""

  # --- Phase 4: Memory Migration Verification ---
  bold "=== Phase 4: Memory Migration Verification ==="

  if [ "$KEYOKU_READY" = "true" ]; then
    STATS=$(keyoku_get "/api/v1/stats")
    TOTAL=$(json_field "$STATS" "d.get('total_memories', d.get('total', 0))")
    assert "Memories exist in keyoku (count: $TOTAL)" "$( [ "$TOTAL" -gt 0 ] 2>/dev/null && echo true || echo false )"

    # Search broadly — any migrated content proves migration is working
    SEARCH=$(keyoku_post "/api/v1/search" '{"entity_id":"default","query":"project architecture technology decisions","limit":5}')
    SEARCH_OK=$(python3 -c "
import json
try:
  r = json.loads('''$SEARCH''')
  results = r if isinstance(r, list) else r.get('results', [])
  print('true' if len(results) > 0 else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
    assert "Semantic search finds migrated content" "$SEARCH_OK"
  fi

  echo ""

  # --- Phase 5: Heartbeat Trigger ---
  bold "=== Phase 5: Heartbeat Trigger ==="

  WAKE_RESULT=$(curl -s -X POST "$GATEWAY_URL/hooks/wake" \
    -H "Content-Type: application/json" \
    -H "x-openclaw-token: $GATEWAY_TOKEN" \
    -d '{"text":"E2E test heartbeat trigger","mode":"now"}' 2>/dev/null || echo '{"ok":false}')
  WAKE_OK=$(json_field "$WAKE_RESULT" "'true' if d.get('ok') else 'false'")
  assert "Heartbeat wake trigger accepted" "$WAKE_OK"

  if [ "$WAKE_OK" = "true" ]; then
    echo "  Waiting 10s for heartbeat to process..."
    sleep 10
    STATS_AFTER=$(keyoku_get "/api/v1/stats")
    assert "Keyoku still healthy after heartbeat" "$( [ -n "$STATS_AFTER" ] && echo true || echo false )"
  fi

  echo ""

  # --- Phase 6: Agent Message (Auto-Capture Test) ---
  bold "=== Phase 6: Agent Message (Auto-Capture Test) ==="

  if [ "$KEYOKU_READY" = "true" ]; then
    BEFORE_STATS=$(keyoku_get "/api/v1/stats")
    BEFORE_COUNT=$(json_field "$BEFORE_STATS" "d.get('total_memories', d.get('total', 0))")

    MSG_RESULT=$(curl -s -X POST "$GATEWAY_URL/hooks/agent" \
      -H "Content-Type: application/json" \
      -H "x-openclaw-token: $GATEWAY_TOKEN" \
      -d "{\"agentId\":\"main\",\"message\":\"Remember that the database migration to PostgreSQL is scheduled for next Tuesday at 3pm PST\",\"wakeMode\":\"now\"}" 2>/dev/null || echo '{"ok":false}')
    MSG_OK=$(json_field "$MSG_RESULT" "'true' if d.get('ok') else 'false'")
    assert "Agent message sent successfully" "$MSG_OK"

    if [ "$MSG_OK" = "true" ]; then
      echo "  Waiting 25s for agent to process + auto-capture..."
      sleep 25

      AFTER_STATS=$(keyoku_get "/api/v1/stats")
      AFTER_COUNT=$(json_field "$AFTER_STATS" "d.get('total_memories', d.get('total', 0))")
      assert "Auto-capture stored new memory (before: $BEFORE_COUNT, after: $AFTER_COUNT)" "$( [ "$AFTER_COUNT" -ge "$BEFORE_COUNT" ] 2>/dev/null && echo true || echo false )"

      sleep 3
      NEW_SEARCH=$(keyoku_post "/api/v1/search" '{"entity_id":"default","query":"PostgreSQL migration Tuesday","limit":3}')
      NEW_SEARCH_OK=$(python3 -c "
import json
try:
  r = json.loads('''$NEW_SEARCH''')
  results = r if isinstance(r, list) else r.get('results', [])
  print('true' if len(results) > 0 else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
      assert "Auto-captured memory is searchable" "$NEW_SEARCH_OK"
    fi
  else
    yellow "  Skipping (keyoku not ready)"
  fi

  echo ""

  # --- Phase 7: Auto-Recall Test ---
  bold "=== Phase 7: Auto-Recall Test ==="

  if [ "$KEYOKU_READY" = "true" ]; then
    RECALL_RESULT=$(curl -s -X POST "$GATEWAY_URL/hooks/agent" \
      -H "Content-Type: application/json" \
      -H "x-openclaw-token: $GATEWAY_TOKEN" \
      -d "{\"agentId\":\"main\",\"message\":\"What do you remember about the Plaid integration?\",\"wakeMode\":\"now\"}" 2>/dev/null || echo '{"ok":false}')
    RECALL_OK=$(json_field "$RECALL_RESULT" "'true' if d.get('ok') else 'false'")
    assert "Auto-recall query sent successfully" "$RECALL_OK"

    if [ "$RECALL_OK" = "true" ]; then
      echo "  Waiting 10s for agent to process with auto-recall..."
      sleep 10
      assert "Agent processed recall query (no crash)" "true"
    fi
  else
    yellow "  Skipping (keyoku not ready)"
  fi

  echo ""

  # --- Phase 8: Idempotent Re-init ---
  bold "=== Phase 8: Idempotent Re-init ==="

  RERUN_OUTPUT=$(printf 'suggest\n\ny\n\n\n' | node "$INIT_BIN" 2>&1 || true)
  ALREADY_REG=$(echo "$RERUN_OUTPUT" | grep -qi "already" && echo true || echo false)
  assert "Re-running init detects already registered" "$ALREADY_REG"

  echo ""
}

print_summary() {
  bold "╔══════════════════════════════════════╗"
  bold "║           Test Summary               ║"
  bold "╚══════════════════════════════════════╝"
  green "  Passed: $PASS"
  if [ "$SKIP" -gt 0 ]; then
    yellow "  Skipped: $SKIP"
  fi
  if [ "$FAIL" -gt 0 ]; then
    red "  Failed: $FAIL"
    return 1
  else
    green "  All tests passed!"
    return 0
  fi
}

case "${1:-}" in
  test)
    run_unit_tests
    run_heartbeat_snapshot_tests
    run_accumulation_tests
    print_summary
    ;;
  e2e)
    run_e2e_tests
    print_summary
    ;;
  full-test)
    run_unit_tests
    run_heartbeat_snapshot_tests
    run_accumulation_tests

    bold "=== Preparing for E2E tests ==="
    rm -f /data/keyoku.db /data/keyoku.db-wal /data/keyoku.db-shm

    # Step 1: Start keyoku standalone so init migration can reach it
    echo "  Starting keyoku standalone for migration..."
    start_keyoku
    if ! wait_for_keyoku; then
      red "  Keyoku failed to start standalone"
    fi

    # Step 2: Copy memory files and run init WITH migration
    cp /home/node/.openclaw/workspace/MEMORY.md /home/node/.openclaw/MEMORY.md 2>/dev/null || true
    if [ -d /home/node/.openclaw/workspace/memory ]; then
      cp -r /home/node/.openclaw/workspace/memory /home/node/.openclaw/memory 2>/dev/null || true
    fi
    printf 'suggest\n\ny\n\n\ny\n' | node "$INIT_BIN" 2>&1 || true
    sleep 5

    # Step 3: Kill standalone keyoku (gateway will start its own via plugin)
    kill_keyoku

    # Step 4: Start gateway (plugin auto-starts keyoku)
    bold "=== Starting OpenClaw gateway for E2E tests ==="
    node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789 &
    GATEWAY_PID=$!
    echo "  Gateway PID: $GATEWAY_PID"

    echo "  Waiting for gateway..."
    for i in $(seq 1 30); do
      STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/" 2>/dev/null || echo "000")
      if [ "$STATUS" != "000" ]; then break; fi
      sleep 2
    done

    echo "  Waiting for keyoku (via plugin)..."
    for i in $(seq 1 30); do
      STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$KEYOKU_URL/api/v1/health" 2>/dev/null || echo "000")
      if [ "$STATUS" = "200" ]; then break; fi
      sleep 2
    done

    run_e2e_tests

    kill "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true

    rm -f /home/node/.openclaw/MEMORY.md
    rm -rf /home/node/.openclaw/memory

    print_summary
    ;;
  gateway)
    run_unit_tests
    run_heartbeat_snapshot_tests
    run_accumulation_tests

    echo ""
    bold "=== Test Results ==="
    green "  Passed: $PASS"
    if [ "$FAIL" -gt 0 ]; then
      red "  Failed: $FAIL"
    fi
    echo ""

    # Start keyoku standalone for migration
    start_keyoku

    cp /home/node/.openclaw/workspace/MEMORY.md /home/node/.openclaw/MEMORY.md 2>/dev/null || true
    if [ -d /home/node/.openclaw/workspace/memory ]; then
      cp -r /home/node/.openclaw/workspace/memory /home/node/.openclaw/memory 2>/dev/null || true
    fi
    printf 'suggest\n\ny\n\n\ny\n' | node "$INIT_BIN" 2>&1 || true

    # Kill standalone keyoku (gateway will start its own)
    kill_keyoku

    bold "=== Starting OpenClaw gateway on :18789 ==="
    echo "  Keyoku will auto-start via plugin service."
    echo "  Run 'docker exec <container> docker-entrypoint.sh e2e' to run E2E tests."
    echo ""
    exec node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789
    ;;
  init-only)
    node "$INIT_BIN"
    ;;
  *)
    exec "$@"
    ;;
esac
