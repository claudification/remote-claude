#!/usr/bin/env bash
#
# rclaude installer
# Sets up the rclaude wrapper, shell config, and optionally the concentrator
#
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "${CYAN}[*]${NC} $1"; }
ok()    { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
err()   { echo -e "${RED}[-]${NC} $1"; }
ask()   { echo -en "${BOLD}$1${NC} "; }

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${REPO_DIR}/bin"
INSTALL_DIR="${HOME}/.local/bin"

echo ""
echo -e "${BOLD}  ┌─────────────────────────────────┐${NC}"
echo -e "${BOLD}  │${CYAN}  rclaude installer${NC}${BOLD}               │${NC}"
echo -e "${BOLD}  │${DIM}  session monitoring for claude${NC}${BOLD}   │${NC}"
echo -e "${BOLD}  └─────────────────────────────────┘${NC}"
echo ""

# ─── Prerequisites ───────────────────────────────────────────────
if ! command -v tmux &>/dev/null; then
  warn "tmux is not installed. The agent uses tmux to spawn and revive sessions from the dashboard."
  case "$(uname -s)" in
    Darwin) echo -e "  Install with: ${CYAN}brew install tmux${NC}" ;;
    Linux)  echo -e "  Install with: ${CYAN}sudo apt install tmux${NC} or ${CYAN}sudo dnf install tmux${NC}" ;;
  esac
else
  ok "Found tmux $(tmux -V)"
fi

if ! command -v bun &>/dev/null; then
  warn "bun is not installed. Installing..."
  curl -fsSL https://bun.sh/install | bash
  # Source bun into current shell
  if [ -f "$HOME/.bun/bin/bun" ]; then
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi
  if ! command -v bun &>/dev/null; then
    err "Failed to install bun. Install manually: curl -fsSL https://bun.sh/install | bash"
    exit 1
  fi
  ok "Installed bun $(bun --version)"
fi

# ─── Detect shell ────────────────────────────────────────────────
SHELL_NAME="$(basename "$SHELL")"
case "$SHELL_NAME" in
  zsh)  SHELL_RC="$HOME/.zshrc" ;;
  bash) SHELL_RC="$HOME/.bashrc" ;;
  *)
    warn "Unknown shell: $SHELL_NAME"
    ask "Path to your shell rc file:"
    read -r SHELL_RC
    ;;
esac
info "Detected shell: ${BOLD}$SHELL_NAME${NC} ($SHELL_RC)"

# ─── Install dependencies ───────────────────────────────────────
info "Installing root dependencies..."
cd "$REPO_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install

info "Installing web dependencies..."
cd "$REPO_DIR/web"
bun install --frozen-lockfile 2>/dev/null || bun install
cd "$REPO_DIR"

# ─── Build binaries ──────────────────────────────────────────────
info "Building binaries..."
mkdir -p "$BIN_DIR"
bun run build:wrapper
bun run build:agent
ok "Built rclaude and rclaude-agent"

# ─── Create symlinks ────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
for bin in rclaude rclaude-agent; do
  target="${BIN_DIR}/${bin}"
  link="${INSTALL_DIR}/${bin}"
  if [ -L "$link" ]; then
    rm "$link"
  elif [ -e "$link" ]; then
    warn "$link exists and is not a symlink - skipping (move it out of the way)"
    continue
  fi
  ln -sf "$target" "$link"
  ok "Linked $link -> $target"
done

# ─── Ensure ~/.local/bin is in PATH ─────────────────────────────
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  warn "$INSTALL_DIR is not in your PATH"
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_RC"
  ok "Added $INSTALL_DIR to PATH in $SHELL_RC"
fi

# ─── Concentrator setup ─────────────────────────────────────────
echo ""
echo -e "${BOLD}Concentrator setup${NC}"
echo -e "${DIM}The concentrator aggregates sessions and serves the dashboard.${NC}"
echo ""
echo "  1) Local Docker    - run concentrator on this machine"
echo "  2) Remote           - connect to an existing concentrator"
echo "  3) Skip             - configure later"
echo ""
ask "Choose [1/2/3]:"
read -r CONC_CHOICE

