# Managed Workers (Sub-Wrappers)

**Status:** Design phase - gathering requirements\
**Depends on:** Rendezvous protocol (ddd18b0), multi-host agent plan

## The Vision

```
Parent session (J++)
  ├─ Worker: "researcher" (researching API docs)     ● active
  ├─ Worker: "coder" (implementing feature)           ● active
  └─ Worker: "reviewer" (idle, lived agent)           ○ idle
```

The concentrator (or parent wrapper) can spawn lightweight Claude Code sessions
as managed workers. Each worker has a name, role, system prompt, and a controlled
lifetime. Workers communicate with their parent via channels and signal when done.

## Key Properties

- **Named roles**: Each worker has a human-visible name/role ("researcher", "coder")
- **System prompt**: Workers receive a task-specific prompt on launch
- **Channel-based comms**: Workers listen for messages over MCP channel, not PTY
- **Lifecycle control**: Parent or concentrator can kill workers, workers can signal "done"
- **Lived agents**: Workers can persist beyond their initial task (stay idle, available for reuse)
- **Dashboard visibility**: Workers show in sidebar under parent session with role labels

## Prior Art

### CC Native Subagents (Agent tool)

CC's built-in `Agent` tool spawns subagents that run **in-process** (same `claude` PID).
Tracked via `SubagentStart`/`SubagentStop` hooks with `agentId`, `agentType`, `description`.
rclaude watches their per-agent JSONL files (`{sessionDir}/subagents/agent-{agentId}.jsonl`).

**Key insight:** These are NOT separate OS processes. They share the parent's context
window and block the parent while running. The `description` field is harvested from
the preceding `PreToolUse(Agent)` event. Max 50 concurrent subagent watchers in wrapper.

**Limitations for our use case:**
- In-process only (no independent lifecycle)
- Parent blocks while subagent runs
- No persistent/lived agents
- No separate filesystem or CWD

### CC Native Teams

CC's team system spawns **separate processes** as tmux panes via `PaneBackendExecutor`.
Communication is file-based inbox polling (`~/.claude/teams/{team}/inboxes/{uuid}.json`).

- Team-lead/teammate hierarchy (lead can set modes, approve plans, kill panes)
- `SendMessage` tool writes to teammate's inbox file
- `InboxPoller` delivers when target session is idle
- `TeammateIdle` hook fires when a teammate finishes its turn
- rclaude observes teams passively (hooks only, no `--teammate-mode` flag)

**What we can reuse:**
- Lead/teammate hierarchy maps to parent/worker model
- `TeammateInfo` tracking in session-store already exists
- BUT: inbox IPC is local-only and file-based - our WS channels are superior

### rclaude Spawn Infrastructure (what exists)

**Rendezvous protocol** (ddd18b0): spawn and await callback when session connects.
Exactly the pattern workers need.

**Agent spawn flow** (`revive-session.sh`): spawns rclaude in tmux with env vars.
Workers would use the same path.

**`pty-spawn.ts`**: Uses `Bun.spawn` with PTY. Currently assumes single interactive
terminal owner (stdin passthrough). For headless workers, would need `terminal: false`
or detached mode. NOT needed if workers go through tmux (which is simpler).

**No headless spawn path exists** - all rclaude sessions assume a PTY. Workers
spawned via tmux get a PTY automatically (tmux provides one). This is fine.

### Gap Analysis

| What exists | Reusable? |
|---|---|
| Rendezvous (`spawn_ready` callback) | Yes - exact pattern |
| Agent tmux spawn flow | Yes - workers are just sessions with extra env |
| Inter-session messaging | Yes - workers message parent via channels |
| SubagentInfo tracking | Extend - add `parentSessionId` to Session model |
| Subagent transcript watching | Yes - TranscriptWatcher is generic |
| TeammateInfo tracking | Informational only - passive observation |

| What's missing | Needed |
|---|---|
| Parent-child relationship on Session model | `parentSessionId`, `workerName`, `workerRole` |
| Worker lifecycle hooks (done signal) | `worker_done` intent in inter-session messaging |
| Auto-linking workers to parent | Skip approval step for worker <-> parent |
| Sidebar grouping by parent | Dashboard tree view of workers under parent |
| Worker-specific system prompt injection | `--append-system-prompt` with task + role |
| `.rclaude-spawn` marker bypass for workers | Workers inherit parent's spawn approval |

## Architecture

### Worker Spawn Flow

```
Parent session (or dashboard) requests worker spawn
  │
  ├─ Concentrator: POST /api/workers/spawn
  │   { parentSessionId, name, role, prompt, cwd, lived?: boolean }
  │
  ├─ Concentrator -> Agent: spawn rclaude with worker config
  │   RCLAUDE_WORKER_MODE=1
  │   RCLAUDE_WORKER_NAME=researcher
  │   RCLAUDE_WORKER_PARENT=<parentSessionId>
  │   RCLAUDE_WORKER_PROMPT="Research the Stripe API..."
  │
  ├─ Worker rclaude starts, connects to concentrator
  │   SessionMeta includes: { workerMode: true, parentSessionId, workerName }
  │
  ├─ Rendezvous fires -> parent notified: "Worker 'researcher' ready"
  │
  └─ Worker receives initial prompt via channel, starts working
```

