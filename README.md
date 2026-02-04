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
- **Session persistence** - Sessions survive concentrator restarts
- **Session resume** - Resumed Claude sessions show as the same session
- **Transcript viewer** - Markdown-rendered conversation history with syntax highlighting
- **Mobile-friendly UI** - Responsive design with Tokyo Night color scheme

## Architecture

```
┌─────────────────────────┐              ┌──────────────────────────┐
│   Terminal 1            │              │      CONCENTRATOR        │
│   ┌─────────────────┐   │   WebSocket  │  ┌──────────────────┐    │
│   │    rclaude      │───┼──────────────┼─►│  Session Store   │    │
│   │    (wrapper)    │   │              │  │  Event Registry  │    │
│   └────────┬────────┘   │              │  │  REST API        │    │
│            │ PTY        │              │  │  WebSocket Hub   │    │
│   ┌────────▼────────┐   │              │  └──────────────────┘    │
│   │  claude (CLI)   │   │              │           │              │
│   └─────────────────┘   │              │           │ HTTP/WS      │
└─────────────────────────┘              │           ▼              │
                                         │  ┌──────────────────┐    │
┌─────────────────────────┐              │  │   Web Dashboard  │    │
│   Terminal 2            │              │  │   (React + Vite) │    │
│   ┌─────────────────┐   │   WebSocket  │  └──────────────────┘    │
│   │    rclaude      │───┼──────────────┼─►                        │
│   └─────────────────┘   │              └──────────────────────────┘
└─────────────────────────┘
                                                   ▲
┌─────────────────────────┐                        │
│   Terminal N...         │────────────────────────┘
└─────────────────────────┘
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude Code](https://claude.ai/code) CLI installed

### Installation

```bash
git clone https://github.com/claudification/remote-claude.git
cd remote-claude
bun install
bun run build
```

### Install to PATH (Optional)

Install binaries to `~/.local/bin` for global access:

```bash
# Create ~/.local/bin if needed
mkdir -p ~/.local/bin

# Install binaries
cp bin/rclaude ~/.local/bin/
cp bin/concentrator ~/.local/bin/

# Ensure ~/.local/bin is in PATH (add to ~/.zshrc or ~/.bashrc)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Or use the one-liner:

```bash
mkdir -p ~/.local/bin && cp bin/{rclaude,concentrator} ~/.local/bin/ && echo 'rclaude and concentrator installed to ~/.local/bin'
```

Now you can run `rclaude` and `concentrator` from anywhere.

### Start the Concentrator

```bash
./bin/concentrator -v
```

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CLAUDE CONCENTRATOR                                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  WebSocket:  ws://localhost:9999                                           │
│  REST API:   http://localhost:9999                                         │
│  Verbose:    ON                                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Start the Web Dashboard

```bash
cd web
bun install
bun run dev
```

Open http://localhost:3456 for the monitoring dashboard.

### Use rclaude (Drop-in Claude Replacement)

```bash
# Instead of: claude
# Use:        ./bin/rclaude

./bin/rclaude                          # Interactive session
./bin/rclaude --resume                 # Resume previous session
./bin/rclaude -p "build feature X"     # Non-interactive prompt
./bin/rclaude --no-concentrator        # Run without forwarding
./bin/rclaude --concentrator ws://myserver:9999  # Custom server
```

All Claude CLI arguments pass through transparently.

## CLI Reference

### concentrator

```bash
./bin/concentrator [OPTIONS]

OPTIONS:
  -p, --port <port>      WebSocket/API port (default: 9999)
  -v, --verbose          Enable verbose logging
  --cache-dir <dir>      Session cache directory (default: ~/.cache/concentrator)
  --clear-cache          Clear session cache and exit
  --no-persistence       Disable session persistence
  -h, --help             Show help
```

### rclaude

```bash
./bin/rclaude [OPTIONS] [CLAUDE_ARGS...]

OPTIONS:
  --concentrator <url>   Concentrator WebSocket URL (default: ws://localhost:9999)
  --no-concentrator      Run without forwarding to concentrator
  --rclaude-help         Show rclaude help

All other arguments pass through to claude CLI.
```

## REST API

```bash
# Health check
curl http://localhost:9999/health

# List all sessions
curl http://localhost:9999/sessions

# List active sessions only
curl http://localhost:9999/sessions?active=true

# Get session details
curl http://localhost:9999/sessions/:id

# Get session events
curl http://localhost:9999/sessions/:id/events

# Get session transcript
curl http://localhost:9999/sessions/:id/transcript

# Send input to session (remote control!)
curl -X POST http://localhost:9999/sessions/:id/input \
  -H "Content-Type: application/json" \
  -d '{"input": "hello world"}'
```

## How It Works

1. **rclaude** injects hooks into Claude Code via a merged settings file
2. Claude Code fires hook events (SessionStart, ToolUse, Stop, etc.)
3. Hook scripts POST events to rclaude's local HTTP server
4. rclaude forwards events to the concentrator via WebSocket
5. Concentrator aggregates sessions and exposes REST API + Web UI
6. Web dashboard displays real-time session activity
7. Remote input flows back: Web UI → API → WebSocket → rclaude → PTY

## Hook Events Captured

| Event | Description |
|-------|-------------|
| `SessionStart` | New session with model, cwd, transcript path |
| `SessionEnd` | Session terminated |
| `UserPromptSubmit` | User entered a prompt |
| `PreToolUse` | About to execute a tool |
| `PostToolUse` | Tool execution completed |
| `Stop` | Claude stopped (waiting for input) |
| `Notification` | System notification |
| `SubagentStart` | Spawned a subagent |
| `SubagentStop` | Subagent completed |

## Project Structure

```
remote-claude/
├── bin/                    # Built binaries
│   ├── rclaude            # Wrapper CLI
│   └── concentrator       # Aggregation server
├── src/
│   ├── wrapper/           # rclaude implementation
│   │   ├── index.ts       # CLI entry point
│   │   ├── pty-spawn.ts   # PTY subprocess management
│   │   ├── ws-client.ts   # WebSocket client
│   │   ├── local-server.ts # Hook callback receiver
│   │   └── settings-merge.ts # Settings injection
│   ├── concentrator/      # Server implementation
│   │   ├── index.ts       # Server entry point
│   │   ├── session-store.ts # Session registry + persistence
│   │   ├── ws-server.ts   # WebSocket server
│   │   └── api.ts         # REST API routes
│   └── shared/            # Shared types
│       └── protocol.ts    # WebSocket protocol types
└── web/                   # React dashboard
    ├── src/
    │   ├── components/    # UI components
    │   ├── hooks/         # React hooks + API
    │   └── styles/        # Tokyo Night theme
    └── package.json
```

## Development

```bash
# Run wrapper in dev mode
bun run wrapper

# Run concentrator in dev mode
bun run concentrator

# Type check
bun run typecheck

# Build binaries
bun run build

# Web dashboard dev server
cd web && bun run dev
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `RCLAUDE_DEBUG=1` | Enable debug logging in wrapper |

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) - Fast JavaScript runtime with native PTY support
- **Backend**: TypeScript, WebSocket, REST API
- **Frontend**: React 19, Vite 7, Tailwind CSS v4, shadcn/ui
- **Theme**: Tokyo Night color palette

## License

MIT

---

<p align="center">
  <sub>Built with ☕ and questionable life choices</sub>
</p>
