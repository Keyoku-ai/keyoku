#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KEYOKU_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
INIT_BIN="$KEYOKU_DIR/packages/openclaw/bin/init.js"

echo "=== Keyoku Init Test — Full Run ==="
echo ""

# Step 1: Setup environment
"$SCRIPT_DIR/setup.sh" "$@"

# Step 2: Load env
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  . "$SCRIPT_DIR/.env"
  set +a
fi

# Step 3: Run init (interactive — user answers migration prompt)
echo ""
echo "=== Running: keyoku-init ==="
echo ""
node "$INIT_BIN"

# Step 4: Start gateway
echo ""
echo "=== Starting OpenClaw gateway on :18789 ==="
echo "Keyoku will auto-start via plugin service."
echo ""
exec openclaw gateway --allow-unconfigured --port 18789
