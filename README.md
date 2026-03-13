```
                               __               __                __
   ________  ____ ___  ____  / /____     _____/ /___ ___  ______/ /__
  / ___/ _ \/ __ `__ \/ __ \/ __/ _ \   / ___/ / __ `/ / / / __  / _ \
 / /  /  __/ / / / / / /_/ / /_/  __/  / /__/ / /_/ / /_/ / /_/ /  __/
/_/   \___/_/ /_/ /_/\____/\__/\___/   \___/_/\__,_/\__,_/\__,_/\___/

        ┌─────────────────────────────────────────────────────┐
        │  SESSION MONITORING + REMOTE CONTROL FOR CLAUDE CODE │
        └─────────────────────────────────────────────────────┘
```

> **We're looking for a new name.** The current working title is `remote-claude` but it deserves
> something with more personality. See [NAMES.md](NAMES.md) for the candidate list -- favorites
> include **CLAUDVOYANT**, **THUNDERCLAUDE**, **CLAUDWERK**, and **PANOPTOCLAUDE**.
> Suggestions welcome.

---

## What is this?

**remote-claude** turns Claude Code from a local-only CLI tool into a remotely accessible,
multi-machine AI workstation you can monitor and control from anywhere.

Run `rclaude` instead of `claude`. It wraps the CLI with a PTY, injects hooks, and streams
everything -- events, transcripts, terminal I/O, tasks, sub-agents -- over a single WebSocket
to a central server. Open the dashboard on your phone, your iPad, a borrowed laptop, whatever.
Your Claude sessions are right there, live, with full interactive terminal access.

**The killer feature: tunnel a real TTY to your running Claude session over the web.** Not a
log viewer. Not a read-only transcript. A full interactive terminal -- xterm.js backed by the
actual PTY process on your host machine. Type commands, approve tool calls, paste code, resize
the window. It's your terminal, streamed through a WebSocket tunnel to any browser on any device.

Sitting on the couch with your iPad? Open the dashboard, tap your session, hit the TTY button.
You're in. Full terminal. Same session your desktop started. On a friend's laptop and need to
check on a long-running Claude task? Log in with your passkey, open the terminal, and you're
there. No SSH keys to configure, no VPN to connect, no port forwarding to set up.

## Why does this exist?

Claude Code is incredible but it's trapped in your terminal. You start a big task, walk away,
and have no idea what happened until you come back to the same machine, the same terminal, the
same tmux session. If you're running Claude on multiple projects across multiple machines,
there's no way to see all of them in one place.

This fixes that. All of it.

## What makes it awesome

### Live Terminal Over the Web

Full xterm.js terminal tunneled through WebSocket to your host's PTY. Not a simulation -- the
real terminal, with all its state, colors, cursor position, and scroll buffer. Works on phones,
tablets, laptops, anything with a browser. Popout to a separate window with Shift+click. Multiple
terminal themes (Dracula, Tokyo Night, Monokai, etc.), adjustable fonts, touch-friendly toolbar
with Ctrl+C, paste, and copy buttons.

### Rich Remote Input

Send prompts to Claude from any device with a full markdown-aware input bar. Syntax-highlighted
as you type, Shift+Enter for multiline. Paste images from clipboard, drag-and-drop files, or
use the attach button to upload -- images are embedded inline and sent to Claude as context.
Voice recording support for hands-free input on mobile.

### Real-Time Session Dashboard

Watch Claude work in real-time from anywhere. Full transcript with syntax-highlighted code blocks
(Shiki), inline images, markdown rendering, and diff visualization. See every tool call as it
happens -- Bash commands, file reads, edits, grep results -- with expandable input/output details.
Auto-follow mode scrolls with new content; scroll up to pause, scroll back down to resume.

### Multi-Machine Aggregation

Run Claude on your desktop, your server, your CI runner -- all sessions stream to one concentrator.
The dashboard shows them all, grouped by project, with custom labels, icons, and colors. Switch
between sessions instantly with Ctrl+K (QuickSilver-style fuzzy finder). Never lose track of
what's running where.

### Sub-Agent & Team Tracking

Claude spawns background agents? You see them. Live status badges show running/completed state,
event counts, and elapsed time directly in the transcript. Click into any agent to see its full
transcript. Team sessions (multi-agent coordination) show teammate status, current tasks, and
completion progress.

