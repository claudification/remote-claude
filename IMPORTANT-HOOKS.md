# Claude Code Hook System - Complete Reference

Everything rclaude knows about Claude Code's hook system, session lifecycle,
transcript management, and the quirks that'll bite you at 3am.

## Hook Events (All 21)

| Hook Event | When It Fires | Key Data Fields |
|---|---|---|
| `SessionStart` | Session begins (also after compaction, `/clear`) | `session_id`, `cwd`, `model`, `source`, `transcript_path`* |
| `UserPromptSubmit` | User sends a prompt | `session_id`, `prompt` |
| `PreToolUse` | Before each tool call | `session_id`, `tool_name`, `tool_input` |
| `PostToolUse` | After tool call succeeds | `session_id`, `tool_name`, `tool_input`, `tool_response` |
| `PostToolUseFailure` | After tool call fails | `session_id`, `tool_name`, `tool_input`, `error` |
| `Notification` | Claude wants user attention | `session_id`, `message`, `notification_type` |
| `Stop` | Claude finishes a turn | `session_id`, `reason`, `stop_hook_reason` |
| `SessionEnd` | Session terminates | `session_id`, `reason` |
| `SubagentStart` | Subagent spawned | `session_id`, `agent_id`, `agent_type` |
| `SubagentStop` | Subagent finished | `session_id`, `agent_id`, `agent_type`, `transcript`, `agent_transcript_path` |
| `PreCompact` | Context compression starting | `session_id`, `trigger` |
| `PostCompact` | Context compression finished (CC 2.1.76+) | `session_id` |
| `PermissionRequest` | Tool needs user approval | `session_id`, `tool`, `suggestions[]` |
| `TeammateIdle` | Teammate finished a task | `session_id`, `agent_id`, `agent_name`, `team_name` |
| `TaskCompleted` | Team task done | `session_id`, `task_id`, `task_subject`, `owner`, `team_name` |
| `InstructionsLoaded` | CLAUDE.md loaded | `session_id` |
| `ConfigChange` | Settings changed | `session_id` |
| `WorktreeCreate` | Git worktree created | `session_id` |
| `WorktreeRemove` | Git worktree removed | `session_id` |
| `Elicitation` | MCP server requests user input (CC 2.1.76+) | `session_id` |
| `ElicitationResult` | User responds to MCP elicitation (CC 2.1.76+) | `session_id` |

\* `transcript_path` is NOT in the TypeScript interface -- accessed via cast to `Record<string, unknown>`.

## Event Ordering

### Normal Session Lifecycle

```
SessionStart -> UserPromptSubmit -> PreToolUse -> PostToolUse -> ... -> Stop
                    ^                                                     |
                    └─────────────── (next turn) ─────────────────────────┘
```

Final: `SessionEnd` when the session terminates.

### Compaction Sequence

```
PreCompact
  │
  ├── Claude rewrites the JSONL file (truncates + new content)
  │   Transcript watcher detects size < offset, resets to 0
  │
  ├── PostCompact (CC 2.1.76+, definitive completion signal)
  │
  └── SessionStart (same session_id, fresh context)
```

**CC 2.1.76+:** `PostCompact` fires after compaction completes. This is
the definitive signal. rclaude uses it as the primary trigger for clearing
`compacting` state and injecting the `compacted` transcript marker.

**CC < 2.1.76 fallback:** `SessionStart` after `PreCompact` also clears
the compacting state. Both paths produce the same result.

### `/clear` Sequence

```
/clear command
  │
  └── SessionStart (NEW session_id, different from before)
       rclaude detects ID change -> sends session_clear
       Concentrator rekeys session maps, resets ephemeral state
       Dashboard follows via previousSessionId in session_update
```

### Subagent Sequence

```
PreToolUse (tool_name=Agent, tool_input.description captured)
  │
  └── SubagentStart (agent_id, agent_type) -- pops description from queue
       │
       ├── Progress entries appear in PARENT transcript (data.agentId field)
       ├── Separate .jsonl file created for agent transcript
       │
       └── SubagentStop (agent_id, agent_transcript_path)
            Complete standalone JSONL now available
```

### Team/Teammate Sequence

```
TeammateIdle (agent_id, agent_name, team_name) -- identifies membership
  │
  ├── SubagentStart for teammate -> status becomes 'working'
  ├── SubagentStop for teammate -> status becomes 'stopped'
  └── TaskCompleted -> completedTaskCount++, status back to 'idle'
```

## Message Queue (queue-operation Transcript Entries)

When the user types while Claude is busy, messages are queued in-memory and
written to the JSONL as `queue-operation` entries. This is NOT part of the
hook system -- it's a transcript-only mechanism.

