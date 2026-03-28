# Session Collaboration Plan

Inter-session messaging for rclaude. Sessions can establish mutual links,
exchange messages through the concentrator, and wake idle sessions.

**Status:** PLAN - not implemented

## Core Principles

1. **Concentrator is the gatekeeper** - all messages flow through it, never direct
2. **Mutual consent** - both sessions must accept before any messages flow
3. **Instant sever** - one click in dashboard, atomic, no race conditions
4. **No MCP required** - uses PTY input injection + local HTTP + system prompt
5. **Visible** - dashboard shows all active links, chain icons, sever buttons

## Architecture

```
Session A (rclaude)                    Concentrator                    Session B (rclaude)
     |                                      |                                |
     | curl localhost:PORT/collab/send      |                                |
     | ---------------------------------->  |                                |
     |                                      | [check link exists]            |
     |                                      | [queue message]                |
     |                                      |                                |
     |                                      | SendInput (PTY inject)         |
     |                                      | -----------------------------> |
     |                                      |   <session-message>...</>      |
     |                                      |                                |
     |                                      |   curl .../collab/reply        |
     |                                      | <---------------------------- |
     |                                      |                                |
     |  SendInput (PTY inject)              |                                |
     | <----------------------------------  |                                |
     |    <session-message>...</>           |                                |
```

## Link Lifecycle

### 1. Request (initiated from dashboard or session)

Dashboard sends WS message to concentrator:

```json
{
  "type": "collab_request",
  "fromSessionId": "abc123",
  "toSessionId": "def456",
  "reason": "Need help reviewing auth module"
}
```

Or a session can request via local HTTP:

```bash
curl -s localhost:$RCLAUDE_PORT/collab/request \
  -d '{"toSession": "GG/backend", "reason": "Need auth review help"}'
```

The `toSession` field accepts session ID, project label, or fuzzy match.
rclaude resolves it via concentrator.

### 2. Approval (dashboard only - human in the loop)

Concentrator broadcasts to dashboard:

```json
{
  "type": "collab_pending",
  "linkId": "link_001",
  "fromSessionId": "abc123",
  "fromLabel": "RCLAUDE",
  "toSessionId": "def456",
  "toLabel": "GG/backend",
  "reason": "Need help reviewing auth module"
}
```

Dashboard shows a toast/modal: "RCLAUDE wants to connect with GG/backend"
with **Accept** / **Reject** buttons.

**Critical: approval is always human-initiated from the dashboard.**
Sessions cannot auto-accept. This prevents runaway link chains.

### 3. Active Link

On approval, concentrator creates the link:

```typescript
interface CollabLink {
  id: string                    // "link_001"
  sessionA: string              // session ID
  sessionB: string              // session ID
  createdAt: number
  lastMessageAt: number
  messageCount: number
  status: 'active' | 'severed'
  maxIdleMs: number             // auto-sever after inactivity (default: 30 min)
}
```

Concentrator broadcasts `collab_linked` to both sessions (via rclaude)
and all dashboards. Both sessions receive a system-level notification
that they're now linked.

### 4. Sever (instant, atomic)

Dashboard sends:

```json
{ "type": "collab_sever", "linkId": "link_001" }
```

Concentrator immediately:
1. Sets `link.status = 'severed'`
2. Drops all queued messages
3. Broadcasts `collab_severed` to both sessions and dashboards
4. Any subsequent send attempts get rejected

**No grace period, no "last message," no handshake.** Sever is instant.

Sessions receive via PTY:

```xml
<session-link-severed partner="GG/backend" reason="User disconnected" />
```

## Message Format

### Sending (session -> concentrator)

Claude in Session A uses Bash to send:

```bash
curl -s localhost:$RCLAUDE_PORT/collab/send \
  -H 'Content-Type: application/json' \
  -d '{"message": "Can you check if token refresh is handled in the auth middleware?"}'
```

If the session has exactly one active link, `to` is implicit.
With multiple links, specify target:

```bash
curl -s localhost:$RCLAUDE_PORT/collab/send \
  -d '{"to": "GG/backend", "message": "Check token refresh please"}'
```

rclaude validates, forwards to concentrator with full session context.

