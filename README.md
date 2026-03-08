```
                               __               __                __
   ________  ____ ___  ____  / /____     _____/ /___ ___  ______/ /__
  / ___/ _ \/ __ `__ \/ __ \/ __/ _ \   / ___/ / __ `/ / / / __  / _ \
 / /  /  __/ / / / / / /_/ / /_/  __/  / /__/ / /_/ / /_/ / /_/ /  __/
/_/   \___/_/ /_/ /_/\____/\__/\___/   \___/_/\__,_/\__,_/\__,_/\___/

        ┌─────────────────────────────────────────────────────┐
        │  DISTRIBUTED SESSION MONITORING FOR CLAUDE CODE    │
        └─────────────────────────────────────────────────────┘
```

# remote-claude

**Aggregate and monitor multiple Claude Code sessions from a single dashboard.**

Run Claude Code in multiple terminals, see all sessions in one place, send input remotely, and never lose track of what your AI is doing.

## Features

- **Multi-session monitoring** - See all Claude Code sessions across terminals
- **Real-time event streaming** - Watch tool calls, prompts, and responses live
- **Remote input** - Send commands to any session from the web dashboard
- **Sub-agent tracking** - Visualize spawned agents, their types, and lifecycle
- **Team detection** - See which sessions are part of coordinated teams
- **Passkey authentication** - WebAuthn passkeys, CLI-only invite creation, no passwords
- **Path-jailed file access** - Transcript/image serving locked to allowed directories
- **Session persistence** - Sessions survive concentrator restarts
- **Session resume** - Resumed Claude sessions show as the same session
- **Transcript viewer** - Markdown-rendered conversation history with syntax highlighting
- **Docker-ready** - Dockerfile + compose with health checks and Caddy integration
- **Mobile-friendly UI** - Responsive design with Tokyo Night color scheme

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

Installs `rclaude`, `concentrator`, and `concentrator-cli` to `~/.local/bin`.

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
| `RP_ID` | WebAuthn relying party ID (your domain, no protocol) | `localhost` |
| `ORIGIN` | Allowed WebAuthn origin (full URL) | `http://localhost:9999` |
| `CADDY_HOST` | Caddy reverse proxy hostname (for caddy-docker-proxy) | *(empty)* |

### With Caddy reverse proxy

The compose file includes labels for [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy). Set `CADDY_HOST` to your domain and ensure the concentrator is on the `caddy` network:

```env
RP_ID=concentrator.example.com
ORIGIN=https://concentrator.example.com
CADDY_HOST=concentrator.example.com
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
  -p, --port <port>      WebSocket/API port (default: 9999)
  -v, --verbose          Enable verbose logging
  -w, --web-dir <dir>    Serve web dashboard from directory
  --cache-dir <dir>      Session cache directory (default: ~/.cache/concentrator)
  --clear-cache          Clear session cache and exit
  --no-persistence       Disable session persistence
  --allow-root <dir>     Add allowed filesystem root (repeatable)
  --rp-id <domain>       WebAuthn relying party ID (default: localhost)
  --origin <url>         Allowed WebAuthn origin (repeatable)
  -h, --help             Show help
```

### rclaude

```
rclaude [OPTIONS] [CLAUDE_ARGS...]

OPTIONS:
  --concentrator <url>   Concentrator WebSocket URL (default: ws://localhost:9999)
  --no-concentrator      Run without forwarding to concentrator
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

# Send input to session
curl -X POST http://localhost:9999/sessions/:id/input \
  -H "Content-Type: application/json" \
  -d '{"input": "hello world"}'
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
│   ├── concentrator          # Aggregation server
│   └── concentrator-cli      # Passkey management CLI
├── src/
│   ├── wrapper/              # rclaude implementation
│   │   ├── index.ts          # CLI entry point + auto-start concentrator
│   │   ├── pty-spawn.ts      # PTY subprocess management
│   │   ├── ws-client.ts      # WebSocket client with reconnection
│   │   ├── local-server.ts   # Hook callback receiver
│   │   └── settings-merge.ts # Claude settings injection
│   ├── concentrator/         # Server implementation
│   │   ├── index.ts          # Server entry point
│   │   ├── session-store.ts  # Session registry + persistence
│   │   ├── api.ts            # REST API routes
│   │   ├── auth.ts           # WebAuthn passkey auth core
│   │   ├── auth-routes.ts    # Auth HTTP endpoints
│   │   ├── path-jail.ts      # Filesystem access control
│   │   └── cli.ts            # CLI tool entry point
│   └── shared/
│       └── protocol.ts       # WebSocket protocol types
├── web/                      # React dashboard
│   └── src/
│       ├── components/       # UI components
│       │   ├── auth-gate.tsx  # Login/registration gate
│       │   ├── subagent-view.tsx # Agent tree visualization
│       │   └── ...
│       ├── hooks/            # React hooks + API
│       └── styles/           # Tokyo Night theme
├── Dockerfile                # Multi-stage build
├── docker-compose.yml        # Production deployment
└── .env.example              # Configuration template
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
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) - JavaScript runtime with native PTY support
- **Backend**: TypeScript, WebSocket, REST API
- **Auth**: WebAuthn / FIDO2 passkeys via [@simplewebauthn](https://simplewebauthn.dev/)
- **Frontend**: React 19, Vite 7, Tailwind CSS v4, shadcn/ui
- **Theme**: Tokyo Night color palette

## License

MIT

---

<p align="center">
  <sub>Maintained by WOPR - the only winning move is to monitor everything</sub>
</p>
