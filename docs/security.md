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
- Share: `shareToGrants(share)` -> synthetic `UserGrant[]`

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

File operations validated against session CWD in the **wrapper**, not concentrator
(concentrator is OS-agnostic Linux Docker).

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