### Receiving (concentrator -> session)

Concentrator injects via `SendInput` (PTY write):

```xml
<session-message from="RCLAUDE" link="link_001" at="2026-03-12T14:32:00Z">
Can you check if token refresh is handled in the auth middleware?
</session-message>
```

If session is idle, prepend a wake prompt:

```xml
<session-wake>
You have a message from a linked session. Read and respond to it.
</session-wake>

<session-message from="RCLAUDE" link="link_001" at="2026-03-12T14:32:00Z">
Can you check if token refresh is handled in the auth middleware?
</session-message>
```

If session is active (mid-turn), queue the message. Deliver when the
next `Stop` hook fires (session becomes idle).

### Replying

Claude in Session B responds naturally. The system prompt instructs it
to use `collab/send` to reply:

```bash
curl -s localhost:$RCLAUDE_PORT/collab/send \
  -d '{"message": "Yes, token refresh is handled in src/middleware/auth.ts:45-67. RefreshToken() is called automatically when the access token expires within 5 minutes."}'
```

## System Prompt Extension

When a session has active links, rclaude appends to the system prompt
via `--append-system-prompt`:

```
# Session Collaboration

You are linked with other Claude Code sessions for collaboration.
Active links: RCLAUDE (link_001)

## Receiving messages

Messages from linked sessions arrive as <session-message> XML blocks.
Read them and respond appropriately. If woken by <session-wake>, prioritize
reading and responding to the message.

## Sending messages

To send a message to a linked session:

  curl -s localhost:$RCLAUDE_PORT/collab/send \
    -d '{"message": "your message here"}'

For multiple links, specify the target:

  curl -s localhost:$RCLAUDE_PORT/collab/send \
    -d '{"to": "SESSION_LABEL", "message": "your message here"}'

## Rules

- Keep messages concise and actionable
- Include file paths and line numbers when referencing code
- Do not send code blocks larger than 200 lines (summarize instead)
- Do not attempt to execute commands on the other session's behalf
- If the link is severed (<session-link-severed>), stop sending messages
```

This prompt is **dynamically regenerated** when links are created/severed.
rclaude rewrites the system prompt file and Claude picks it up on next turn.

## Local HTTP Endpoints (rclaude)

Added to rclaude's existing local HTTP server (the one handling hook forwarding):

| Endpoint | Method | Purpose |
|---|---|---|
| `/collab/request` | POST | Request link to another session |
| `/collab/send` | POST | Send message to linked session |
| `/collab/links` | GET | List active links for this session |
| `/collab/status` | GET | Check link status |

All endpoints are localhost-only (same as hook forwarder).
rclaude forwards to concentrator over the existing WS connection.

## Concentrator State

### New protocol messages

```typescript
// Request/approval flow
CollabRequest    = { type: 'collab_request', fromSessionId, toSessionId, reason? }
CollabPending    = { type: 'collab_pending', linkId, fromSessionId, fromLabel, toSessionId, toLabel, reason? }
CollabApprove    = { type: 'collab_approve', linkId }
CollabReject     = { type: 'collab_reject', linkId }
CollabLinked     = { type: 'collab_linked', linkId, sessionA, sessionB, labelA, labelB }

// Messaging
CollabMessage    = { type: 'collab_message', linkId, fromSessionId, message, timestamp }
CollabDelivered  = { type: 'collab_delivered', linkId, messageId }

// Lifecycle
CollabSever      = { type: 'collab_sever', linkId }
CollabSevered    = { type: 'collab_severed', linkId, reason }

// Dashboard query
CollabListLinks  = { type: 'collab_list_links' }
CollabLinksState = { type: 'collab_links_state', links: CollabLink[] }
```

### Session store additions

```typescript
const collabLinks = new Map<string, CollabLink>()
const pendingRequests = new Map<string, CollabRequest>()
const messageQueue = new Map<string, CollabMessage[]>()  // sessionId -> queued msgs
```

### Persistence

Links are persisted to `{cacheDir}/collab-links.json` alongside `sessions.json`.
Saved on the same 30-second auto-save interval. On concentrator startup, links
are restored and matched against surviving sessions:

