```
                               __               __                __
   ________  ____ ___  ____  / /____     _____/ /___ ___  ______/ /__
  / ___/ _ \/ __ `__ \/ __ \/ __/ _ \   / ___/ / __ `/ / / / __  / _ \
 / /  /  __/ / / / / / /_/ / /_/  __/  / /__/ / /_/ / /_/ / /_/ /  __/
/_/   \___/_/ /_/ /_/\____/\__/\___/   \___/_/\__,_/\__,_/\__,_/\___/

        ┌─────────────────────────────────────────────────────┐
        │  DISTRIBUTED SESSION MONITORING FOR CLAUDE CODE     │
        └─────────────────────────────────────────────────────┘
```

# remote-claude

**Aggregate and monitor multiple Claude Code sessions from a single dashboard.**

Run Claude Code in multiple terminals, see all sessions in one place, send input remotely, and never lose track of what your AI is doing.

## Features

- **Multi-session monitoring** - See all Claude Code sessions across terminals
- **Real-time event streaming** - Watch tool calls, prompts, and responses live
- **Remote input** - Markdown-capable input with file upload (paste/drag-drop images)
- **Web terminal** - Full xterm.js terminal with popout windows (shift+click TTY badge)
- **Syntax-highlighted diffs** - Shiki-powered diff rendering in transcript view
- **Sub-agent tracking** - Visualize spawned agents, their types, and lifecycle
- **Background task tracking** - See running Bash commands and task lists per session
- **Team detection** - See which sessions are part of coordinated teams
- **Project settings** - Custom label, icon, and color per project path
- **Push notifications** - PWA push notifications when sessions need attention
- **Session revival** - Revive idle sessions via host agent + tmux
- **Passkey authentication** - WebAuthn passkeys, CLI-only invite creation, no passwords
- **Path-jailed file access** - Transcript/image serving locked to allowed directories
- **Session persistence** - Sessions survive concentrator restarts
- **Session resume** - Resumed Claude sessions show as the same session
- **Transcript viewer** - Markdown-rendered conversation history with syntax highlighting
- **Deep link routing** - Direct URL links to sessions and views
- **Docker-ready** - Dockerfile + compose with health checks and Caddy integration
- **Frontend hot-reload** - Docker volume mount lets you rebuild web without restarting container
- **Mobile-friendly UI** - Responsive design with Tokyo Night color scheme
- **Readline shortcuts** - Ctrl+A/E/K/U/W in the input field

## Architecture

```
┌─────────────────────────┐              ┌──────────────────────────┐
│   Terminal 1            │              │      CONCENTRATOR        │
│   ┌─────────────────┐   │   WebSocket  │  ┌──────────────────┐    │
│   │    rclaude      │───┼──────────────┼─►│  Session Store   │    │
│   │    (wrapper)    │   │              │  │  Event Registry  │    │
│   └────────┬────────┘   │              │  │  Auth (Passkey)  │    │
│            │ PTY        │              │  │  REST API        │    │
│   ┌────────▼────────┐   │              │  │  WebSocket Hub   │    │
│   │  claude (CLI)   │   │              │  └──────────────────┘    │
│   └─────────────────┘   │              │           │              │
└─────────────────────────┘              │           │ HTTP/WS      │
                                         │           ▼              │
┌─────────────────────────┐              │  ┌──────────────────┐    │
│   Terminal 2            │              │  │   Web Dashboard  │    │
│   ┌─────────────────┐   │   WebSocket  │  │   (React + Vite) │    │
│   │    rclaude      │───┼──────────────┼─►└──────────────────┘    │
│   └─────────────────┘   │              └──────────────────────────┘
└─────────────────────────┘
                                                   ▲
┌─────────────────────────┐                        │
│   Terminal N...         │────────────────────────┘
└─────────────────────────┘
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.2+)
- [Claude Code](https://claude.ai/code) CLI installed

### Install

```bash
git clone https://github.com/claudification/remote-claude.git
cd remote-claude
bun install && cd web && bun install && cd ..
bun run install-cli
```

Installs `rclaude`, `rclaude-agent`, `concentrator`, and `concentrator-cli` to `~/.local/bin`.

```bash
# Ensure ~/.local/bin is in PATH
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Run locally

```bash
# Start concentrator with dashboard
concentrator -v --web-dir ./web/dist

# In another terminal - use rclaude instead of claude
rclaude
```

Dashboard at http://localhost:9999

### Point to a remote concentrator

```bash
rclaude --concentrator ws://your-server:9999
```

