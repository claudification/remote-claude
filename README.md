# remote-claude

Distributed session monitoring system for Claude Code. Aggregates sessions from multiple terminals into a single dashboard.

```
┌───────────────────────┐         WebSocket          ┌──────────────────────┐
│   rclaude (wrapper)   │ ────────────────────────►  │    concentrator      │
│                       │                            │                      │
│ • Generates settings  │     ┌──────────────────┐   │ • Session registry   │
│ • Injects hooks       │     │ rclaude (term 2) │──►│ • Event aggregation  │
│ • PTY passthrough     │     └──────────────────┘   │ • REST API           │
│ • Forwards events     │                            │                      │
└───────────────────────┘     ┌──────────────────┐   └──────────────────────┘
                              │ rclaude (term N) │──►
                              └──────────────────┘
```

## Installation

```bash
bun install
bun run build
```

## Usage

### Start the Concentrator

```bash
./bin/concentrator             # Default port 9999
./bin/concentrator -p 8080     # Custom port
./bin/concentrator -v          # Verbose logging
```

### Use rclaude (drop-in replacement for claude)

```bash
./bin/rclaude                          # Interactive session
./bin/rclaude --resume                 # Resume session
./bin/rclaude -p "build feature X"     # Non-interactive
./bin/rclaude --no-concentrator        # Run without forwarding
```

### REST API

```bash
curl http://localhost:9999/health           # Health check
curl http://localhost:9999/sessions         # List all sessions
curl http://localhost:9999/sessions?active=true  # Active only
curl http://localhost:9999/sessions/:id     # Session details
curl http://localhost:9999/sessions/:id/events   # Session events
```

## How It Works

1. **rclaude** starts a local HTTP server and generates a merged settings file
2. Hook callbacks are injected that POST events to the local server
3. The wrapper spawns `claude` with PTY passthrough for full terminal emulation
4. Events flow: `claude hooks` -> `curl POST` -> `rclaude local server` -> `WebSocket` -> `concentrator`
5. Concentrator maintains session registry and exposes REST API

## Components

- `src/wrapper/` - rclaude CLI wrapper
- `src/concentrator/` - Aggregation server
- `src/shared/` - Shared types and protocol
- `src/hooks/` - Hook forwarder script

## Development

```bash
bun run wrapper           # Run wrapper directly
bun run concentrator      # Run concentrator directly
bun run typecheck         # Type check
bun run build             # Build binaries
```

## Environment Variables

- `RCLAUDE_DEBUG=1` - Enable debug logging in wrapper
- `RCLAUDE_SESSION_ID` - Session ID (auto-generated)
- `RCLAUDE_PORT` - Local server port (auto-assigned)
