#!/usr/bin/env bash
set -euo pipefail

echo "[*] Building everything..."

echo "[1/5] Web dashboard"
bun run build:web 2>/dev/null || (cd web && bunx vite build)

echo "[2/5] rclaude wrapper"
bun build src/wrapper/index.ts --compile --minify --outfile bin/rclaude

echo "[3/5] concentrator"
bun run scripts/build-concentrator.ts

echo "[4/5] concentrator-cli"
bun build src/concentrator/cli.ts --compile --minify --outfile bin/concentrator-cli

echo "[5/5] rclaude-agent"
bun build src/agent/index.ts --compile --minify --outfile bin/rclaude-agent

echo ""
echo "[+] All binaries in bin/"
ls -lh bin/

if [ "${1:-}" = "--deploy" ]; then
  echo ""
  echo "[*] Deploying concentrator..."
  docker compose build --no-cache
  docker compose up -d
  echo "[+] Deployed"
fi