### Task & Background Process Monitoring

All tasks (pending, in-progress, completed) visible in a dedicated tab with blocking relationships
and owner assignments. Background Bash processes tracked with their commands, descriptions, and
run times. Archived tasks grouped by date for history.

### File Editor & Browser

Browse and edit markdown files in your session's working directory directly from the dashboard.
CodeMirror-powered editor with syntax highlighting, version history, conflict detection (file
changed on disk while you were editing), and one-click restore. Hit Ctrl+K and type `F:` to
open the QuickSilver-style file browser -- fuzzy-search your project's files and jump straight
into editing. Quick notes (Ctrl+Shift+N) append to a NOTES.md in the project root.

### Passkey-Only Authentication

No passwords. No API tokens. No self-registration. WebAuthn passkeys only.

New users can ONLY be created through CLI-generated invite codes -- there is no web-based
registration. You run `concentrator-cli create-invite --name someone` on the server, it prints
a one-time link, they register their passkey, done. This means an attacker with access to the
web interface alone cannot create accounts. The invite flow requires server-side CLI access.

Session cookies are HMAC-SHA256 signed. The signing secret is auto-generated and stored with
0600 permissions. Revoked users are blocked immediately.

### Push Notifications

PWA push notifications when Claude needs your attention. Works on mobile browsers -- get
notified when sessions are waiting for input even when the tab is closed or your phone is
locked.

**Setup:** Generate VAPID keys and add them to your `.env`:

```bash
# Generate keys
npx web-push generate-vapid-keys

# Add to .env
VAPID_PUBLIC_KEY=BPxr...your-public-key
VAPID_PRIVATE_KEY=abc...your-private-key
```

Restart the concentrator, then open Settings in the dashboard and click **Enable** under
Notifications. Your browser will ask for notification permission -- accept it, and you're
done. Each browser/device subscribes independently.

VAPID keys are NOT derived from `RCLAUDE_SECRET` -- they're a separate keypair used
exclusively for the Web Push protocol. Generate them once, keep them forever.

**Automatic triggers:** The concentrator sends push notifications automatically when:
- A session fires a `Notification` hook (Claude needs input)
- A session fires a `Stop` hook (Claude stopped working)

**Send notifications from scripts/hooks:** Use the REST API to push from anywhere --
CI pipelines, cron jobs, Claude Code hooks, or your own tooling:

```bash
curl -X POST https://concentrator.example.com/api/push/send \
  -H "Authorization: Bearer $RCLAUDE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title": "Build complete", "body": "Deploy finished in 42s"}'
```

**CLAUDE.md tip:** Add this to your project's `CLAUDE.md` so Claude can notify you
when it finishes long-running tasks, deploys, or hits errors:

```markdown
## Push Notifications

Send me a push notification through the concentrator when you complete
significant work, encounter errors, or finish long-running tasks.

### curl
\`\`\`bash
curl -s -X POST $RCLAUDE_CONCENTRATOR_URL/api/push/send \
  -H "Authorization: Bearer $RCLAUDE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title": "Deploy complete", "body": "Production build deployed in 42s"}'
\`\`\`

### Examples of when to notify:
- Build/deploy finished (or failed)
- Long test suite completed
- Task list fully cleared
- Error that needs my attention
- Waiting for my input on something important
```

Replace `$RCLAUDE_CONCENTRATOR_URL` with your actual concentrator URL
(e.g. `https://concentrator.example.com`). The `$RCLAUDE_SECRET` env var
is already available in Claude's shell when running under `rclaude`.

**API reference:**

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Notification title (required if no body) |
| `body` | string | Notification body (required if no title) |
| `sessionId` | string | Optional - links notification to a session |
| `tag` | string | Optional - dedup key (same tag replaces previous) |

Auth: `Bearer` token must match your `RCLAUDE_SECRET`.

### Session Revival

Session went idle? Revive it from the dashboard. The host agent (`rclaude-agent`) listens for
revive commands and spawns a new tmux session with `rclaude --resume`, reconnecting your Claude
session without touching the host machine.

### Project Customization

Label your projects, pick icons (50+ Lucide icons), set colors. The sidebar and session switcher
show your custom branding. Settings persist on the server, shared across all dashboard clients.

