#!/bin/bash
set -e

TARGET_USER="claude"
TARGET_UID="${USER_UID:-1000}"
TARGET_GID="${USER_GID:-1000}"

# --- UID/GID remapping (nezhar pattern) ---
CURRENT_UID=$(id -u "$TARGET_USER")
CURRENT_GID=$(id -g "$TARGET_USER")

if [ "$CURRENT_GID" != "$TARGET_GID" ]; then
  groupmod -o -g "$TARGET_GID" claude 2>/dev/null || true
fi
if [ "$CURRENT_UID" != "$TARGET_UID" ]; then
  usermod -o -u "$TARGET_UID" "$TARGET_USER" 2>/dev/null || true
fi

# Fix ownership of claude's home (not recursive -- too slow on big mounts)
chown "$TARGET_UID:$TARGET_GID" /home/claude /home/claude/.claude

# --- SSH agent forwarding (run-claude pattern) ---
if [ -S "/ssh-agent" ]; then
  export SSH_AUTH_SOCK="/ssh-agent"
fi

# --- Sudo policy (disabled by default, opt-in via ENABLE_SUDO=1) ---
if [ "${ENABLE_SUDO}" != "1" ]; then
  rm -f /etc/sudoers.d/claude
fi

# --- Default broker URL for Docker networking ---
export CLAUDWERK_BROKER="${CLAUDWERK_BROKER:-ws://broker:9999}"

# --- Drop to target user and exec ---
exec gosu "$TARGET_USER" "$@"