All hook events stream to the remote server. Transcript viewing requires the `.claude` directory to be accessible from the concentrator (see Docker section).

## Authentication

The dashboard is protected by **WebAuthn passkeys**. No passwords. No self-registration.\
Passkeys can ONLY be created through CLI-generated invite links.

### First-time setup

```bash
# Create an invite for yourself
concentrator-cli create-invite --name yourname

# Or with a remote concentrator's cache dir
concentrator-cli create-invite --name yourname --cache-dir /path/to/cache
```

This prints a one-time invite link. Open it in your browser to register your passkey.\
Invites expire after 30 minutes.

### Managing users

```bash
# List all registered users
concentrator-cli list-users

# Revoke access (kills all active sessions immediately)
concentrator-cli revoke --name badactor

# Restore access
concentrator-cli unrevoke --name rehabilitated
```

**Rules:**
- Names must be **unique** -- no duplicates allowed
- Revoking a user terminates all their active sessions instantly
- Session cookies last 7 days, then re-authentication is required
- Auth state is stored in `~/.cache/concentrator/auth.json` (mode 0600)

### For Docker deployments

Run the CLI inside the container to share the auth state:

```bash
docker exec concentrator concentrator-cli create-invite --name yourname --url https://your-domain.example
```

## Docker Deployment

### Build and run

```bash
# Copy and configure .env
cp .env.example .env
# Edit .env with your domain, origins, etc.

docker compose up -d
```

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_DIR` | Host path to `.claude` directory (mounted read-only) | `~/.claude` |
| `RCLAUDE_SECRET` | Shared secret for rclaude WebSocket auth | *(required)* |
| `RP_ID` | WebAuthn relying party ID (your domain, no protocol) | `localhost` |
| `ORIGIN` | Allowed WebAuthn origin (full URL) | `http://localhost:9999` |
| `CADDY_HOST` | Caddy reverse proxy hostname (for caddy-docker-proxy) | *(empty)* |
| `VAPID_PUBLIC_KEY` | VAPID public key for push notifications | *(optional)* |
| `VAPID_PRIVATE_KEY` | VAPID private key for push notifications | *(optional)* |
| `PORT` | External port mapping | `9999` |

### With Caddy reverse proxy

The compose file includes labels for [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy). Set `CADDY_HOST` to your domain and ensure the concentrator is on the `caddy` network:

```env
RP_ID=concentrator.example.com
ORIGIN=https://concentrator.example.com
CADDY_HOST=concentrator.example.com
```

### Frontend hot-reload

The Docker compose mounts `./web/dist` over the baked-in frontend assets. Rebuild the frontend on the host and changes appear immediately -- no container restart needed:

```bash
bun run build:web    # Rebuilds web/dist/, served instantly by the container
```

### Health check

```bash
curl http://localhost:9999/health
# Returns "ok" with 200
```

The Docker container has a built-in health check that polls `/health` every 30 seconds.

## Security

### Path jail

All filesystem access (transcripts, images, web assets) is locked down by a path jail:

- Uses `realpath()` to resolve ALL symlinks before checking
- Blocks null bytes, relative paths, and traversal attempts
- Only files within explicitly allowed root directories are served
- Default allowed roots: `~/.claude` (transcripts) + web dir + cache dir
- Add extra roots: `--allow-root /path/to/dir` (repeatable)

### WebAuthn

- No passwords, no tokens in URLs, no bearer auth to leak
- Passkey registration requires a CLI-generated invite (not accessible from the web)
- Session cookies are HMAC-SHA256 signed with a server-side secret
- The HMAC secret is auto-generated on first run and stored in `auth.secret` (mode 0600)
- Revoked users are blocked from all access immediately

## CLI Reference

### concentrator

```
concentrator [OPTIONS]

OPTIONS:
  -p, --port <port>        WebSocket/API port (default: 9999)
  -v, --verbose            Enable verbose logging
  -w, --web-dir <dir>      Serve web dashboard from directory
  --cache-dir <dir>        Session cache directory (default: ~/.cache/concentrator)
  --clear-cache            Clear session cache and exit
  --no-persistence         Disable session persistence
  --allow-root <dir>       Add allowed filesystem root (repeatable)
  --rp-id <domain>         WebAuthn relying party ID (default: localhost)
  --origin <url>           Allowed WebAuthn origin (repeatable)
  --rclaude-secret <s>     Shared secret for rclaude WebSocket auth
  --path-map <host:cont>   Map host paths to container paths (for Docker)
  -h, --help               Show help
```

