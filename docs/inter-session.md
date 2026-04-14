# Inter-Session Communication

Sessions with `channel` capability discover and message each other through the concentrator.
All routing uses existing WS connections. Offline messages queued for reconnect delivery.

## MCP Tools

- `list_sessions` - discover sessions, returns address book slug as `id`
- `send_message` - send to slug (resolves via address book -> CWD -> session)

## Permission Gating

- First contact queues message, dashboard shows LINK approval banner (ALLOW/BLOCK)
- Claude NEVER sees the permission request (security)
- Block debounces 1 minute
- Allow is permanent for concentrator lifetime (not persisted across restarts)
- Links are bidirectional (approve A->B = approve B->A)
- Either side can sever via X button in session info

## Message Format

```xml
<channel source="rclaude" sender="session" from_session="abc123"
  from_project="wandershelf" intent="request" conversation_id="conv_xyz">
Can you run the integration tests?
</channel>
```

## Dashboard Display

- Sidebar: `-> project1, project2` in teal for linked sessions
- Session info: linked sessions with X sever button
- Transcript: inter-session messages decorated with `{project} [{intent}]` label
- Link requests: teal LINK banner with ALLOW/BLOCK at top of session detail
