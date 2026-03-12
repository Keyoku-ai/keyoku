#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KEYOKU_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ROOT_DIR="$(cd "$KEYOKU_DIR/.." && pwd)"
NO_MEMORY=false

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --no-memory) NO_MEMORY=true ;;
  esac
done

echo "=== Keyoku Init Test — Environment Setup ==="
echo ""

# Step 1: Build keyoku-engine binary
echo "=== Building keyoku-engine ==="
mkdir -p ~/.keyoku/bin
if [ -f ~/.keyoku/bin/keyoku ] && [ "$FORCE_REBUILD" != "true" ]; then
  echo "Binary already exists, skipping build (use FORCE_REBUILD=true to rebuild)"
else
  if [ -d "$ROOT_DIR/keyoku-engine" ]; then
    (cd "$ROOT_DIR/keyoku-engine" && go build -o ~/.keyoku/bin/keyoku ./cmd/keyoku-server)
  else
    echo "keyoku-engine not found at $ROOT_DIR/keyoku-engine — skipping binary build"
    echo "Download from: https://github.com/Keyoku-ai/keyoku-engine/releases"
  fi
fi
echo "Binary: ~/.keyoku/bin/keyoku"

# Step 2: Build keyoku TS packages
echo ""
echo "=== Building keyoku TypeScript packages ==="
if [ -d "$KEYOKU_DIR/packages/openclaw/dist" ] && [ "$FORCE_REBUILD" != "true" ]; then
  echo "Already built, skipping (use FORCE_REBUILD=true to rebuild)"
else
  (cd "$KEYOKU_DIR" && npm install --ignore-scripts && npm run build)
fi

# Step 3: Install plugin to OpenClaw extensions
echo ""
echo "=== Installing plugin into OpenClaw extensions ==="
PLUGIN_DIR="$HOME/.openclaw/extensions/keyoku-memory"
rm -rf "$PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR/dist" "$PLUGIN_DIR/node_modules/@keyoku"

# Copy built dist files
cp -r "$KEYOKU_DIR/packages/types/dist/" "$PLUGIN_DIR/dist/types/"
cp -r "$KEYOKU_DIR/packages/memory/dist/" "$PLUGIN_DIR/dist/memory/"
cp -r "$KEYOKU_DIR/packages/openclaw/dist/" "$PLUGIN_DIR/dist/openclaw/"

# Symlink internal packages
ln -sf ../../dist/types "$PLUGIN_DIR/node_modules/@keyoku/types"
ln -sf ../../dist/memory "$PLUGIN_DIR/node_modules/@keyoku/memory"

# Copy typebox dependency
if [ -d "$KEYOKU_DIR/node_modules/@sinclair" ]; then
  cp -r "$KEYOKU_DIR/node_modules/@sinclair" "$PLUGIN_DIR/node_modules/@sinclair"
fi

# Copy plugin manifest
cp "$SCRIPT_DIR/openclaw.plugin.json" "$PLUGIN_DIR/openclaw.plugin.json"

# Create entry point
cat > "$PLUGIN_DIR/index.js" << 'ENTRY'
import keyokuMemory from './dist/openclaw/index.js';
const plugin = keyokuMemory();
export default plugin;
ENTRY

# Create package.json for OpenClaw discovery
cat > "$PLUGIN_DIR/package.json" << 'PKG'
{
  "name": "keyoku-memory",
  "version": "2.0.0",
  "openclaw": { "extensions": ["index.js"] }
}
PKG

echo "Plugin installed at: $PLUGIN_DIR"

# Step 4: Copy clean OpenClaw config (NO plugins section)
echo ""
echo "=== Setting up clean OpenClaw environment ==="
mkdir -p ~/.openclaw
cp "$SCRIPT_DIR/openclaw.json" ~/.openclaw/openclaw.json
echo "Config: ~/.openclaw/openclaw.json (clean, no plugins)"

# Step 5: Copy workspace files
mkdir -p ~/.openclaw/workspace

if [ "$NO_MEMORY" = true ]; then
  echo "Skipping memory files (--no-memory flag)"
  # Clean up any leftover migration sources
  rm -f ~/.openclaw/MEMORY.md
  rm -rf ~/.openclaw/memory
  # Only copy HEARTBEAT.md without memory data
  cp "$SCRIPT_DIR/workspace/HEARTBEAT.md" ~/.openclaw/workspace/HEARTBEAT.md
else
  cp -r "$SCRIPT_DIR/workspace/" ~/.openclaw/workspace/
  # Init checks ~/.openclaw/MEMORY.md and ~/.openclaw/memory/ (not workspace/)
  cp "$SCRIPT_DIR/workspace/MEMORY.md" ~/.openclaw/MEMORY.md
  cp -r "$SCRIPT_DIR/workspace/memory/" ~/.openclaw/memory/
  echo "Workspace: ~/.openclaw/workspace/"
  echo "Migration sources: ~/.openclaw/MEMORY.md + ~/.openclaw/memory/"
fi

# Step 6: Load environment
echo ""
echo "=== Loading environment ==="
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  . "$SCRIPT_DIR/.env"
  set +a
  echo "Loaded .env"
fi

echo ""
echo "=========================================="
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "    1. Run: npx @keyoku/openclaw init"
echo "    2. Answer 'y' to migrate existing memories"
echo "    3. Start OpenClaw: openclaw gateway --allow-unconfigured --port 18789"
echo ""
echo "  For automated testing:"
echo "    ./test-init.sh"
echo "=========================================="