---

## Architecture

```mermaid
graph LR
    subgraph host1["Host Machine 1"]
        r1[rclaude] -->|PTY| c1[claude CLI]
    end
    subgraph host2["Host Machine 2"]
        r2[rclaude] -->|PTY| c2[claude CLI]
    end
    subgraph hostN["Host Machine N"]
        rN[rclaude] -->|PTY| cN[claude CLI]
    end

    r1 -->|WebSocket| conc
    r2 -->|WebSocket| conc
    rN -->|WebSocket| conc

    subgraph docker["Docker"]
        conc[Concentrator]
        conc -->|serves| web[Web Dashboard]
    end

    browser[Browser] -->|HTTP/WS| conc
```

**Data flow:** rclaude wraps the `claude` CLI with a PTY, injects hooks, and streams everything
(events, transcripts, tasks, terminal output) to the concentrator over a single WebSocket. The
concentrator stores sessions in memory, persists to disk, and serves the dashboard. No filesystem
sharing between host and Docker.

**Components:**

| Component | What it does |
|-----------|-------------|
| **rclaude** | CLI wrapper. Spawns claude with PTY, injects hooks, streams to concentrator |
| **concentrator** | Central server. HTTP + WS + WebAuthn auth. Runs in Docker |
| **dashboard** | React SPA. Vite + Tailwind + Zustand. Served by concentrator |
| **rclaude-agent** | Host-side agent. Listens for revive commands, spawns tmux sessions |
| **concentrator-cli** | CLI for auth management. Create invites, list/revoke users |

---

## Quick Start

### Prerequisites

