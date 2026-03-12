#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KEYOKU_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
INIT_BIN="$KEYOKU_DIR/packages/openclaw/bin/init.js"
PASS=0
FAIL=0

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1"; }
bold() { printf "\033[1m%s\033[0m\n" "$1"; }

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

kill_keyoku() {
  if [ -n "$KEYOKU_PID" ] && kill -0 "$KEYOKU_PID" 2>/dev/null; then
    kill "$KEYOKU_PID" 2>/dev/null || true
    wait "$KEYOKU_PID" 2>/dev/null || true
  fi
  KEYOKU_PID=""
}

# Full cleanup — reset everything to pristine state
full_cleanup() {
  kill_keyoku
  rm -f /tmp/keyoku-init-test.db /tmp/keyoku-init-test.db-wal /tmp/keyoku-init-test.db-shm
  rm -f /tmp/keyoku-init-test.log
  rm -f ~/.openclaw/MEMORY.md
  rm -rf ~/.openclaw/memory
  rm -rf ~/.openclaw/skills/keyoku-memory
  rm -f ~/.keyoku/.env
  # Reset openclaw.json to clean (no plugins)
  if [ -f "$SCRIPT_DIR/openclaw.json" ]; then
    cp "$SCRIPT_DIR/openclaw.json" ~/.openclaw/openclaw.json 2>/dev/null || true
  fi
}

trap full_cleanup EXIT

# Load env once (API keys for keyoku extraction)
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  . "$SCRIPT_DIR/.env"
  set +a
fi

# Initial cleanup — remove leftovers from previous runs
bold "=== Cleaning up previous test runs ==="
full_cleanup
rm -rf ~/.openclaw/workspace/memory
rm -f ~/.openclaw/workspace/MEMORY.md
rm -f ~/.openclaw/workspace/HEARTBEAT.md
rm -rf ~/.openclaw/skills/keyoku-memory
rm -f ~/.keyoku/.env
green "  Done"
echo ""

# ============================================================
bold "=== Scenario A: Fresh Install (no migration data) ==="
# ============================================================

full_cleanup
"$SCRIPT_DIR/setup.sh" --no-memory > /dev/null 2>&1

# Verify config has NO plugins section
HAS_PLUGINS=$(python3 -c "import json; c=json.load(open('$HOME/.openclaw/openclaw.json')); print('true' if 'plugins' in c else 'false')" 2>/dev/null || echo "error")
assert "Clean config has no plugins section" "$( [ "$HAS_PLUGINS" = "false" ] && echo true || echo false )"

# Run init — pipe answers for all prompts (OPENAI_API_KEY already in env, so no key prompt):
# 1. autonomy (suggest), 2. timezone (accept default), 3. quiet hours (yes),
# 4. quiet start (default 23), 5. quiet end (default 7)
# No migration prompt since --no-memory was used
printf 'suggest\n\ny\n\n\n' | node "$INIT_BIN" 2>&1 || true