- If both sessions still exist -> link stays active
- If either session is gone (ended, no longer tracked) -> link auto-severed, cleaned up
- Message queue is NOT persisted (ephemeral) - only link state survives
- Pending requests are NOT persisted - must be re-initiated after restart

## Dashboard UI

### Session list - chain indicator

When a session has active links, show a chain icon next to the status dot:

```
  ● 🔗 RCLAUDE        <- green dot + chain = active & linked
  ○ 🔗 GG/backend     <- yellow dot + chain = idle & linked
```

Clicking the chain icon opens a popover showing:
- Linked sessions (with their status)
- Message count
- Link age
- **Sever** button (red, one-click, no confirmation)

### Session detail - collaboration panel

When viewing a linked session, show a thin bar below the tab row:

```
┌─────────────────────────────────────────────────┐
│  🔗 Linked with: GG/backend (3 messages)  [✕]  │
└─────────────────────────────────────────────────┘
```

The `[x]` severs instantly. Multiple links show as pills:

```
│  🔗 GG/backend (3)  🔗 NSF (1)  [+ Link]       │
```

### Link request toast

When a collab request arrives:

```
┌────────────────────────────────────────┐
│  🔗 RCLAUDE wants to link with        │
│     GG/backend                        │
│                                       │
│  "Need help reviewing auth module"    │
│                                       │
│  [Accept]  [Reject]                   │
└────────────────────────────────────────┘
```

### Command palette integration

`Ctrl+K > "Link with..."` - shows active sessions, select to request link.
`Ctrl+K > "Sever link..."` - shows active links, select to sever.

## Safety & Security

### Threat model

| Threat | Mitigation |
|---|---|
| Runaway message loops (A messages B, B auto-replies, loop) | Rate limit: max 10 messages per minute per link. Backoff after 5 rapid exchanges. |
| Message bomb (huge payload) | Max message size: 4KB. Reject larger. |
| Prompt injection via message | Messages are delivered as XML-tagged user input. Claude treats them as user text, not system instructions. The XML tags are descriptive, not directive. |
| Unauthorized link (session links without user knowing) | All link requests require dashboard approval. No auto-accept. |
| Stale links consuming resources | Auto-sever after 30 min of no messages (configurable). |
| Link survives after session ends | `SessionEnd` event auto-severs all links for that session. |
| Transitive access (A->B->C) | Links are point-to-point. B cannot forward A's messages to C. B can send its own message to C if B-C are linked, but A has no implicit access to C. |
| Session impersonation | Messages include verified session ID from concentrator. rclaude cannot spoof the `from` field. |
| Denial of service via link spam | Max 3 active links per session. Max 5 pending requests per session. |
| Concentrator restart | Links persisted to disk, restored on startup. Orphaned links (missing session) auto-severed. Message queue lost (acceptable). |

### Invariants

1. **No message flows without an active link in concentrator memory** - checked on every send
2. **Sever is synchronous and atomic** - after sever returns, zero messages can flow
3. **Human approves all links** - sessions can request, only dashboard can approve
4. **Messages are text-only** - no binary, no file attachments, no tool calls
5. **Rate limits are enforced at concentrator** - not at rclaude (can't be bypassed)

## Implementation Phases

### Phase 1: Core link management (concentrator)

- CollabLink data structure in session-store
- Protocol messages for request/approve/reject/sever
- WS handlers for dashboard link management
- Auto-sever on session end and idle timeout
- Rate limiting

### Phase 2: Message relay (concentrator + rclaude)

- Message queue in concentrator
- Delivery via SendInput (PTY injection)
- Wake prompt for idle sessions
- Delivery on Stop hook (for active sessions)
- Local HTTP endpoints in rclaude (/collab/*)
- System prompt generation with link context

### Phase 3: Dashboard UI

- Chain icon in session list
- Link bar in session detail
- Link request toast with accept/reject
- Sever button (no confirmation)
- Command palette: "Link with..." / "Sever link..."
- Collaboration tab showing message history

### Phase 4: Polish

- Message history viewer in dashboard (concentrator caches last N messages per link)
- Delivery receipts (seen/unseen indicator)
- Link health monitoring (detect broken PTY pipes)
- Sound/notification on incoming collab message
