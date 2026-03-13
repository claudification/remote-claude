# remote-claude

Session monitoring + remote control for Claude Code. Wraps `claude` CLI with hooks, streams events to a concentrator server, and provides a web dashboard.

## Production

**Domain:** `concentrator.frst.dev` (https://concentrator.frst.dev)\
**Caddy:** Runs on Synology NAS, reverse proxies to concentrator container\
**Docker:** Concentrator runs locally in Docker on port 9999

## Architecture

```
rclaude (host)  --WS-->  concentrator (Docker)  <--WS--  dashboard (browser)
   |                          |
   PTY (claude)          session store
                         REST API
                         web UI
```

**Components:**
- **rclaude** - CLI wrapper that spawns claude with PTY + hook injection, forwards events over WS
- **concentrator** - Aggregator server (HTTP + WS + WebAuthn auth), runs in Docker
- **dashboard** - React SPA (Vite + Tailwind), served by concentrator
- **rclaude-agent** - Host-side agent for session revival via tmux
- **concentrator-cli** - CLI for managing auth (passkeys, invite codes)

## Dev Commands

```bash
bun run dev:wrapper         # Run rclaude locally (no compile)
bun run dev:concentrator    # Run concentrator locally
bun run dev:web             # Vite dev server on port 3456
bun run typecheck           # TypeScript check (root + web)
bunx biome check --write .  # Lint + format (auto-fix)
```

## Linting & Formatting

Uses **Biome** (`biome.json`). Run `bunx biome check --write .` before committing.

Key settings:
- 2-space indent, 120 line width
- Single quotes, no semicolons, trailing commas
- Import organization: auto-sorted
- CSS linting/formatting: disabled (Tailwind)

Pre-existing lint warnings (switch fallthroughs, implicit any) are known - don't fix unless touching that code.

## Build

```bash
bun run build               # Build everything (web + all binaries)
bun run build:web           # Vite build -> web/dist/
bun run build:wrapper       # Compile -> bin/rclaude
bun run build:concentrator  # Compile -> bin/concentrator
bun run build:cli           # Compile -> bin/concentrator-cli
bun run build:agent         # Compile -> bin/rclaude-agent
```

All binaries are standalone Bun-compiled executables in `bin/`.

## Install (local host)

`~/.local/bin/` has **symlinks** pointing to `bin/` in this repo. Builds update in place - no copy step needed.

**DO NOT replace symlinks with copies.** If symlinks break, restore with:
```bash
ln -sf "$(pwd)/bin/rclaude" ~/.local/bin/rclaude
# (same for concentrator, concentrator-cli, rclaude-agent)
```

## Deploy (concentrator Docker)

Concentrator runs in Docker behind Caddy reverse proxy.

```bash
# Build and deploy
docker compose build && docker compose up -d

# Rebuild after code changes
docker compose build --no-cache && docker compose up -d

# View logs
docker compose logs -f concentrator
```

**Required env vars** (set in shell or `.env`):
- `RCLAUDE_SECRET` - shared secret for rclaude WS auth (required)
- `RP_ID` - WebAuthn relying party domain (default: localhost)
- `ORIGIN` - WebAuthn origin URL (default: http://localhost:9999)
- `CADDY_HOST` - Caddy reverse proxy hostname (optional)
- `PORT` - external port mapping (default: 9999)

**Auth management** (run inside container or use concentrator-cli):
```bash
concentrator-cli invite create          # Create invite code
concentrator-cli passkey list           # List registered passkeys
```

## Settings System

Two tiers of settings with different storage and scope:

**Server settings** (`GET/POST /api/settings`) - shared across all clients:
- Stored in `{cacheDir}/global-settings.json` on concentrator
- Validated with Zod schema (`src/concentrator/global-settings.ts`)
- Soft-fail validation: invalid fields rejected, valid fields applied
- Changes broadcast to all connected dashboards via `settings_updated` WS message
- Frontend reads from Zustand `globalSettings` store (populated on mount + WS updates)
- Fields: `idleTimeoutMinutes`, `userLabel`, `agentLabel`

**Client prefs** (`localStorage` key `dashboard-prefs`) - per-browser:
- Stored in browser localStorage, no server involvement
- Fields: `showInactiveByDefault`, `compactMode`, `showVoiceInput`
- Read via `usePrefs()` hook / `loadPrefs()` in `settings-page.tsx`
- Changes dispatch `prefs-changed` window event for cross-component sync

**Project settings** (`GET/POST/DELETE /api/settings/projects`) - per-project:
- Stored in `{cacheDir}/project-settings.json`
- Keyed by project `cwd` path
- Fields: `label`, `icon`, `color`, `keyterms[]`
- CRUD via `src/concentrator/project-settings.ts`

## Project Structure

```
src/
  wrapper/          rclaude CLI wrapper
    index.ts        Main entry: PTY spawn, WS connect, hook/transcript/task forwarding
    pty-spawn.ts    PTY management (spawn, resize, attach/detach)
    ws-client.ts    WebSocket client to concentrator
    transcript-watcher.ts  Watches JSONL transcript files, streams deltas
    settings-merge.ts      Merges rclaude hooks into Claude Code settings
  concentrator/     Server (HTTP + WS + auth)
    index.ts        Main entry: HTTP routes, WS handlers, message relay
    session-store.ts  In-memory session registry, event processing, transcript cache
    api.ts          REST API endpoints
    auth-routes.ts  WebAuthn auth + public asset allowlist
    project-settings.ts  Per-project label/icon/color CRUD
  agent/            Host agent for session revival via tmux
  shared/           Shared types
    protocol.ts     All message types, hook events, session/subagent/task interfaces
    version.ts      Build-time git hash + timestamp (generated by gen-version.ts)
  hooks/            forwarder.sh (Claude hook -> rclaude via localhost HTTP)
web/                React dashboard (Vite + Tailwind + Zustand)
  src/hooks/
    use-sessions.ts   Zustand store: sessions, events, transcripts, WS message sending
    use-websocket.ts  WS connection, message routing, session state mapping
  src/components/
    session-list.tsx      Sidebar: active sessions grouped by cwd, inactive by project
    session-detail.tsx    Main panel: transcript/events/tasks/agents tabs, input bar
    transcript-view.tsx   JSONL transcript renderer with Shiki syntax highlighting
    web-terminal.tsx      Fullscreen xterm.js overlay with PTY streaming
    terminal-toolbar.tsx  Touch-friendly shortcut buttons (Ctrl+C, paste, etc.)
    terminal-settings.tsx Theme/font/size picker for terminal
    markdown-input.tsx    Textarea with live syntax highlight overlay
    subagent-view.tsx     Subagent list + transcript viewer
scripts/            Build scripts, gen-version.ts, revive-session.sh
bin/                Compiled binaries (gitignored)
```

## Hook System Reference

See **[IMPORTANT-HOOKS.md](./IMPORTANT-HOOKS.md)** for the complete reference on:
- All 18 hook events, their data fields, and firing order
- Session ID extraction (three different IDs!)
- Compaction lifecycle (PreCompact -> SessionStart, NO PostCompact)
- Subagent lifecycle and transcript streaming
- Task/background task tracking
- Known quirks and gotchas

## Key Data Flows

**Transcript streaming**: rclaude watches Claude's JSONL transcript file via chokidar,
streams new entries over WS to concentrator, which caches them in memory and pushes
to dashboard subscribers. No HTTP polling -- pure WebSocket push.

**Terminal**: Browser sends `terminal_attach` -> concentrator relays to rclaude ->
rclaude starts forwarding PTY output over WS. Keystrokes flow back the same path.
Local terminal and web terminal are mirrors of the same PTY.

**Hook events**: Claude Code fires hooks (SessionStart, PreToolUse, SubagentStart,
PreCompact, etc.) -> forwarder.sh POSTs to rclaude's localhost HTTP -> rclaude
forwards over WS to concentrator -> concentrator processes (updates session state,
tracks subagents/tasks/compacting) and broadcasts to dashboard.

**Session state tracking** (concentrator-side, in session-store.ts):
- Subagent descriptions captured from PreToolUse(Agent) `tool_input.description`
- Compacting state set on PreCompact, cleared on next event
- Tasks/bg-tasks updated from rclaude's periodic task file reads
- Transcript truncation recovery: watcher detects `size < offset` and resets

## Gotchas

**Zustand selector fallbacks must use stable references.** Never use inline `|| []`
or `|| {}` in a Zustand selector -- it creates a new reference every render, which
fails `Object.is` equality and causes an infinite re-render loop (React error #185).
Always use a module-level constant:

```ts
// BAD - infinite re-render loop
const events = useStore(s => s.events[id] || [])

// GOOD - stable reference
const EMPTY: any[] = []
const events = useStore(s => s.events[id] || EMPTY)
```

**Bun fs.watch macOS bug.** Closing a file watcher and re-creating one on a different
file in the same directory causes `fs.watch` to silently stop firing events. Fix:
watch the parent directory with `depth: 0` and filter by filename. See
`src/wrapper/transcript-watcher.ts` for the pattern.

## Capabilities

rclaude declares capabilities on connect via `SessionMeta.capabilities`.\
Dashboard uses these to conditionally show features (e.g. terminal button).

Current capabilities: `terminal`\
Disable with: `rclaude --no-terminal`

## Frontend Deploy Shortcut

`web/dist/` is volume-mounted into Docker (`./web/dist:/srv/web:ro`).\
Frontend-only changes: just `bun run build:web` -- no container rebuild needed.

## Diag Mnemonics

When the user pastes a `diag:{sessionId}` mnemonic, fetch the session diagnostic
data from the concentrator and analyze it:

```bash
curl -s https://CONCENTRATOR_HOST/sessions/{sessionId}/diag
```

The diag contains: session metadata, capabilities, event counts, transcript cache
size, subagents, tasks, bg tasks, teammates, team info, and the diagLog (structured
debug entries from rclaude). Use this to debug issues with specific sessions.

## Dashboard Commands & Shortcuts

**Commands are first-class, shortcuts are optional accelerators.**

Every dashboard action MUST be a command palette (Ctrl+K) command first. Keyboard
shortcuts are added second as convenience for power users. Mobile users have no
keyboard -- they rely on the command palette.

**How to add a new action:**

1. Add the action to the Zustand store (e.g. `toggleFoo: () => ...`)
2. Register it as a command in the session switcher (`session-switcher.tsx`)
3. Optionally bind a keyboard shortcut in `app.tsx`'s global keydown handler
4. Add the shortcut to `shortcut-help.tsx` if one exists

**Existing commands:**

| Command | Shortcut | Store method |
|---------|----------|-------------|
| Session switcher | Ctrl+K | `toggleSwitcher()` |
| File browser | Ctrl+K then `F:` | (switcher mode) |
| Spawn session | Ctrl+K then `S:` | (switcher mode) |
| Quick note | Ctrl+Shift+N | event: `open-quick-note` |
| Open terminal | Ctrl+Shift+T | `openTerminal(wrapperId)` |
| Toggle verbose | Ctrl+O | `toggleExpandAll()` |
| Debug console | Ctrl+Shift+D | `toggleDebugConsole()` |
| Shortcut help | Shift+? | (local state in shortcut-help.tsx) |

**Naming:** Commands use imperative verbs ("Toggle debug console", "Open terminal").
Store methods use `toggleX()` for on/off, `openX()` for show, `setShowX(bool)` for explicit.

## Version Tracking

`scripts/gen-version.ts` bakes git hash + build time into `src/shared/version.ts`
at compile. rclaude sends version in SessionMeta on connect. Concentrator logs it
and exposes it in session summaries. Fails gracefully without git (Docker builds).

## Haptics

**Every interactive touch action MUST have haptic feedback.** Use `haptic()` from
`web/src/lib/utils.ts` for all touch interactions in the dashboard:

- `haptic('tap')` - button presses, toggles, selections
- `haptic('tick')` - subtle state changes, threshold crossings
- `haptic('double')` - important actions starting (recording, connecting)
- `haptic('success')` - completed actions (submitted, saved)
- `haptic('error')` - failures, cancellations, destructive actions

When adding new interactive components, always consider what haptic pattern fits.
Mobile users rely on haptic feedback to confirm their actions registered.

## Claude Code Upstream Tracking

**Changelog:** `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`

This project wraps Claude Code and depends on its hook system, transcript format,
settings files, and CLI behavior. Use the `/cc-changelog` skill to fetch and analyze
upstream changes for impact on rclaude. Key areas to watch:
- Hook events (new hooks, changed data fields, firing order changes)
- Settings/config format changes (settings.json, .mcp.json)
- Transcript format changes (JSONL structure, new entry types)
- Bug fixes that affect our workarounds (double SessionStart, compaction, etc.)
- New CLI flags or capabilities we could leverage