### Operations (from decompiled CC 2.1.76 source)

| Operation | Mechanism | When | Has `content`? |
|-----------|-----------|------|----------------|
| `enqueue` | Push to queue (priority `next` for user msgs, `later` for task notifications) | User types or task notification arrives | Yes |
| `popAll` | Drain all "editable" items, concatenate into next user turn | Start of new turn after Claude finishes | Yes (echoes text) |
| `dequeue` | Single priority-based pop | Between turns, or task notification consumed | No |
| `remove` | Predicate-based splice | Mid-turn consumption (Claude processes interject while still working) | No |

### Queue Lifecycle

```
User types while Claude is busy
  │
  ├── enqueue (content: "user's message")
  │
  ├── Claude finishes current work
  │   │
  │   ├── Single message queued:
  │   │     remove (mid-turn) or dequeue (between turns)
  │   │
  │   └── Multiple messages queued:
  │         popAll (drains all, concatenates into one prompt)
  │
  └── /clear while messages queued:
        popAll (bulk drain, messages discarded)
```

### "Editable" vs "Non-Editable" Items

Claude Code distinguishes between:
- **Editable** = user-typed messages (consumed by `popAll`)
- **Non-editable** = `<task-notification>` entries (consumed by `dequeue`, skip `popAll`)

Task notifications are enqueued with priority `later` and dequeued almost
instantly (~8ms). They bypass the normal user message queue path.

### rclaude Handling

- `enqueue` with content -> synthesized as user display group with `queued: true`
- `dequeue`/`remove` -> clear `queued` flag on oldest queued group (FIFO)
- `popAll` -> clear `queued` flag on ALL queued groups
- Queued groups float at the bottom of the transcript as a sticky footer
- When consumed, they snap to their chronological position in the transcript

### Statistical Patterns (from real sessions)

- `enqueue` -> `remove`: seconds to minutes gap (Claude was busy)
- `enqueue` -> `dequeue`: <1s gap (Claude was idle or just finished)
- Multiple `enqueue` -> single `popAll` per item: bulk drain at turn boundary

## Session IDs -- Three Different Things

| ID | Source | Lifetime | Purpose |
|---|---|---|---|
| `internalId` | `randomUUID()` at rclaude start | Entire wrapper process | Local server validation, settings file naming, PTY routing |
| `claudeSessionId` | `data.session_id` from SessionStart | Until `/clear` or restart | Canonical identity for concentrator, transcript path |
| `data.session_id` in hooks | Each hook payload | Per-event | Parent session = `claudeSessionId`; subagent hooks = subagent's own ID |

**Flow:**
1. rclaude boots -> generates `internalId` -> starts local HTTP server
2. Spawns Claude CLI with `--settings` flag
3. First `SessionStart` -> extracts `data.session_id` -> becomes `claudeSessionId`
4. Opens WS to concentrator using `claudeSessionId`
5. On `/clear`: new `SessionStart` with different `session_id` -> rekey

**Subagent hooks carry the subagent's session_id, not the parent's.** The
concentrator correlates by checking `hookSessionId !== session.id`.

## Transcript File Management

### Path Discovery

`SessionStart` data contains `transcript_path` (undocumented field).
Path format: `~/.claude/projects/{hash}/sessions/{session_id}.jsonl`

### Watcher Mechanics (transcript-watcher.ts)

- Uses `node:fs/promises` `open()` + `chokidar` for change notifications
- Byte-offset tracking, partial line accumulation
- `awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 }`
- Mutex-protected reads (`reading` flag + `pendingRead` coalescing)

### Compaction Detection

```typescript
if (size < offset) {
    // File truncated/compacted -- Claude rewrote the JSONL
    offset = 0
    partial = ''
    entryCount = 0
    isInitial = true  // re-read as initial batch
}
```

### Caps

- Initial read: max 500 entries sent (last 500 if more)
- Concentrator ring buffer: 500 entries per session (`MAX_TRANSCRIPT_ENTRIES`)
- On WS reconnect: `transcriptWatcher.resend()` re-reads entire file from 0

### Subagent Transcript Files

- Path: `{sessionDir}/subagents/agent-{agentId}.jsonl`
- Derived by stripping `.jsonl` from parent path, appending `/subagents/agent-{agentId}.jsonl`
- File may not exist when `SubagentStart` fires -- rclaude retries after 500ms

### Live Subagent Data (Two Sources!)

1. **Parent transcript** -- entries with `agentId`/`data.agentId` field (progress updates)
2. **Separate JSONL file** -- complete agent transcript (available after stop, or live-watched)

Both can produce entries. Dashboard/concentrator must handle potential duplicates.

