#!/usr/bin/env bash
# ResonantOS Alpha Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/ManoloRemiddi/resonantos-alpha/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/ManoloRemiddi/resonantos-alpha.git"
INSTALL_DIR="$HOME/resonantos-alpha"
OPENCLAW_AGENT_DIR="$HOME/.openclaw/agents/main/agent"
OPENCLAW_WORKSPACE="$HOME/.openclaw/workspace"

echo "=== ResonantOS Alpha Installer ==="
echo ""

# 1. Check dependencies
check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: $1 is required but not installed."
    echo "  Install: $2"
    exit 1
  fi
}

check_cmd git "https://git-scm.com/"
check_cmd node "https://nodejs.org/ (v18+)"
check_cmd python3 "https://www.python.org/"
check_cmd pip3 "Should come with python3"

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found v$NODE_VER)"
  exit 1
fi

# 2. Check OpenClaw installed
if ! command -v openclaw &>/dev/null; then
  echo "OpenClaw not found. Installing..."
  npm install -g openclaw
fi

echo "✓ Dependencies OK"

# 3. Clone repo
if [ -d "$INSTALL_DIR" ]; then
  echo "Directory $INSTALL_DIR exists. Pulling latest..."
  cd "$INSTALL_DIR" && git pull
else
  echo "Cloning ResonantOS Alpha..."
  git clone "$REPO" "$INSTALL_DIR"
fi

# 4. Copy extensions
echo "Installing extensions..."
mkdir -p "$OPENCLAW_AGENT_DIR/extensions"
cp "$INSTALL_DIR/extensions/r-memory.js" "$OPENCLAW_AGENT_DIR/extensions/"
cp "$INSTALL_DIR/extensions/r-awareness.js" "$OPENCLAW_AGENT_DIR/extensions/"
echo "✓ Extensions installed"

# 5. Set up SSoT template
echo "Setting up SSoT documents..."
SSOT_DIR="$OPENCLAW_WORKSPACE/resonantos-augmentor/ssot"
mkdir -p "$SSOT_DIR"
if [ -z "$(ls -A "$SSOT_DIR" 2>/dev/null)" ]; then
  cp -r "$INSTALL_DIR/ssot-template/"* "$SSOT_DIR/"
  echo "✓ SSoT template installed"
else
  echo "  SSoT directory not empty — skipping (won't overwrite your docs)"
fi

# 6. Set up R-Memory & R-Awareness config dirs
mkdir -p "$OPENCLAW_WORKSPACE/r-memory"
mkdir -p "$OPENCLAW_WORKSPACE/r-awareness"

if [ ! -f "$OPENCLAW_WORKSPACE/r-awareness/keywords.json" ]; then
  cat > "$OPENCLAW_WORKSPACE/r-awareness/keywords.json" <<'EOF'
{
  "system": ["L1/SSOT-L1-IDENTITY-STUB.ai.md"],
  "openclaw": ["L1/SSOT-L1-IDENTITY-STUB.ai.md"],
  "philosophy": ["L0/PHILOSOPHY.md"],
  "cosmodestiny": ["L0/PHILOSOPHY.md"],
  "augmentatism": ["L0/PHILOSOPHY.md"],
  "constitution": ["L0/CONSTITUTION.md"],
  "architecture": ["L1/SYSTEM-ARCHITECTURE.md"],
  "memory": ["L1/R-MEMORY.md"],
  "awareness": ["L1/R-AWARENESS.md"]
}
EOF
  echo "✓ Default keywords installed"
fi

if [ ! -f "$OPENCLAW_WORKSPACE/r-awareness/config.json" ]; then
  cat > "$OPENCLAW_WORKSPACE/r-awareness/config.json" <<'EOF'
{
  "ssotRoot": "resonantos-augmentor/ssot",
  "coldStartOnly": true,
  "coldStartDocs": ["L1/SSOT-L1-IDENTITY-STUB.ai.md"],
  "tokenBudget": 15000,
  "maxDocs": 10,
  "ttlTurns": 15
}
EOF
  echo "✓ R-Awareness config installed"
fi

if [ ! -f "$OPENCLAW_WORKSPACE/r-memory/config.json" ]; then
  cat > "$OPENCLAW_WORKSPACE/r-memory/config.json" <<'EOF'
{
  "compressTrigger": 36000,
  "evictTrigger": 80000,
  "blockSize": 4000,
  "minCompressChars": 200,
  "compressionModel": "anthropic/claude-haiku-4-5",
  "maxParallelCompressions": 4
}
EOF
  echo "✓ R-Memory config installed"
fi

# 7. Dashboard dependencies
echo "Installing dashboard dependencies..."
cd "$INSTALL_DIR/dashboard"
pip3 install -q flask flask-cors psutil 2>/dev/null || pip3 install flask flask-cors psutil
echo "✓ Dashboard ready"

# 8. Create config from example if needed
if [ ! -f "$INSTALL_DIR/dashboard/config.json" ] && [ -f "$INSTALL_DIR/dashboard/config.example.json" ]; then
  cp "$INSTALL_DIR/dashboard/config.example.json" "$INSTALL_DIR/dashboard/config.json"
  echo "✓ Dashboard config created from template (edit config.json with your addresses)"
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit ~/resonantos-alpha/dashboard/config.json with your Solana addresses"
echo "  2. Start OpenClaw:  openclaw gateway start"
echo "  3. Start Dashboard: cd ~/resonantos-alpha/dashboard && python3 server_v2.py"
echo "  4. Open http://localhost:19100"
echo ""
echo "Docs: https://github.com/ManoloRemiddi/resonantos-alpha"
echo ""