# Verify plugin registered
PLUGIN_ENABLED=$(python3 -c "
import json
c = json.load(open('$HOME/.openclaw/openclaw.json'))
entries = c.get('plugins', {}).get('entries', {})
km = entries.get('keyoku-memory', {})
print('true' if km.get('enabled') else 'false')
" 2>/dev/null || echo "false")
assert "Plugin registered in openclaw.json" "$PLUGIN_ENABLED"

MEMORY_SLOT=$(python3 -c "
import json
c = json.load(open('$HOME/.openclaw/openclaw.json'))
slots = c.get('plugins', {}).get('slots', {})
print('true' if slots.get('memory') == 'keyoku-memory' else 'false')
" 2>/dev/null || echo "false")
assert "Memory slot points to keyoku-memory" "$MEMORY_SLOT"

echo ""

# ============================================================
bold "=== Scenario B: Install with Migration ==="
# ============================================================

# Clean slate
full_cleanup
"$SCRIPT_DIR/setup.sh" > /dev/null 2>&1

# Verify memory files exist at migration source paths
assert "MEMORY.md exists for migration" "$( [ -f "$HOME/.openclaw/MEMORY.md" ] && echo true || echo false )"
assert "memory/2026-03-08.md exists" "$( [ -f "$HOME/.openclaw/memory/2026-03-08.md" ] && echo true || echo false )"
assert "memory/2026-03-09.md exists" "$( [ -f "$HOME/.openclaw/memory/2026-03-09.md" ] && echo true || echo false )"

# Set token for both keyoku AND init client
export KEYOKU_SESSION_TOKEN=test-token

# Start keyoku-engine for migration
echo "  Starting keyoku-engine for migration..."
KEYOKU_DB_PATH="/tmp/keyoku-init-test.db" \
KEYOKU_PORT=18900 \
KEYOKU_EXTRACTION_PROVIDER="${KEYOKU_EXTRACTION_PROVIDER:-gemini}" \
KEYOKU_EXTRACTION_MODEL="${KEYOKU_EXTRACTION_MODEL:-gemini-3.1-flash-lite-preview}" \
~/.keyoku/bin/keyoku > /tmp/keyoku-init-test.log 2>&1 &
KEYOKU_PID=$!
sleep 3

# Verify keyoku is running
KEYOKU_RUNNING=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:18900/api/v1/health 2>/dev/null || echo "000")
assert "Keyoku engine running" "$( [ "$KEYOKU_RUNNING" = "200" ] && echo true || echo false )"

if [ "$KEYOKU_RUNNING" = "200" ]; then
  # Run init with migration — pipe answers for all prompts:
  # 1. autonomy (suggest), 2. timezone (accept), 3. quiet hours (yes),
  # 4. start (default), 5. end (default), 6. migration (y)
  printf 'suggest\n\ny\n\n\ny\n' | node "$INIT_BIN" 2>&1 || true

  # Wait for embeddings to index
  sleep 5
  STATS=$(curl -s "http://localhost:18900/api/v1/stats?entity_id=default" -H "Authorization: Bearer test-token" 2>/dev/null || echo "{}")
  HAS_MEMORIES=$(python3 -c "
import json, sys
try:
  s = json.loads('''$STATS''')
  total = s.get('total_memories', s.get('total', 0))
  print('true' if total > 0 else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
  assert "Memories imported (stats show count > 0)" "$HAS_MEMORIES"

  # Test search (POST, not GET)
  SEARCH=$(curl -s -X POST "http://localhost:18900/api/v1/search" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test-token" \
    -d '{"entity_id":"default","query":"Plaid","limit":3}' 2>/dev/null || echo "[]")
  HAS_RESULTS=$(python3 -c "
import json
try:
  r = json.loads('''$SEARCH''')
  results = r if isinstance(r, list) else r.get('results', [])
  print('true' if len(results) > 0 else 'false')
except:
  print('false')
" 2>/dev/null || echo "false")
  assert "Search for 'Plaid' returns results" "$HAS_RESULTS"
fi

kill_keyoku

echo ""

# ============================================================
bold "=== Scenario C: Plugin Config Defaults ==="
# ============================================================

# Verify plugin config has all expected defaults
PLUGIN_CFG=$(python3 -c "
import json
c = json.load(open('$HOME/.openclaw/openclaw.json'))
cfg = c.get('plugins', {}).get('entries', {}).get('keyoku-memory', {}).get('config', {})
print(json.dumps(cfg))
" 2>/dev/null || echo "{}")

HAS_URL=$(python3 -c "
import json
cfg = json.loads('''$PLUGIN_CFG''')
print('true' if cfg.get('keyokuUrl') == 'http://localhost:18900' else 'false')
" 2>/dev/null || echo "false")
assert "Plugin config has keyokuUrl" "$HAS_URL"

HAS_AUTO_RECALL=$(python3 -c "
import json
cfg = json.loads('''$PLUGIN_CFG''')
print('true' if cfg.get('autoRecall') == True else 'false')
" 2>/dev/null || echo "false")
assert "Plugin config has autoRecall=true" "$HAS_AUTO_RECALL"

HAS_AUTO_CAPTURE=$(python3 -c "
import json
cfg = json.loads('''$PLUGIN_CFG''')
print('true' if cfg.get('autoCapture') == True else 'false')
" 2>/dev/null || echo "false")
assert "Plugin config has autoCapture=true" "$HAS_AUTO_CAPTURE"

HAS_HEARTBEAT=$(python3 -c "
import json
cfg = json.loads('''$PLUGIN_CFG''')
print('true' if cfg.get('heartbeat') == True else 'false')
" 2>/dev/null || echo "false")
assert "Plugin config has heartbeat=true" "$HAS_HEARTBEAT"

HAS_TOPK=$(python3 -c "
import json
cfg = json.loads('''$PLUGIN_CFG''')
print('true' if cfg.get('topK') == 5 else 'false')
" 2>/dev/null || echo "false")
assert "Plugin config has topK=5" "$HAS_TOPK"

echo ""

# ============================================================
bold "=== Scenario D: LLM Provider Env File ==="
# ============================================================

# Check that init created ~/.keyoku/.env with extraction config
ENV_FILE="$HOME/.keyoku/.env"
assert "~/.keyoku/.env exists" "$( [ -f "$ENV_FILE" ] && echo true || echo false )"

HAS_EXTRACTION_PROVIDER=$(grep -q "KEYOKU_EXTRACTION_PROVIDER=" "$ENV_FILE" 2>/dev/null && echo true || echo false)
assert "Env file has KEYOKU_EXTRACTION_PROVIDER" "$HAS_EXTRACTION_PROVIDER"

HAS_EXTRACTION_MODEL=$(grep -q "KEYOKU_EXTRACTION_MODEL=" "$ENV_FILE" 2>/dev/null && echo true || echo false)
assert "Env file has KEYOKU_EXTRACTION_MODEL" "$HAS_EXTRACTION_MODEL"

HAS_DB_PATH=$(grep -q "KEYOKU_DB_PATH=" "$ENV_FILE" 2>/dev/null && echo true || echo false)
assert "Env file has KEYOKU_DB_PATH" "$HAS_DB_PATH"

echo ""

# ============================================================
bold "=== Scenario E: HEARTBEAT.md Preservation ==="
# ============================================================

HEARTBEAT_FILE="$HOME/.openclaw/workspace/HEARTBEAT.md"
HAS_ORIGINAL=$(grep -q "If the user seems stuck" "$HEARTBEAT_FILE" 2>/dev/null && echo true || echo false)
assert "HEARTBEAT.md has original user content" "$HAS_ORIGINAL"

HAS_RULES=$(grep -q "Keep messages short and natural" "$HEARTBEAT_FILE" 2>/dev/null && echo true || echo false)
assert "HEARTBEAT.md preserves all original rules" "$HAS_RULES"

echo ""

# ============================================================
bold "=== Scenario F: Idempotent Re-run ==="
# ============================================================

# Pipe answers: autonomy (suggest), tz (accept), quiet (yes), start (default), end (default)
RERUN_OUTPUT=$(printf 'suggest\n\ny\n\n\n' | node "$INIT_BIN" 2>&1 || true)
ALREADY_REG=$(echo "$RERUN_OUTPUT" | grep -qi "already" && echo true || echo false)
assert "Re-run detects already registered" "$ALREADY_REG"

echo ""

# ============================================================
bold "=== Scenario G: Autonomy Level ==="
# ============================================================

# Fresh install with explicit autonomy selection
full_cleanup
"$SCRIPT_DIR/setup.sh" --no-memory > /dev/null 2>&1

# Pipe: act autonomy, accept tz, enable quiet, defaults
printf 'act\n\ny\n\n\n' | node "$INIT_BIN" 2>&1 || true

AUTONOMY_SET=$(python3 -c "
import json
c = json.load(open('$HOME/.openclaw/openclaw.json'))
cfg = c.get('plugins', {}).get('entries', {}).get('keyoku-memory', {}).get('config', {})
print('true' if cfg.get('autonomy') == 'act' else 'false')
" 2>/dev/null || echo "false")
assert "Autonomy level saved as 'act' in plugin config" "$AUTONOMY_SET"

# Verify default when invalid input
full_cleanup
"$SCRIPT_DIR/setup.sh" --no-memory > /dev/null 2>&1
printf 'invalid-input\n\ny\n\n\n' | node "$INIT_BIN" 2>&1 || true

AUTONOMY_DEFAULT=$(python3 -c "
import json
c = json.load(open('$HOME/.openclaw/openclaw.json'))
cfg = c.get('plugins', {}).get('entries', {}).get('keyoku-memory', {}).get('config', {})
print('true' if cfg.get('autonomy') == 'suggest' else 'false')
" 2>/dev/null || echo "false")
assert "Invalid autonomy input defaults to 'suggest'" "$AUTONOMY_DEFAULT"

echo ""

# ============================================================
bold "=== Scenario H: Timezone & Quiet Hours ==="
# ============================================================

# Check env file from previous run for timezone/quiet hours
ENV_FILE="$HOME/.keyoku/.env"

HAS_TIMEZONE=$(grep -q "KEYOKU_QUIET_HOURS_TIMEZONE=" "$ENV_FILE" 2>/dev/null && echo true || echo false)
assert "Env file has timezone" "$HAS_TIMEZONE"

HAS_QUIET_ENABLED=$(grep -q "KEYOKU_QUIET_HOURS_ENABLED=" "$ENV_FILE" 2>/dev/null && echo true || echo false)
assert "Env file has quiet hours enabled flag" "$HAS_QUIET_ENABLED"

HAS_QUIET_START=$(grep -q "KEYOKU_QUIET_HOUR_START=" "$ENV_FILE" 2>/dev/null && echo true || echo false)
assert "Env file has quiet hour start" "$HAS_QUIET_START"

HAS_QUIET_END=$(grep -q "KEYOKU_QUIET_HOUR_END=" "$ENV_FILE" 2>/dev/null && echo true || echo false)
assert "Env file has quiet hour end" "$HAS_QUIET_END"

# Test with custom quiet hours
full_cleanup
"$SCRIPT_DIR/setup.sh" --no-memory > /dev/null 2>&1
# Pipe: suggest autonomy, custom tz, enable quiet, start=22, end=8
printf 'suggest\nAmerica/New_York\ny\n22\n8\n' | node "$INIT_BIN" 2>&1 || true

CUSTOM_TZ=$(grep -q "KEYOKU_QUIET_HOURS_TIMEZONE=America/New_York" "$ENV_FILE" 2>/dev/null && echo true || echo false)
assert "Custom timezone saved (America/New_York)" "$CUSTOM_TZ"

CUSTOM_START=$(grep -q "KEYOKU_QUIET_HOUR_START=22" "$ENV_FILE" 2>/dev/null && echo true || echo false)
assert "Custom quiet start saved (22)" "$CUSTOM_START"

CUSTOM_END=$(grep -q "KEYOKU_QUIET_HOUR_END=8" "$ENV_FILE" 2>/dev/null && echo true || echo false)
assert "Custom quiet end saved (8)" "$CUSTOM_END"

# Test with quiet hours disabled
full_cleanup
"$SCRIPT_DIR/setup.sh" --no-memory > /dev/null 2>&1
printf 'suggest\n\nn\n' | node "$INIT_BIN" 2>&1 || true

QUIET_DISABLED=$(grep -q "KEYOKU_QUIET_HOURS_ENABLED=false" "$ENV_FILE" 2>/dev/null && echo true || echo false)
assert "Quiet hours disabled when user says no" "$QUIET_DISABLED"

echo ""

# ============================================================
bold "=== Scenario I: SKILL.md Installation ==="
# ============================================================

SKILL_PATH="$HOME/.openclaw/skills/keyoku-memory/SKILL.md"
assert "SKILL.md installed to workspace" "$( [ -f "$SKILL_PATH" ] && echo true || echo false )"

# Verify skill content
HAS_MEMORY_SYSTEM=$(grep -q "Memory System" "$SKILL_PATH" 2>/dev/null && echo true || echo false)
assert "SKILL.md has Memory System header" "$HAS_MEMORY_SYSTEM"

HAS_HEARTBEAT_SECTION=$(grep -q "heartbeat" "$SKILL_PATH" 2>/dev/null && echo true || echo false)
assert "SKILL.md has heartbeat section" "$HAS_HEARTBEAT_SECTION"

HAS_AUTONOMY_MODES=$(grep -q "observe" "$SKILL_PATH" 2>/dev/null && echo true || echo false)
assert "SKILL.md documents autonomy modes" "$HAS_AUTONOMY_MODES"

# Test idempotency — re-run should skip
SKILL_MTIME_BEFORE=$(stat -f %m "$SKILL_PATH" 2>/dev/null || stat -c %Y "$SKILL_PATH" 2>/dev/null || echo "0")
sleep 1
printf 'suggest\n\ny\n\n\n' | node "$INIT_BIN" 2>&1 || true
SKILL_MTIME_AFTER=$(stat -f %m "$SKILL_PATH" 2>/dev/null || stat -c %Y "$SKILL_PATH" 2>/dev/null || echo "0")
assert "SKILL.md not overwritten on re-run (idempotent)" "$( [ "$SKILL_MTIME_BEFORE" = "$SKILL_MTIME_AFTER" ] && echo true || echo false )"

echo ""

# ============================================================
bold "=== Scenario J: Health Check ==="
# ============================================================

# Health check should gracefully handle engine not running
HEALTH_OUTPUT=$(printf 'suggest\n\ny\n\n\n' | node "$INIT_BIN" 2>&1 || true)
HAS_HEALTH_MSG=$(echo "$HEALTH_OUTPUT" | grep -qi "auto-start\|health\|not running" && echo true || echo false)
assert "Health check reports status when engine not running" "$HAS_HEALTH_MSG"

echo ""

# ============================================================
# Summary
# ============================================================
bold "=== Results ==="
green "  Passed: $PASS"
if [ "$FAIL" -gt 0 ]; then
  red "  Failed: $FAIL"
  exit 1
else
  green "  All tests passed!"
fi
