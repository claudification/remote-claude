# API Reference

## Message Router

All WS messages dispatch through `message-router.ts` to handler files in
`src/broker/handlers/`. No switch/case in index.ts.

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
| `send_input` | `control-panel-actions.ts` | Send text to session |
| `dismiss_session` | `control-panel-actions.ts` | Remove ended session |
| `revive_session` | `control-panel-actions.ts` | Wake dead session via agent |
| `update_settings` | `control-panel-actions.ts` | Save global settings |
| `update_project_settings` | `control-panel-actions.ts` | Save per-project settings |
| `delete_project_settings` | `control-panel-actions.ts` | Clear per-project settings |
| `update_session_order` | `control-panel-actions.ts` | Save sidebar tree order |
| `terminate_session` | `channel.ts` | Kill active session |
| `subscribe` | `channel.ts` | Dashboard subscribe |
| `channel_subscribe` | `channel.ts` | Per-session stream subscribe |
| `channel_send` | `channel.ts` | Inter-session messaging |
| `terminal_attach/data/resize` | `terminal.ts` | Terminal I/O |
| `file_*` | `files.ts` | File editor (has requestId pattern) |
| `voice_*` | `voice.ts` | Voice streaming |
| `recap_create` | `recap.ts` | Kick off a period recap (project URI or `*`) |
| `recap_cancel` | `recap.ts` | Cancel an in-flight recap |
| `recap_dismiss_failed` | `recap.ts` | Hide a failed recap card from the widget |
| `recap_list` | `recap.ts` | List recap summaries (filtered server-side by permission) |
| `recap_get` | `recap.ts` | Full recap doc (+ optional logs) |
| `recap_search_request` | `recap.ts` | FTS5 search across recaps the caller can read (MCP RPC) |
| `recap_mcp_get_request` | `recap.ts` | Recap by id, MCP-correlated via `requestId` |
| `recap_mcp_list_request` | `recap.ts` | List recaps for a project, MCP-correlated |

**Recap broadcasts** (broker -> dashboard):
- `recap_created { recapId, cached, requestId? }` -- reply to `recap_create`
- `recap_progress { recapId, status, progress, phase, log? }` -- per-phase tick
- `recap_complete { recapId, title, markdown, meta }` -- terminal success
- `recap_error { error, recapId?, requestId? }` -- terminal failure (also fires for malformed requests)
- `recap_list_result { recaps }`, `recap_get_result { recap, logs? }`
- `recap_search_result`, `recap_mcp_get_result`, `recap_mcp_list_result` (carry MCP `requestId`)

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

**Recap routes** (`src/broker/routes/recaps.ts`):
- `GET /api/recaps` - list with `?projectUri=`, `?status=`, `?limit=`. Filtered
  server-side by `chat:read` per-project; cross-project recaps are admin-only
  (per decision 19, creator-only -- conservative server-side until creator
  field flows through to summary).
- `GET /api/recaps/:id` - full PeriodRecapDoc as JSON (markdown included).
- `GET /api/recaps/:id/markdown` - text/markdown attachment, filename
  `recap-{project-slug}-{period}-{YYYY-MM-DD}.md`. Returns 409 if not done.
- `GET /api/recaps/:id/logs` - RecapLogEntry[] for debugging a job.
- `POST /api/recaps/:id/share` - mints a polymorphic share token with
  `targetKind='recap'` and **empty permissions array**. Returns
  `{ token, expiresAt, shareUrl, targetKind, targetId }`. The recap share
  grants no project access -- only the public viewer endpoint.
- `GET /api/share/recap/:token` - **PUBLIC** (token is the auth). Returns
  the recap's markdown + safe metadata (title, subtitle, period, model,
  cost, expiry). Never returns createdBy or projectUri.
- `GET /r/:token` - pretty share URL. Redirects to
  `/?share=TOKEN&kind=recap`; the SPA's share-mode then mounts
  `<PublicRecapView>` standalone (no project chrome).

**Polymorphic shares** (Phase 11): `ConversationShare.targetKind` is now
`'conversation' | 'recap'` and `targetId` is the kind-specific id. Existing
hash-form shares (`/#/share/TOKEN`) remain conversation kind by default.

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

**Client prefs** (`localStorage:control-panel-prefs`) - per-browser:
- Fields: `showInactiveByDefault`, `compactMode`, `showVoiceInput`
- `usePrefs()` hook, `prefs-changed` window event for sync

**Project settings** (`GET/POST/DELETE /api/settings/projects`) - per-project:
- `{cacheDir}/project-settings.json`, keyed by CWD
- Fields: `label`, `icon`, `color`, `keyterms[]`, `defaultLaunchMode`, `defaultEffort`, `defaultModel`, `trustLevel`
