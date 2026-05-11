#!/usr/bin/env bash
set -euo pipefail

echo "[*] Building everything..."

echo "[1/5] Web dashboard"
bun run build:web 2>/dev/null || (cd web && bunx vite build)

echo "[2/5] rclaude (agent host)"
bun build src/claude-agent-host/index.ts --compile --minify --outfile bin/rclaude

echo "[3/5] broker"
bun run scripts/build-broker.ts

echo "[4/5] broker-cli"
bun build src/broker/cli.ts --compile --minify --outfile bin/broker-cli

echo "[5/5] sentinel"
bun build src/sentinel/index.ts --compile --minify --outfile bin/sentinel

echo ""
echo "[+] All binaries in bin/"
ls -lh bin/

if [ "${1:-}" = "--deploy" ]; then
  echo ""
  echo "[*] Deploying broker..."
  # Build image from git archive HEAD (refuses on dirty tree), then bring it up.
  # docker-compose.yml deliberately does not auto-build -- see comment there.
  scripts/docker-build-broker.sh
  docker compose up -d
  echo "[+] Deployed"
fi