### rclaude

```
rclaude [OPTIONS] [CLAUDE_ARGS...]

OPTIONS:
  --concentrator <url>   Concentrator WebSocket URL (default: ws://localhost:9999)
  --rclaude-secret <s>   Shared secret for concentrator auth (or RCLAUDE_SECRET env)
  --no-concentrator      Run without forwarding to concentrator
  --no-terminal          Disable remote terminal capability
  --rclaude-help         Show rclaude help

All other arguments pass through to claude CLI.
```

### concentrator-cli

```
concentrator-cli <command> [OPTIONS]

COMMANDS:
  create-invite --name <name>    Create a one-time passkey invite link
  list-users                      List all registered passkey users
  revoke --name <name>           Revoke a user's access
  unrevoke --name <name>         Restore a revoked user

OPTIONS:
  --cache-dir <dir>    Auth storage directory (default: ~/.cache/concentrator)
  --url <url>          Base URL for invite links (default: http://localhost:9999)
```

## REST API

All API endpoints require authentication when passkey users exist.

```bash
# Health check (always public)
curl http://localhost:9999/health

# List all sessions
curl http://localhost:9999/sessions

# List active sessions only
curl http://localhost:9999/sessions?active=true

# Get session details
curl http://localhost:9999/sessions/:id

# Get session events
curl http://localhost:9999/sessions/:id/events

# Get session sub-agents
curl http://localhost:9999/sessions/:id/subagents

# Get session transcript (last 20 entries)
curl http://localhost:9999/sessions/:id/transcript

# Get background tasks (running Bash commands)
curl http://localhost:9999/sessions/:id/tasks

# Send input to session
curl -X POST http://localhost:9999/sessions/:id/input \
  -H "Content-Type: application/json" \
  -d '{"input": "hello world"}'

# Upload a file (returns URL for use in input)
curl -X POST http://localhost:9999/api/files \
  -F "file=@screenshot.png"

# Project settings (label/icon/color per project path)
curl http://localhost:9999/api/project-settings
curl -X PUT http://localhost:9999/api/project-settings \
  -H "Content-Type: application/json" \
  -d '{"cwd": "/home/user/project", "label": "My API", "icon": "rocket", "color": "#ff6600"}'
```

## Hook Events

| Event | Description |
|-------|-------------|
| `SessionStart` | New session with model, cwd, transcript path |
| `SessionEnd` | Session terminated |
| `UserPromptSubmit` | User entered a prompt |
| `PreToolUse` | About to execute a tool |
| `PostToolUse` | Tool execution completed |
| `Stop` | Claude stopped (waiting for input) |
| `Notification` | System notification |
| `SubagentStart` | Spawned a sub-agent |
| `SubagentStop` | Sub-agent completed |
| `TeammateIdle` | Team member waiting for work |
| `TaskCompleted` | Task finished in team context |
| `Setup` | Session initialization |
| `PreCompact` | Before context compaction |
| `PermissionRequest` | Tool permission requested |

## Project Structure

```
remote-claude/
├── bin/                       # Built binaries
│   ├── rclaude               # Wrapper CLI
│   ├── rclaude-agent         # Host agent for session revival
│   ├── concentrator          # Aggregation server
│   └── concentrator-cli      # Passkey management CLI
├── src/
│   ├── wrapper/              # rclaude implementation
│   │   ├── index.ts          # CLI entry point
│   │   ├── pty-spawn.ts      # PTY subprocess management
│   │   ├── ws-client.ts      # WebSocket client with reconnection
│   │   ├── local-server.ts   # Hook callback receiver
│   │   └── settings-merge.ts # Claude settings injection
│   ├── concentrator/         # Server implementation
│   │   ├── index.ts          # Server entry point
│   │   ├── session-store.ts  # Session registry + persistence
│   │   ├── api.ts            # REST API + file upload
│   │   ├── auth.ts           # WebAuthn passkey auth core
│   │   ├── auth-routes.ts    # Auth HTTP endpoints
│   │   ├── path-jail.ts      # Filesystem access control
│   │   ├── push.ts           # Web Push notifications (VAPID)
│   │   ├── project-settings.ts # Per-project label/icon/color
│   │   └── cli.ts            # CLI tool entry point
│   ├── agent/                # Host agent for session revival
│   └── shared/
│       └── protocol.ts       # WebSocket protocol types
├── web/                      # React dashboard
│   └── src/
│       ├── components/       # UI components
│       │   ├── auth-gate.tsx  # Login/registration gate
│       │   ├── web-terminal.tsx # xterm.js remote terminal
│       │   ├── transcript-view.tsx # Shiki-highlighted transcript
│       │   ├── markdown-input.tsx  # Markdown editor with file upload
│       │   ├── project-settings-editor.tsx # Project customization
│       │   ├── tasks-view.tsx # Task list view
│       │   ├── bg-tasks-view.tsx # Background tasks view
│       │   └── ...
│       ├── hooks/            # React hooks + API
│       └── styles/           # Tokyo Night theme
├── scripts/
│   ├── build.sh              # Build script (--deploy for Docker)
│   └── rclaude-notify.sh     # Push notification helper
├── Dockerfile                # Multi-stage build
├── docker-compose.yml        # Production deployment
└── .env.example              # Configuration template
```

