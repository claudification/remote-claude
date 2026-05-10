# Security

## Permission Enforcement

**EVERY function exposed to the internet MUST have a permission check.**
No exceptions. No "I'll add it later." No "it's just a read."

**DATA FILTERING IS ALWAYS SERVER-SIDE. NEVER CLIENT-SIDE.**
Client-side filtering is defense-in-depth only -- the server is the authority.

### The Rules

1. **HTTP endpoints**: `httpHasPermission(req, permission, cwd)` or `httpIsAdmin(req)`.
2. **WS handlers**: `ctx.requirePermission(permission, cwd)` (throws `GuardError`).
   Always resolve CWD from session store -- NEVER trust client-supplied CWD.
3. **Broadcasts**: `broadcastSessionScoped(msg, cwd)` for ALL session-scoped data.
   Unscoped `broadcast()` ONLY for global messages (settings_updated, sentinel_status).
4. **Share viewers**: `?share=TOKEN` -> synthetic grants scoped to one CWD.
5. **New endpoints/handlers**: Permission check is the FIRST thing. Most restrictive if unsure.

### Grant Resolution

- `resolveHttpGrants(req)` -> `null` (admin/bearer) or `UserGrant[]` (users/shares)
- `httpHasPermission(req, permission, cwd)` -> resolves grants, checks permission for CWD
- `httpIsAdmin(req)` -> true only for bearer secret auth
- WS: `ctx.requirePermission(permission, cwd)` checks `ws.data.grants`
- Share: `shareToGrants(share)` -> synthetic `UserGrant[]` (uses canonical
  `scope` field, not `legacyCwd`)

## WS Role Gating (message router)

Independent of per-project permissions, the broker classifies every WS
connection by **role** at the message router boundary:

| Role            | Set by                                                   | Allowed message types                          |
| --------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `agent-host`    | bearer auth with `RCLAUDE_SECRET` (no other role marker) | `meta`, `hook`, `conversation_*`, transcript emit, etc. |
| `control-panel` | passkey cookie / `userName` set                          | `subscribe`, `send_input`, dashboard actions   |
| `sentinel`      | `?secret=snt_...` resolves to a sentinel record          | `revive_result`, `spawn_result`, `sentinel_diag`, etc. |
| `gateway`       | `?secret=gw_...` resolves to a gateway record            | `gateway_register`, `gateway_heartbeat`        |
| `share`         | `?share=TOKEN` (link-based access)                       | `subscribe` and read-only dashboard actions (further filtered by share grants) |

`detectRole()` in `src/broker/message-router.ts` derives the role from
`WsData` fields. Each handler registers with an explicit allowlist
(`AGENT_HOST_ONLY`, `DASHBOARD_ROLES`, `SENTINEL_ONLY`, `GATEWAY_ONLY`,
or `ANY_ROLE`). The router rejects messages whose caller's role isn't in
the set with a `_result` reply (`ok: false, error: "Forbidden ..."`).

**Defense in depth:** per-handler `requirePermission()` calls remain.
The role gate ensures only the right *kind* of actor can send a message;
the permission gate ensures the actor has the right project access.

**Adding a new message type:**

1. Define the type in `src/shared/protocol.ts`
2. In the handler's `register*Handlers()` function, declare the role
   allowlist via the second arg to `registerHandlers()`:
   ```ts
   registerHandlers({ my_message: handler }, AGENT_HOST_ONLY)
   ```
3. If the message is bidirectional, register it twice with the
   correct sets, or use `ANY_ROLE` and branch in the handler

**Why this matters:** before this gate, a passkey-authenticated dashboard
user could send agent-host-only messages (`conversation_reset`,
`update_conversation_metadata`, `terminal_error`, etc.) to any
conversation, bypassing the per-handler permission checks (which were
no-ops for non-control-panel connections). See
`.claude/docs/SECURITY-AUDIT.md` C3/H3/H4/H5/H7.

## Session Shares

Link-based temporary access. Token in URL hash (`/#/share/TOKEN`).
Storage: `{cacheDir}/shares.json`. 30-day max, auto-expire.

- WS auth: `?share=TOKEN` query param on upgrade -> synthetic grants
- Same token works for HTTP via `?share=` query param
- `shares_updated` WS broadcast to admin subscribers on changes
- Default permissions: transcript-only (chat:read). Optional: chat, files, terminal
- Components: `shares.ts`, `share-panel.tsx`, `shared-session-view.tsx`, `share-mode.ts`

## Shell Injection in Spawn Pipeline

**The sentinel is the trust boundary.** User-controllable strings flowing through
the spawn pipeline MUST be sanitized at the sentinel level.

**Why:** `revive-session.sh` embeds env vars into `CMD_PREFIX` nested through
`tmux -> /bin/sh -c -> /bin/zsh -li -c "..."`. Quotes/backticks/`$` break quoting.

**Sanitization:** `shellSafe()` in `src/sentinel/index.ts` strips `'"\\`$`.
Shell script also strips as defense-in-depth.

**What to sanitize:** `CLAUDWERK_CONVERSATION_NAME`, `RCLAUDE_WORKTREE` -- any string
from dashboard input that ends up in `CMD_PREFIX`. When adding new spawn env vars
from user input, apply `shellSafe()` in the sentinel.

## Path Guard

File operations validated against session CWD in the **agent host**, not the broker
(broker is OS-agnostic Linux Docker).

```ts
// src/shared/path-guard.ts
isPathWithinCwd(filePath, cwd)  // resolves relative paths, blocks ../ traversal
```

## Permission Auto-Approve (.claude/rclaude.json)

Per-project allowlist for Write/Edit/Read auto-approval:

```json
{
  "$schema": "https://raw.githubusercontent.com/claudification/claudewerk/main/schemas/rclaude.schema.json",
  "permissions": {
    "Write": { "allow": [".claude/docs/**", ".claude/notes/**"] },
    "Edit":  { "allow": [".claude/docs/**", ".claude/notes/**"] }
  }
}
```

- Only Write, Edit, Read supported. Other tools use ALWAYS button (session-scoped).
- Built-in rules: `.claude/.rclaude/tasks/**` and `.claude/.rclaude/docs/**` always auto-approved.
- ALWAYS button: session-scoped auto-approve (in-memory, dies with process).
- Glob syntax relative to project root. Paths outside CWD rejected.
