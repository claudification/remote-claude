# Session Lifecycle

## Identity Model

| Identity | Stability | Use for |
|---|---|---|
| **Address book slug** | Permanent (persisted) | Routing -- `list_sessions` ID, `send_message` target |
| **Wrapper ID** | Process lifetime (survives `/clear`) | Internal -- socket routing, terminal attachment |
| **Session ID** | Ephemeral (changes on `/clear`) | Context -- transcripts, tasks, conversation history |
| **CWD** | Permanent | Linking -- trust relationships, address book keys |

- **Address book slugs** are the external addressing mechanism. Human-readable,
  per-caller scoped, persisted on concentrator. Leaked slugs useless to other sessions.
- **Session IDs are short-lived.** Never cache them for later use.
- **Runtime links are CWD-based.** Links survive `/clear`, restarts, without migration.

### Address Book (`address-book.ts`)
Per-caller routing table. `callerCwd -> { slug -> targetCwd }`. Auto-generated slugs.
Persisted to `{cacheDir}/address-books.json`.

### Message Queue (`message-queue.ts`)
Messages to offline sessions queued by target CWD. 24h TTL, 100 max per target.
Auto-drained on connect. `send_message` returns `"delivered"` or `"queued"`.

## Session Status State Machine

```
starting -> active -> idle -> active -> ... -> ended
   |                    |                         ^
   +--------------------+-------------------------+
```

| Status | Trigger | Visual |
|---|---|---|
| `starting` | rclaude connected, no hooks yet | pulsing yellow dot |
| `active` | non-passive hook fired | spinning green |
| `idle` | Stop/StopFailure hook | static yellow dot |
| `ended` | disconnect or SessionEnd | gray badge |

**Passive hooks** (don't activate): Stop, StopFailure, SessionStart, SessionEnd,
Notification, TeammateIdle, TaskCompleted, InstructionsLoaded, ConfigChange, Setup,
Elicitation, ElicitationResult.

**Active hooks**: UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure,
SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest.

## Session Organization

Tree structure with drag-and-drop in sidebar. Storage: `{cacheDir}/session-order.json` (v2 format).

**Layout:** Organized tree -> Unorganized (active, not in tree) -> Inactive (collapsed).

**DnD (via @dnd-kit):** Reorder within/between groups, reparent, pin/unpin, create groups.
- ALL dnd props (ref, attributes, listeners) on SAME element
- `MouseSensor` (8px) + `TouchSensor` (300ms) -- not `PointerSensor`
- `<button>` blocks drag -- use `<div onClick>` in sortable contexts

**Session persistence:** `{cacheDir}/sessions.json`, debounced writes. Ended sessions
24h eviction TTL. Dismissed = removed immediately.

## Spawn Boot

`scripts/rclaude-boot.sh` -- tries `--continue` first (resume). If fails within 5s,
starts fresh. If ran longer then exited, does NOT fall through (prevents duplicates).

**Resolution priority:**
- Spawn root: `--spawn-root` > `$RCLAUDE_SPAWN_ROOT` > `$HOME`
- Launch mode: explicit param > project `defaultLaunchMode` > headless (default)
- Model: project `defaultModel` > global `defaultModel` > unset
- Effort: project `defaultEffort` > global > unset

**Autocompact:** Spawn dialog slider (50-99%) -> `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env.
Dashboard shows threshold-aware context bar colors (amber at -5%, red at threshold).

## Tmux Spawn Environment

Spawned sessions MUST use `$SHELL -li -c "command"` for full user environment.
`-l` alone misses `.zshrc`. `-i` required for zinit, FNM_DIR, API keys.