## Task & Background Task Tracking

### Task Files

- Location: `~/.claude/tasks/{session_id}/*.json`
- rclaude watches BOTH `claudeSessionId` AND `internalId` dirs (they may differ)
- Chokidar glob watchers + 5-second poll fallback (dir may be created lazily)
- Format: `{ id, subject, description?, status, blockedBy?, blocks?, owner?, updatedAt }`
- Statuses: `pending`, `in_progress`, `completed`, `deleted`
- Deduped via JSON.stringify comparison -- only sends `tasks_update` when changed
- On `/clear` (session ID change): task watcher stops and restarts with new dirs

### Background Tasks

Detected from `PostToolUse` where `tool_name === 'Bash'`:
- ID from `tool_response.backgroundTaskId` (object) or regex `with ID: (\S+)` (string)
- Completion from `PostToolUse` with `tool_name === 'TaskOutput'` or `'TaskStop'`
- Also from `<task-notification>` XML in user transcript entries

**Output streaming:** rclaude scans for output file path (`Output is being written to: {path}`),
polls the `.output` file every 500ms, streams chunks via `bg_task_output` WS messages.
Stops on completion or after 10s of file-not-found (20 retries).

## Hook Forwarding

### Settings Merge (Primary Mechanism)

`settings-merge.ts` reads user's `~/.claude/settings.json`, injects hook matchers
for supported events (filtered by detected Claude Code version), writes to
`/tmp/rclaude-settings-{internalId}.json`.
Claude CLI spawned with `--settings {path}`.

Each hook fires a curl command:
```bash
curl -s -X POST "http://127.0.0.1:{port}/hook/{hookEvent}" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: {sessionId}" \
  -d @-
```

**Why `type: 'command'` with curl instead of `type: 'http'`?**
HTTP hooks don't fire for SessionStart in Claude Code 2.1.71. The command
workaround applies to ALL events for consistency.

rclaude hooks are PREPENDED to user's hook arrays (fire first).

### Local HTTP Server

- Random port in 19000-19999
- `POST /hook/{eventType}` -- validates `X-Session-Id`, parses JSON, calls `onHookEvent`
- `GET /health` -- health check
- Events queued in `eventQueue[]` if WS not ready, flushed on connect

### forwarder.sh (Legacy)

`src/hooks/forwarder.sh` -- standalone version using `RCLAUDE_PORT` and
`RCLAUDE_SESSION_ID` env vars. Always exits 0 to not block Claude.

## Known Quirks & Gotchas

### 1. PostCompact Hook (CC 2.1.76+)
`PostCompact` was added in CC 2.1.76. rclaude uses it as the primary signal
to clear compacting state. Fallback: `SessionStart` after `PreCompact` (older CC).

### 2. First SessionStart May Have Non-Existent Transcript
The `--settings` injection can cause a SessionStart before the JSONL file exists.
rclaude guards with `existsSync(transcriptPath)`.

### 3. `/clear` Changes Session ID
A new `SessionStart` fires with a different `session_id`. The concentrator
rekeys the session. All ephemeral state (events, subagents, tasks, teammates,
transcript cache) is reset.

### 4. Subagent Description Correlation Is Queue-Based
`PreToolUse(Agent)` fires before `SubagentStart` as separate events.
Descriptions go into a FIFO queue per session. `SubagentStart` pops from front.
If a `PreToolUse(Agent)` fires without corresponding `SubagentStart`, the queue
gets stale.

### 5. `tool_response` Can Be String OR Object
PostToolUse's `tool_response` is typed as `string?` but background bash tasks
return an object with `backgroundTaskId`. Normalize: if object, `JSON.stringify`;
if string, use as-is.

### 6. Heartbeats Don't Count as Activity
Concentrator explicitly ignores heartbeats for `lastActivity` tracking.
Only hook events and transcript entries reset it.

### 7. Stale Agents Auto-Cleaned After 10 Minutes
If `SubagentStop` is missed (crash, etc.), running agents are marked stopped
after 10 minutes of session inactivity.

### 8. Session Resume Resets Everything
When a session reconnects, all subagents cleared, teammates cleared,
compacting flag reset, running bg tasks marked as killed.

### 9. Token Usage Extracted from Transcript
The concentrator parses assistant message entries for `message.usage` fields.
Each assistant message adds to cumulative totals. Latest `tokenUsage` stored
as current context window size.

### 10. Two Session IDs for Task Directories
Claude's internal session ID differs from rclaude's `internalId`. Task files
could be under either `~/.claude/tasks/{claudeSessionId}/` or
`~/.claude/tasks/{internalId}/`. rclaude watches both.
