# Multi-Wrapper Session Fix + wrapperId-First Routing

## Problem

When two `rclaude` instances share the same Claude session ID (e.g. via `claude --continue`),
the second instance's exit kills the session on the concentrator even while the first is still active.

**Root cause:** `sessionSockets` was `Map<sessionId, socket>` - second wrapper overwrites first.
When either exits, `endSession()` marks the whole session as ended.

## Solution: wrapperId as Universal Routing Identity

```
wrapperId = physical identity (this machine, this process, this PTY)
sessionId = logical identity (Claude Code session, can be shared via --continue)
```

ALL terminal operations route by wrapperId. Session-level operations (transcript, events, file
requests) route by sessionId but any connected wrapper can serve them.

See `FLOW.md` for full data flow diagrams.

## Backend Changes

### `src/shared/protocol.ts`
- `wrapperId: string` on `SessionMeta`, `ReviveSession`
- `wrapperId?: string` on `ReviveResult`
- ALL terminal interfaces (`TerminalAttach`, `TerminalDetach`, `TerminalData`, `TerminalResize`,
  `TerminalError`) use `wrapperId: string` instead of `sessionId`

### `src/concentrator/session-store.ts`
- `sessionSockets`: `Map<sessionId, Map<wrapperId, socket>>` (multi-wrapper tracking)
- `terminalViewers`: `Map<wrapperId, Set<socket>>` (keyed by wrapperId, not sessionId)
- `setSessionSocket(sessionId, wrapperId, ws)` - registers a wrapper
- `getSessionSocketByWrapper(wrapperId)` - direct wrapper lookup (scans all sessions)
- `removeSessionSocket(sessionId, wrapperId)` - removes one wrapper
- `getActiveWrapperCount(sessionId)` - how many wrappers still connected
- `wrapperIds: string[]` added to `SessionSummary` (sent to dashboard)
- **Removed:** `setTerminalTargetWrapper`, `getTerminalTargetWrapper`, `clearTerminalTargetWrapper`,
  `getTerminalSocket` - no longer needed with direct wrapperId routing

### `src/concentrator/index.ts`
- `wrapperId?: string` on `WsData` interface
- `meta` handler: stores wrapperId, calls `setSessionSocket(sessionId, wrapperId, ws)`
- `end` handler: removes only that wrapper, endSession only when `getActiveWrapperCount === 0`
- `close` handler: same - remove wrapper, only end if none remain
- ALL terminal handlers route by `data.wrapperId` using `getSessionSocketByWrapper()`

### `src/wrapper/ws-client.ts`
- `wrapperId: string` in `WsClientOptions`
- `sendTerminalData` uses wrapperId (not sessionId)
- wrapperId included in SessionMeta on connect

### `src/wrapper/index.ts`
- `RCLAUDE_WRAPPER_ID` env from revive flow, else `randomUUID()`
- Passes `wrapperId: internalId` to `createWsClient()`

### `src/concentrator/api.ts`
- Revive endpoint generates `wrapperId = randomUUID()`, sends in revive message

### `src/agent/index.ts`
- Passes `wrapperId` through revive chain
- `RCLAUDE_WRAPPER_ID` env var to revive-session.sh

### `scripts/revive-session.sh`
- Passes `RCLAUDE_WRAPPER_ID` env through tmux flags

### `src/concentrator/ws-server.ts`
- Updated `setSessionSocket` call to 3-arg signature

## Frontend Changes

### `web/src/lib/types.ts`
- `wrapperIds?: string[]` on `Session` interface

### `web/src/hooks/use-sessions.ts`
- `TerminalMessage` uses `wrapperId` (not `sessionId`)
- `terminalWrapperId: string | null` in store state
- `openTerminal(wrapperId)` - takes wrapperId, resolves owner session for `selectedSessionId`
- Hash: `#terminal/{wrapperId}` (was `#terminal/{sessionId}`)

### `web/src/hooks/use-websocket.ts`
- `wrapperIds` mapped from `SessionSummary` to `Session`
- Terminal message handler passes `wrapperId` from incoming message

### `web/src/components/web-terminal.tsx`
- Props: `wrapperId` is primary, `sessionId` removed (derived from store)
- `onSwitchWrapper(wrapperId)` replaces `onSwitchSession(sessionId)`
- Tabs show wrappers (not sessions) - flattens `session.wrapperIds` into individual tabs
- Multi-wrapper sessions show `:xxxx` suffix per tab to disambiguate
- All WS messages use wrapperId exclusively

### `web/src/components/session-detail.tsx`
- TTY button: resolves `session.wrapperIds[0]`, calls `openTerminal(wid)`
- Shift+click popout: `#popout-terminal/{wrapperId}`
- WebTerminal rendered with `terminalWrapperId` from store

### `web/src/app.tsx`
- Ctrl+Shift+T: resolves `session.wrapperIds[0]`
- Switcher select: resolves `session.wrapperIds[0]`
- Popout URL: `#popout-terminal/{wrapperId}` (wrapperId only, sessionId derived from store)

## File Editor Reconciliation

The file editor feature was built concurrently by another session. Key notes:

- File operations (read/write/diff) are session-scoped, not wrapper-scoped, since files are on
  disk (shared CWD). `getSessionSocket(sessionId)` returns any connected wrapper - fine for files.
- `setSessionSocket` is now 3-arg - file editor code doesn't call it, only `getSessionSocket`.
- Protocol types, ws-client callbacks, wrapper wiring are additive - should merge clean.

### Reconciliation checklist
- [ ] Merge both branches / resolve conflicts
- [ ] Verify `getSessionSocket(sessionId)` works for file editor relay
- [ ] `bun run typecheck` clean
- [ ] `bunx vitest run` - all tests pass
- [ ] `bun run build` - all binaries compile

## Status

Backend + frontend complete. Typecheck passes (only pre-existing errors in untracked `use-file-editor.ts`).
