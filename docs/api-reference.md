# API Reference

## Message Router

All WS messages dispatch through `message-router.ts` to handler files in
`src/concentrator/handlers/`. No switch/case in index.ts.

**Adding a new message type:**
1. Create handler in the appropriate handler file (or new file)
2. Register: `registerHandlers({ my_message_type: myHandler })`
3. New file? Add to `handlers/index.ts` barrel

**HandlerContext API:**
- `ctx.ws` - WebSocket connection
- `ctx.sessions` - session store
- `ctx.caller` / `ctx.callerSettings` - resolved caller session + project settings
- `ctx.reply(msg)` - send JSON to caller
- `ctx.broadcast(msg)` - all dashboard subscribers (ONLY global messages)
- `ctx.broadcastScoped(msg, cwd)` - subscribers with chat:read for this CWD (USE THIS for session data)
- `ctx.push.sendToAll(payload)` - web push notification
- `ctx.links` - persisted link operations
- `ctx.logMessage(entry)` - inter-session message log
- `ctx.log.info/error/debug(msg)` - contextual logger
- `ctx.requireBenevolent()` / `ctx.requireAgent()` / `ctx.requireSession()` - guards

**Guards** throw `GuardError`, router catches and replies `{type}_result` with error.

## WS Messages

Dashboard sends `{ type, ...data }`, handler replies `{ type: '{type}_result', ok, ... }`.

| WS message | Handler | Purpose |
|---|---|---|
| `send_input` | `dashboard-actions.ts` | Send text to session |
| `dismiss_session` | `dashboard-actions.ts` | Remove ended session |
| `revive_session` | `dashboard-actions.ts` | Wake dead session via agent |
| `update_settings` | `dashboard-actions.ts` | Save global settings |
| `update_project_settings` | `dashboard-actions.ts` | Save per-project settings |
| `delete_project_settings` | `dashboard-actions.ts` | Clear per-project settings |
| `update_session_order` | `dashboard-actions.ts` | Save sidebar tree order |
| `terminate_session` | `channel.ts` | Kill active session |
| `subscribe` | `channel.ts` | Dashboard subscribe |
| `channel_subscribe` | `channel.ts` | Per-session stream subscribe |
| `channel_send` | `channel.ts` | Inter-session messaging |
| `terminal_attach/data/resize` | `terminal.ts` | Terminal I/O |
| `file_*` | `files.ts` | File editor (has requestId pattern) |
| `voice_*` | `voice.ts` | Voice streaming |

## HTTP Endpoints

**Principle:** WebSocket for real-time data. HTTP for auth, bootstrap, request/response.

**Bootstrap GETs:**
- `GET /sessions/:id/events` - bulk event history
- `GET /sessions/:id/transcript` - bulk transcript
- `GET /sessions/:id/subagents/*` - subagent data
- `GET /api/settings` - global settings
- `GET /api/settings/projects` - project settings
- `GET /api/session-order` - sidebar tree
- `GET /api/capabilities` - server feature flags

**Request/response (need WS req/res abstraction):**
- `POST /api/settings/projects/generate-keyterms` - LLM call
- `POST /api/push/subscribe` - push subscription

**Data queries:**
- `GET /api/shared-files`, `GET /api/links/messages`
- `GET /api/stats`, `/api/stats/turns`, `/api/stats/hourly`, `/api/stats/summary`

**Auth (must stay HTTP):**
- `GET /auth/status`, `POST /auth/login/*`, `POST /auth/register/*`, `POST /auth/logout`
- `POST /api/admin/impersonate` - create auth token for another user (admin only, debugging)

**Deprecated (WS equivalents exist):**
- `POST /sessions/:id/input` -> `send_input` WS
- `POST /sessions/:id/revive` -> `revive_session` WS
- `DELETE /sessions/:id` -> `dismiss_session` WS
- `POST /api/settings` -> `update_settings` WS
- `POST/DELETE /api/settings/projects` -> `update/delete_project_settings` WS
- `POST /api/session-order` -> `update_session_order` WS

## Settings System

**Server settings** (`GET/POST /api/settings`) - shared across clients:
- `{cacheDir}/global-settings.json`, Zod-validated, soft-fail
- Fields: `idleTimeoutMinutes`, `userLabel`, `agentLabel`
- Broadcast `settings_updated` WS on change

**Client prefs** (`localStorage:dashboard-prefs`) - per-browser:
- Fields: `showInactiveByDefault`, `compactMode`, `showVoiceInput`
- `usePrefs()` hook, `prefs-changed` window event for sync

**Project settings** (`GET/POST/DELETE /api/settings/projects`) - per-project:
- `{cacheDir}/project-settings.json`, keyed by CWD
- Fields: `label`, `icon`, `color`, `keyterms[]`, `defaultLaunchMode`, `defaultEffort`, `defaultModel`, `trustLevel`