- [Claude Code](https://claude.ai/code) CLI installed
- Docker (for concentrator)
- [Bun](https://bun.sh) runtime (v1.2+) — the installer will auto-install it if missing

No other tools (Node.js, npm, vite, etc.) are required. Bun handles everything.

### Install

```bash
git clone https://github.com/claudification/remote-claude.git
cd remote-claude
./install.sh
```

The installer will:
1. Install [Bun](https://bun.sh) automatically if not found
2. Install all dependencies (root + web frontend)
3. Build all binaries (`rclaude`, `rclaude-agent`, `concentrator`, `concentrator-cli`)
4. Symlink them to `~/.local/bin/`
5. Ask about concentrator setup (local Docker, remote, or skip)
6. Configure your shell (`~/.zshrc` or `~/.bashrc`)
7. Optionally alias `claude` to `rclaude`

### Manual install

```bash
# Install bun if you don't have it
curl -fsSL https://bun.sh/install | bash

# Install dependencies (root AND web)
bun install
cd web && bun install && cd ..

# Build everything
bun run build

# Symlink binaries
mkdir -p ~/.local/bin
ln -sf "$(pwd)/bin/rclaude" ~/.local/bin/rclaude
ln -sf "$(pwd)/bin/rclaude-agent" ~/.local/bin/rclaude-agent

# Add to PATH (if not already)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

### Shell configuration

Add to your `~/.zshrc` or `~/.bashrc`:

```bash
# rclaude config
export RCLAUDE_SECRET="your-shared-secret-here"
export RCLAUDE_CONCENTRATOR="wss://concentrator.example.com"
# end rclaude config
```

Or for local development:

```bash
export RCLAUDE_SECRET="dev-secret"
export RCLAUDE_CONCENTRATOR="ws://localhost:9999"
```

Then use `rclaude` instead of `claude`:

```bash
rclaude                          # Start interactive session
rclaude --resume                 # Resume previous session
rclaude -p "fix the build"       # Non-interactive prompt
```

### Optional: alias claude to rclaude

```bash
alias claude=rclaude
alias ccc='rclaude --resume'
```

## Concentrator Deployment

The concentrator is the central server that aggregates sessions and serves the dashboard. It runs in Docker and requires no host filesystem access.

### Standalone (simple setup)

For a single-machine setup or when you're not using caddy-docker-proxy:

```bash
# Generate a shared secret
export RCLAUDE_SECRET=$(openssl rand -hex 32)
echo "RCLAUDE_SECRET=$RCLAUDE_SECRET" > .env

# Build the web dashboard
bun run build:web

# Start
docker compose -f docker-compose.standalone.yml up -d
```

Dashboard at http://localhost:9999

### With Caddy for HTTPS

The standalone compose file includes an optional Caddy sidecar for automatic TLS:

1. Copy the example Caddyfile:
   ```bash
   cp Caddyfile.example Caddyfile
   # Edit Caddyfile - replace YOUR_DOMAIN with your actual domain
   ```

2. Configure `.env`:
   ```bash
   RCLAUDE_SECRET=<your-secret>
   RP_ID=concentrator.example.com
   ORIGIN=https://concentrator.example.com
   CADDY_HOST=concentrator.example.com
   ```

3. Uncomment the `caddy` service in `docker-compose.standalone.yml`

4. Start:
   ```bash
   docker compose -f docker-compose.standalone.yml up -d
   ```

### With caddy-docker-proxy (advanced)

If you already run [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy), use the main `docker-compose.yml`:

```bash
# Ensure the caddy network exists
docker network create caddy 2>/dev/null || true

# Configure
cat > .env << EOF
RCLAUDE_SECRET=$(openssl rand -hex 32)
RP_ID=concentrator.example.com
ORIGIN=https://concentrator.example.com
CADDY_HOST=concentrator.example.com
EOF

# Build and start
bun run build:web
docker compose up -d
```

### With nginx or other reverse proxy

Run the standalone compose (no Caddy) and point your reverse proxy at port 9999:

```nginx
server {
    listen 443 ssl;
    server_name concentrator.example.com;

    location / {
        proxy_pass http://localhost:9999;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

**Important:** WebSocket support is required. The `Upgrade` and `Connection` headers must be forwarded, and `proxy_read_timeout` should be high (WebSocket connections are long-lived).

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RCLAUDE_SECRET` | Shared secret for rclaude WS auth | *(required)* |
| `RP_ID` | WebAuthn relying party ID (your domain, no protocol) | `localhost` |
| `ORIGIN` | Allowed WebAuthn origin (full URL) | `http://localhost:9999` |
| `PORT` | External port mapping | `9999` |
| `CADDY_HOST` | Caddy reverse proxy hostname | *(empty)* |
| `VAPID_PUBLIC_KEY` | VAPID public key for push notifications | *(optional)* |
| `VAPID_PRIVATE_KEY` | VAPID private key for push notifications | *(optional)* |

### Frontend hot-reload

The Docker compose mounts `./web/dist` over the baked-in frontend assets. Rebuild the frontend on the host and changes appear immediately - no container restart needed:

```bash
bun run build:web    # Rebuilds web/dist/, served instantly by the container
```

### Health check

```bash
curl http://localhost:9999/health
# Returns "ok" with 200
```

## Authentication

The dashboard is protected by **WebAuthn passkeys**. No passwords. No self-registration.\
Passkeys can ONLY be created through CLI-generated invite links.

### First-time setup

```bash
# Inside the Docker container
docker exec concentrator concentrator-cli create-invite \
  --name yourname \
  --url https://concentrator.example.com

# Or locally (if running concentrator outside Docker)
concentrator-cli create-invite --name yourname
```

This prints a one-time invite link. Open it in your browser to register your passkey.\
Invites expire after 30 minutes.

### Managing users

```bash
# List all registered users
docker exec concentrator concentrator-cli list-users

# Revoke access (kills all active sessions immediately)
docker exec concentrator concentrator-cli revoke --name badactor

# Restore access
docker exec concentrator concentrator-cli unrevoke --name rehabilitated
```

**Rules:**
- Names must be **unique** - no duplicates allowed
- Revoking a user terminates all their active sessions instantly
- Session cookies last 7 days, then re-authentication is required
- Auth state is stored in the cache directory (`auth.json`, mode 0600)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Session switcher (fuzzy finder) |
| `Ctrl+K` then `F:` | File picker (browse .md files in session) |
| `Ctrl+Shift+N` | Quick note (append to NOTES.md) |
| `Ctrl+Shift+T` | Open terminal for current session |
| `Shift+click` TTY badge | Popout terminal to separate window |
| `Esc` | Close modal / exit file picker |

## CLI Reference

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

**Environment variables:**

| Variable | Description |
|----------|-------------|
| `RCLAUDE_SECRET` | Shared secret (alternative to `--rclaude-secret`) |
| `RCLAUDE_CONCENTRATOR` | Concentrator URL (alternative to `--concentrator`) |
| `RCLAUDE_DEBUG` | Set to `1` to enable debug logging |
| `RCLAUDE_DEBUG_LOG` | Debug log file path (default: `/tmp/rclaude-debug.log`) |

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
  --rp-id <domain>         WebAuthn relying party ID (default: localhost)
  --origin <url>           Allowed WebAuthn origin (repeatable)
  --rclaude-secret <s>     Shared secret for rclaude WebSocket auth
  -h, --help               Show help
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

# Get session transcript
curl http://localhost:9999/sessions/:id/transcript

# Get session tasks
curl http://localhost:9999/sessions/:id/tasks

# Send input to session
curl -X POST http://localhost:9999/sessions/:id/input \
  -H "Content-Type: application/json" \
  -d '{"input": "hello world"}'

# Project settings (label/icon/color per project path)
curl http://localhost:9999/api/project-settings
curl -X PUT http://localhost:9999/api/project-settings \
  -H "Content-Type: application/json" \
  -d '{"cwd": "/home/user/project", "label": "My API", "icon": "rocket", "color": "#ff6600"}'

# Push notifications (requires RCLAUDE_SECRET as Bearer token)
curl -X POST http://localhost:9999/api/push/send \
  -H "Authorization: Bearer $RCLAUDE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title": "Hello", "body": "Test notification", "tag": "test"}'

# Get VAPID public key (for browser push subscription)
curl http://localhost:9999/api/push/vapid
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
  if [[ -f ".claude/settings.local.json" ]]; then
    named_session=$(jq -r '.["tmux-session-name"] // empty' .claude/settings.local.json 2>/dev/null)
    if [[ -n "$named_session" ]]; then
      tmux_mode=true
    fi
  fi

  for arg in "$@"; do
    case "$arg" in
      --safe)       safe_mode=true ;;
      --tmux)       tmux_mode=true ;;
      --no-tmux)    tmux_mode=false; named_session="" ;;
      --no-rclaude) no_rclaude=true ;;
      *)            args+=("$arg") ;;
    esac
  done

  local base_cmd="rclaude"
  if [[ "$no_rclaude" == true ]] || ! command -v rclaude &>/dev/null; then
    base_cmd="claude"
  fi

  local cmd="$base_cmd"
  if [[ "$safe_mode" == false ]]; then
    cmd="$cmd --dangerously-skip-permissions"
  fi

  if [[ ${#args[@]} -gt 0 ]]; then
    cmd="$cmd ${args[@]}"
  fi

  if [[ "$tmux_mode" == false ]]; then
    eval "$cmd"
    return
  fi

  # --- tmux mode ---
  if [[ "$TERM_PROGRAM" == "vscode" ]] || [[ "$TERMINAL_EMULATOR" == "JetBrains-JediTerm" ]]; then
    echo "Warning: tmux mode ignored in IDE terminal"
    eval "$cmd"
    return
  fi

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

| Flag | Effect |
|------|--------|
| `--safe` | Don't skip permissions (interactive approval mode) |
| `--tmux` | Force tmux wrapping even without project config |
| `--no-tmux` | Disable tmux wrapping even if project config exists |
| `--no-rclaude` | Use plain `claude` instead of `rclaude` |

### Per-project tmux sessions

Assign a named tmux session to a project directory:

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
| `PreCompact` | Context window compaction started |
| `TeammateIdle` | Team member waiting for work |
| `TaskCompleted` | Task finished in team context |

## Project Structure

```
remote-claude/
├── bin/                       # Built binaries (gitignored)
│   ├── rclaude               # Wrapper CLI
│   ├── rclaude-agent         # Host agent for session revival
│   ├── concentrator          # Aggregation server
│   └── concentrator-cli      # Passkey management CLI
├── src/
│   ├── wrapper/              # rclaude implementation
│   │   ├── index.ts          # CLI entry, session lifecycle
│   │   ├── pty-spawn.ts      # PTY subprocess management
│   │   ├── ws-client.ts      # WebSocket client with reconnection
│   │   ├── transcript-watcher.ts  # JSONL file watcher (chokidar)
│   │   ├── file-editor.ts    # File operations for dashboard editor
│   │   ├── local-server.ts   # Hook callback receiver
│   │   └── settings-merge.ts # Claude settings injection
│   ├── concentrator/         # Server implementation
│   │   ├── index.ts          # Server entry, WS relay
│   │   ├── session-store.ts  # Session registry + persistence
│   │   ├── api.ts            # REST API + file upload
│   │   ├── auth.ts           # WebAuthn passkey auth
│   │   ├── auth-routes.ts    # Auth HTTP endpoints
│   │   ├── push.ts           # Web Push notifications (VAPID)
│   │   ├── project-settings.ts # Per-project label/icon/color
│   │   └── cli.ts            # CLI tool entry point
│   ├── agent/                # Host agent for session revival
│   └── shared/
│       └── protocol.ts       # WebSocket protocol types
├── web/                      # React dashboard
│   └── src/
│       ├── components/       # UI components
│       │   ├── web-terminal.tsx      # xterm.js remote terminal
│       │   ├── transcript-view.tsx   # Shiki-highlighted transcript
│       │   ├── session-switcher.tsx  # Ctrl+K fuzzy finder + file picker
│       │   ├── file-editor.tsx       # CodeMirror markdown editor
│       │   ├── markdown-input.tsx    # Input with syntax overlay + file upload
│       │   ├── subagent-view.tsx     # Agent list + transcript viewer
│       │   └── ...
│       ├── hooks/            # React hooks + Zustand stores
│       └── styles/           # Tokyo Night theme
├── install.sh                # Interactive installer
├── Dockerfile                # Multi-stage build
├── docker-compose.yml        # Production (caddy-docker-proxy)
├── docker-compose.standalone.yml  # Standalone deployment
├── Caddyfile.example         # Caddy config template
└── NAMES.md                  # Name candidates (we need a better name)
```

## Development

```bash
# First time: install all dependencies
bun install && cd web && bun install && cd ..

# Dev mode (hot reload)
bun run dev:wrapper              # Wrapper
bun run dev:concentrator         # Concentrator
bun run dev:web                  # Web dashboard (Vite dev server)

# Type check
bun run typecheck

# Lint + format
bunx biome check --write .

# Build everything
bun run build

# Build individual components
bun run build:web                # Web -> web/dist/
bun run build:wrapper            # rclaude -> bin/rclaude
bun run build:concentrator       # concentrator -> bin/concentrator
bun run build:cli                # concentrator-cli -> bin/concentrator-cli
bun run build:agent              # rclaude-agent -> bin/rclaude-agent
```

## Security

### WebSocket auth

rclaude authenticates to the concentrator with a shared secret (`RCLAUDE_SECRET`). Connections without a valid secret are rejected.

### WebAuthn

- No passwords, no tokens in URLs, no bearer auth to leak
- Passkey registration requires a CLI-generated invite (not accessible from the web)
- Session cookies are HMAC-SHA256 signed with a server-side secret
- The HMAC secret is auto-generated on first run and stored in `auth.secret` (mode 0600)
- Revoked users are blocked from all access immediately

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) - JavaScript runtime with native PTY support
- **Backend**: TypeScript, WebSocket, REST API
- **Auth**: WebAuthn / FIDO2 passkeys via [@simplewebauthn](https://simplewebauthn.dev/)
- **Frontend**: React 19, Vite 7, Tailwind CSS v4, shadcn/ui
- **State**: [Zustand](https://github.com/pmndrs/zustand) for reactive stores
- **Terminal**: [xterm.js](https://xtermjs.org/) with WebGL renderer + fit addon
- **Editor**: [CodeMirror](https://codemirror.net/) for file editing
- **Syntax**: [Shiki](https://shiki.matsu.io/) for code/diff highlighting
- **Virtualization**: [@tanstack/react-virtual](https://tanstack.com/virtual) for large transcript lists
- **File watching**: [chokidar](https://github.com/paulmillr/chokidar) for cross-platform JSONL streaming
- **Push**: Web Push API with VAPID
- **Theme**: Tokyo Night color palette

## License

MIT

---

<p align="center">
  <sub>Maintained by WOPR - the only winning move is to monitor everything</sub>
</p>