## Shell Integration

### Wrapper function (`cc` / `ccc`)

Instead of calling `rclaude` directly, wrap it in a shell function that handles permissions, tmux integration, and fallback to plain `claude` when rclaude isn't installed.

Add to your `~/.zshrc` or `~/.bashrc`:

```bash
# Claude Code with rclaude integration
# Usage: cc [--safe] [--tmux] [--no-tmux] [--no-rclaude] [claude args...]
cc() {
  local safe_mode=false
  local tmux_mode=false
  local no_rclaude=false
  local named_session=""
  local args=()

  # Check for project-specific tmux session name
  # Set via: cc-set-tmux-name my-project
  if [[ -f ".claude/settings.local.json" ]]; then
    named_session=$(jq -r '.["tmux-session-name"] // empty' .claude/settings.local.json 2>/dev/null)
    if [[ -n "$named_session" ]]; then
      tmux_mode=true
    fi
  fi

  # Parse our flags, pass everything else to claude
  for arg in "$@"; do
    case "$arg" in
      --safe)       safe_mode=true ;;
      --tmux)       tmux_mode=true ;;
      --no-tmux)    tmux_mode=false; named_session="" ;;
      --no-rclaude) no_rclaude=true ;;
      *)            args+=("$arg") ;;
    esac
  done

  # rclaude by default, fall back to claude
  local base_cmd="rclaude"
  if [[ "$no_rclaude" == true ]] || ! command -v rclaude &>/dev/null; then
    base_cmd="claude"
  fi

  # Skip permissions by default (--safe to disable)
  local cmd="$base_cmd"
  if [[ "$safe_mode" == false ]]; then
    cmd="$cmd --dangerously-skip-permissions"
  fi

  # Append remaining args
  if [[ ${#args[@]} -gt 0 ]]; then
    cmd="$cmd ${args[@]}"
  fi

  # Non-tmux: just run it
  if [[ "$tmux_mode" == false ]]; then
    eval "$cmd"
    return
  fi

  # --- tmux mode ---

  # Skip tmux wrapping inside IDE terminals
  if [[ "$TERM_PROGRAM" == "vscode" ]] || [[ "$TERMINAL_EMULATOR" == "JetBrains-JediTerm" ]]; then
    echo "Warning: tmux mode ignored in IDE terminal"
    eval "$cmd"
    return
  fi

  # Already inside tmux
  if [[ -n "$TMUX" ]]; then
    if [[ -n "$named_session" ]]; then
      local current_session=$(tmux display-message -p '#S')
      if [[ "$current_session" != "$named_session" ]]; then
        if ! tmux has-session -t "$named_session" 2>/dev/null; then
          tmux new-session -d -s "$named_session" -c "$PWD" -n "$named_session" "$cmd"
        fi
        tmux switch-client -t "$named_session"
        return
      fi
    fi
    eval "$cmd"
    return
  fi

  # Outside tmux - create session
  if [[ -n "$named_session" ]]; then
    if ! tmux has-session -t "$named_session" 2>/dev/null; then
      tmux new-session -d -s "$named_session" -c "$PWD" -n "$named_session" "$cmd"
    fi
    tmux attach -t "$named_session"
  else
    local session_name="claude-$$"
    tmux new-session -d -s "$session_name" -c "$PWD" "$cmd"
    tmux attach -t "$session_name"
  fi
}

# Quick alias: cc in continue mode
ccc() { cc -c "$@"; }
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--safe` | Don't skip permissions (interactive approval mode) |
| `--tmux` | Force tmux wrapping even without project config |
| `--no-tmux` | Disable tmux wrapping even if project config exists |
| `--no-rclaude` | Use plain `claude` instead of `rclaude` |