CONCENTRATOR_URL=""
case "$CONC_CHOICE" in
  1)
    # ─── Local concentrator ──────────────────────────────────────
    ask "Hostname for the concentrator (e.g. concentrator.example.com, or localhost):"
    read -r CONC_HOST
    CONC_HOST="${CONC_HOST:-localhost}"

    if [ "$CONC_HOST" = "localhost" ]; then
      CONCENTRATOR_URL="ws://localhost:9999"
    else
      CONCENTRATOR_URL="wss://${CONC_HOST}"
    fi

    # Generate or reuse secret
    ENV_FILE="${REPO_DIR}/.env"
    if [ -f "$ENV_FILE" ] && grep -q "^RCLAUDE_SECRET=" "$ENV_FILE"; then
      warn ".env already exists with RCLAUDE_SECRET"
      ask "Overwrite with new secret? [y/N]:"
      read -r OVERWRITE
      if [ "$OVERWRITE" = "y" ] || [ "$OVERWRITE" = "Y" ]; then
        RCLAUDE_SECRET="$(openssl rand -hex 32)"
        ok "Generated new RCLAUDE_SECRET"
      else
        RCLAUDE_SECRET="$(grep '^RCLAUDE_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
        ok "Keeping existing RCLAUDE_SECRET from .env"
      fi
    else
      RCLAUDE_SECRET="$(openssl rand -hex 32)"
      ok "Generated RCLAUDE_SECRET"
    fi

    # Write .env for docker-compose
    {
      echo "RCLAUDE_SECRET=${RCLAUDE_SECRET}"
      echo "PORT=9999"
      if [ "$CONC_HOST" != "localhost" ]; then
        echo "CADDY_HOST=${CONC_HOST}"
        echo "RP_ID=${CONC_HOST}"
        echo "ORIGIN=https://${CONC_HOST}"
      fi
    } > "$ENV_FILE"
    ok "Wrote $ENV_FILE"

    # Build concentrator + web
    info "Building concentrator and web dashboard..."
    bun run build:concentrator
    bun run build:web
    bun run build:cli
    ok "Built concentrator, web dashboard, and CLI"

    # Symlink concentrator binaries
    for bin in concentrator concentrator-cli; do
      target="${BIN_DIR}/${bin}"
      link="${INSTALL_DIR}/${bin}"
      if [ -L "$link" ]; then rm "$link"; fi
      if [ -e "$target" ]; then
        ln -sf "$target" "$link"
        ok "Linked $link"
      fi
    done

    echo ""
    info "Start the concentrator with:"
    echo -e "  ${CYAN}cd ${REPO_DIR} && docker compose up -d${NC}"
    if [ "$CONC_HOST" != "localhost" ]; then
      echo ""
      info "Make sure your reverse proxy (Caddy/nginx) forwards to port 9999"
      info "See README.md for Caddy configuration examples"
    fi
    ;;
  2)
    # ─── Remote concentrator ─────────────────────────────────────
    ask "Concentrator WebSocket URL (e.g. wss://concentrator.example.com):"
    read -r CONCENTRATOR_URL

    ask "RCLAUDE_SECRET (shared secret from the concentrator):"
    read -r RCLAUDE_SECRET
    ;;
  3|*)
    info "Skipping concentrator setup."
    ;;
esac

# ─── Shell configuration ────────────────────────────────────────
echo ""
MARKER="# rclaude config"

# Extract existing values from shell rc before removing the old block
EXISTING_SECRET=""
EXISTING_CONCENTRATOR=""
if grep -qF "$MARKER" "$SHELL_RC" 2>/dev/null; then
  EXISTING_SECRET="$(sed -n '/# rclaude config/,/# end rclaude config/{s/^export RCLAUDE_SECRET="\(.*\)"/\1/p;}' "$SHELL_RC")"
  EXISTING_CONCENTRATOR="$(sed -n '/# rclaude config/,/# end rclaude config/{s/^export RCLAUDE_CONCENTRATOR="\(.*\)"/\1/p;}' "$SHELL_RC")"
  warn "rclaude config already exists in $SHELL_RC - updating"
  # Remove old block (resolve symlinks for sed -i compatibility)
  REAL_SHELL_RC="$(readlink -f "$SHELL_RC" 2>/dev/null || realpath "$SHELL_RC" 2>/dev/null || echo "$SHELL_RC")"
  sed -i.bak "/$MARKER/,/# end rclaude config/d" "$REAL_SHELL_RC"
  rm -f "${REAL_SHELL_RC}.bak"
fi

# For option 3 (skip), fall back to values parsed from the existing rc block
RCLAUDE_SECRET="${RCLAUDE_SECRET:-$EXISTING_SECRET}"
CONCENTRATOR_URL="${CONCENTRATOR_URL:-$EXISTING_CONCENTRATOR}"

SHELL_BLOCK="${MARKER}
export RCLAUDE_SECRET=\"${RCLAUDE_SECRET:-}\"
export RCLAUDE_CONCENTRATOR=\"${CONCENTRATOR_URL:-}\""

# Add alias option
echo ""
echo -e "${BOLD}Shell alias${NC}"
echo "  1) alias claude=rclaude  - transparent replacement"
echo "  2) Keep separate         - use 'rclaude' explicitly"
echo ""
ask "Choose [1/2]:"
read -r ALIAS_CHOICE

case "$ALIAS_CHOICE" in
  1)
    SHELL_BLOCK="${SHELL_BLOCK}
alias claude=rclaude
alias ccc='claude --resume'"
    ok "Will alias claude=rclaude"
    ;;
  *)
    SHELL_BLOCK="${SHELL_BLOCK}
alias ccc='rclaude --resume'"
    ok "rclaude available as separate command"
    ;;
esac

SHELL_BLOCK="${SHELL_BLOCK}
# end rclaude config"

echo "$SHELL_BLOCK" >> "$SHELL_RC"
ok "Updated $SHELL_RC"

# ─── Summary ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  ┌─────────────────────────────────┐${NC}"
echo -e "${BOLD}  │${GREEN}  Installation complete!${NC}${BOLD}          │${NC}"
echo -e "${BOLD}  └─────────────────────────────────┘${NC}"
echo ""
echo -e "  Restart your shell or run: ${CYAN}source $SHELL_RC${NC}"
echo ""
if [ -n "$CONCENTRATOR_URL" ]; then
  echo -e "  Concentrator: ${CYAN}${CONCENTRATOR_URL}${NC}"
fi
echo -e "  Binaries:     ${CYAN}${INSTALL_DIR}/rclaude${NC}"
echo -e "  Config:       ${CYAN}${SHELL_RC}${NC}"
echo ""