### Worker-Parent Communication

```
Parent -> Worker:  via inter-session channel (mcp__rclaude__send_message)
Worker -> Parent:  via inter-session channel (mcp__rclaude__send_message)
Worker -> Parent:  "done" signal (special message intent: 'worker_done')
```

Workers are auto-linked to parent (no dashboard approval needed).
Parent has implicit authority over workers (kill, send messages).

### Worker Lifecycle States

```
spawning -> active -> done -> (killed | idle)
                       │           │
                       │           └─ lived=true: stays idle, reusable
                       └─ lived=false: auto-killed after done signal
```

### Dashboard Visualization

Workers show in the sidebar grouped under their parent session:

```
┌─────────────────────────────────────┐
│ > remote-claude          ● active   │
│     ├─ researcher        ● active   │
│     ├─ coder             ● active   │
│     └─ reviewer          ○ idle     │
│                                     │
│ > growing-generations    ○ idle     │
│     └─ db-migrator       ● active   │
└─────────────────────────────────────┘
```

Each worker is clickable - shows its own transcript, events, tasks.
Worker transcripts show the initial prompt and all communication.

### Worker Session Properties

```typescript
interface WorkerMeta {
  isWorker: boolean
  parentSessionId: string
  workerName: string
  workerRole?: string         // "researcher", "coder", "reviewer", etc.
  workerPrompt?: string       // initial task prompt
  lived: boolean              // persist after done?
  spawnedAt: number
  doneAt?: number             // when worker signaled done
}
```

Stored on the Session object, sent in SessionMeta on connect.

## API

### Spawn Worker

```
POST /api/workers/spawn
{
  parentSessionId: string     // who owns this worker
  name: string                // "researcher", "coder"
  role?: string               // optional role description
  prompt: string              // initial task/system prompt
  cwd?: string                // defaults to parent's cwd
  lived?: boolean             // persist after done (default: false)
  model?: string              // override model (default: parent's model)
}
-> { workerId: string, wrapperId: string }
   + rendezvous callback when worker connects
```

### List Workers

```
GET /api/workers?parentSessionId=xxx
[
  { id, name, role, status, cwd, spawnedAt, doneAt, lived }
]
```

### Kill Worker

```
DELETE /api/workers/:id
-> sends SIGTERM to worker process
```

### Worker Done Signal

Worker sends via MCP channel:
```
mcp__rclaude__send_message({
  to: parentSessionId,
  intent: 'worker_done',
  message: "Research complete. Found 3 relevant API endpoints..."
})
```

Concentrator intercepts `worker_done` intent:
- Sets `doneAt` on worker session
- If `lived: false` -> auto-kill after brief delay
- If `lived: true` -> set status to idle, keep alive

## MCP Tool for Parent Sessions

New MCP tool available to sessions:

```
spawn_worker({
  name: "researcher",
  prompt: "Research the Stripe API payment intents...",
  lived: false
})
-> awaits rendezvous
-> returns: { workerId, status: "ready", session: {...} }
```

## Implementation Notes

### What to Reuse

- **Rendezvous protocol**: Already built, works for spawn/revive callbacks
- **Agent spawn flow**: `revive-session.sh` / `rclaude-boot.sh` already handle tmux spawning
- **Inter-session messaging**: Workers use existing `send_message` for parent comms
- **Session tracking**: Workers are sessions with extra metadata
- **Dashboard session list**: Workers group under parent using `parentSessionId`

### What's New

- Worker-specific env vars (`RCLAUDE_WORKER_*`)
- Worker system prompt injection (via `--append-system-prompt`)
- Auto-linking workers to parent (skip dashboard approval)
- `worker_done` intent handling in concentrator
- Sidebar grouping by parent session
- Worker spawn MCP tool

### Open Questions

1. **Worker model selection**: Should workers default to a cheaper model (Haiku/Sonnet)
   for mechanical tasks? Or inherit parent's model?

2. **Worker CWD**: Same as parent? Different? Git worktree isolation?

3. **Worker limits**: Max workers per parent? Per concentrator? Memory/resource bounds?

4. **Worker persistence across restarts**: If concentrator restarts, do lived workers
   survive? They're tmux sessions so they'd keep running, but the concentrator would
   need to re-discover them.

5. **Worker-to-worker communication**: Can workers message each other, or only
   parent <-> worker? Start with parent-only, extend later.

6. **Dashboard worker management**: Spawn/kill workers from dashboard UI, not just
   MCP tools? Command palette: `W: @researcher "find the API docs"`?