**Examples:**

```bash
cc                          # rclaude with skip-permissions
cc --safe                   # rclaude with permission prompts
cc --tmux                   # launch in dedicated tmux session
cc -p "fix the build"       # non-interactive prompt
cc --no-rclaude             # plain claude, no concentrator
ccc                         # continue previous session (cc -c)
```

### Per-project tmux sessions

You can assign a named tmux session to any project. When you run `cc` in that directory, it auto-creates (or reattaches to) a dedicated tmux session.

```bash
# Helper to set session name for current project
cc-set-tmux-name() {
  local name="$1"
  if [[ -z "$name" ]]; then
    echo "Usage: cc-set-tmux-name <session-name>"
    return 1
  fi
  mkdir -p .claude
  local f=".claude/settings.local.json"
  [[ -f "$f" ]] || echo '{}' > "$f"
  local tmp=$(mktemp)
  jq --arg name "$name" '.["tmux-session-name"] = $name' "$f" > "$tmp" && mv "$tmp" "$f"
  echo "Set tmux-session-name to: $name"
}
```

```bash
cd ~/projects/my-api
cc-set-tmux-name my-api     # writes to .claude/settings.local.json
cc                           # auto-creates tmux session "my-api"
```

Now every `cc` in that project directory opens the same tmux session. Switching between projects = switching tmux sessions.

## tmux Configuration

rclaude sets the tmux window title to the last 2 path segments of the working directory (max 20 chars), so you can distinguish multiple sessions at a glance.

**Required tmux settings** -- add to `~/.tmux.conf`:

```tmux
# Let applications set window titles (required for rclaude)
setw -g allow-rename on

# Auto-rename shows the running program name when no app title is set
setw -g automatic-rename on
```

**Recommended tmux config** for a good Claude Code experience:

```tmux
# -- general --
set -g default-terminal "screen-256color"
set -s escape-time 10                     # faster key sequences
set -sg repeat-time 600                   # increase repeat timeout
set -s focus-events on
set -g history-limit 5000                 # generous scrollback

# -- display --
set -g base-index 1                       # start windows at 1
setw -g pane-base-index 1                 # panes too

setw -g automatic-rename on              # rename to current program
setw -g allow-rename on                  # let rclaude set window title
set -g renumber-windows on               # no gaps in window numbers

set -g set-titles on                      # set terminal title
set -g status-interval 10                 # refresh status every 10s

# -- navigation --
bind - split-window -v                    # split horizontal
bind _ split-window -h                    # split vertical

# vim-style pane navigation
bind -r h select-pane -L
bind -r j select-pane -D
bind -r k select-pane -U
bind -r l select-pane -R

# pane resizing
bind -r H resize-pane -L 2
bind -r J resize-pane -D 2
bind -r K resize-pane -U 2
bind -r L resize-pane -R 2
```

**What it looks like with multiple sessions:**

```
┌─────────────────────────────────────────────────────────────┐
│ 1:my-api  2:frontend  3:infra  4:zsh                      │
│                                                             │
│  Each rclaude window shows its project directory instead    │
│  of "rclaude" -- making it easy to find the right session   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Development

```bash
# Dev mode (hot reload)
bun run dev:wrapper              # Wrapper
bun run dev:concentrator         # Concentrator
bun run dev:web                  # Web dashboard (Vite dev server)

# Type check
bun run typecheck

# Build everything
bun run build

# Build individual components
bun run build:web                # Web -> web/dist/
bun run build:wrapper            # rclaude -> bin/rclaude
bun run build:concentrator       # concentrator -> bin/concentrator
bun run build:cli                # concentrator-cli -> bin/concentrator-cli
bun run build:agent              # rclaude-agent -> bin/rclaude-agent
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) - JavaScript runtime with native PTY support
- **Backend**: TypeScript, WebSocket, REST API
- **Auth**: WebAuthn / FIDO2 passkeys via [@simplewebauthn](https://simplewebauthn.dev/)
- **Frontend**: React 19, Vite 7, Tailwind CSS v4, shadcn/ui
- **Terminal**: [xterm.js](https://xtermjs.org/) with fit addon
- **Syntax**: [Shiki](https://shiki.matsu.io/) for diff/code highlighting
- **Push**: Web Push API with VAPID (via [web-push](https://github.com/web-push-libs/web-push))
- **Theme**: Tokyo Night color palette

## License

MIT

---

<p align="center">
  <sub>Maintained by WOPR - the only winning move is to monitor everything</sub>
</p>
