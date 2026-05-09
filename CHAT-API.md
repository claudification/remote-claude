# Chat API Integration

The Chat API backend integrates any OpenAI-compatible chat completion API as a conversation backend in Claudwerk. Chat API conversations appear in the control panel sidebar alongside Claude Code sessions.

## Architecture

```
User (Control Panel) --> Broker --> Chat API (/v1/chat/completions)
                           |
                           +--> MCP Client --> Broker /mcp endpoint
```

**v1 (this implementation):** The broker proxies user messages to the Chat API directly via HTTP/SSE. No sentinel, no subprocess - just API calls.

**v2 (future):** Gateway connects to the broker via WebSocket using a platform adapter plugin. Enables proactive features like cron scheduling and multi-platform delivery.

## Setup

### 1. Register a Chat Connection

Open the command palette (Cmd+P) and type `> Manage chat connections`.

Add a connection:
- **Name:** Display name (e.g. "Personal", "Work")
- **URL:** OpenAI-compatible API endpoint (e.g. `http://localhost:8642`)
- **API Key:** Your API key for the endpoint
- **Model:** (Optional) Default model for this connection

Use the "test" button to verify the connection.

### 2. Start a Chat Conversation

Open the spawn dialog (Cmd+G, L) and select the "Chat" backend toggle. Pick your registered connection, give the conversation a name, and spawn.

Chat API conversations appear in the sidebar like any other conversation. They support rename, categories, and all existing decoration features.

## How It Works

### Conversation Proxy

When a user sends input to a Chat API conversation:

1. The broker looks up the linked connection via `chatConnectionId` on the conversation metadata
2. Rebuilds conversation history from the transcript cache
3. POSTs to the connection's `/v1/chat/completions` endpoint with the full message history
4. Streams the SSE response back, accumulating the full text
5. Adds the assistant response as a transcript entry
6. Reports token usage from the response

The Chat API backend is stateless from the broker's perspective - the broker manages all conversation history.

### Project URIs

Chat API conversations use `chat://{connectionName}` as their project URI:
- Each registered connection becomes a project in the sidebar
- Multiple conversations with the same connection are grouped under that project
- Project links, settings, and grouping work the same as Claude Code projects

### Spawn Bypass

When `backend: 'chat-api'` in a spawn request:
- The sentinel is bypassed entirely (no process to spawn)
- The conversation is created immediately with `status: 'active'`
- `agentHostType` is set to `'chat-api'`
- `chatConnectionId` is stored in the conversation's `agentHostMeta`

## MCP Server Endpoint

The broker exposes Claudwerk tools at `/mcp` via Streamable HTTP MCP. This allows any MCP client to call Claudwerk capabilities.

### Authentication

Bearer token in the Authorization header. Use the same `RCLAUDE_SECRET` or a dedicated MCP secret.

### Available Tools

| Tool | Description |
|------|-------------|
| `notify` | Push notification to user's devices |
| `search_transcripts` | FTS5 search across all conversations |
| `get_transcript_context` | Sliding window around a transcript entry |
| `send_message` | Inter-conversation messaging |
| `spawn_session` | Spawn a new conversation (Claude or Chat API) |
| `list_conversations` | List active conversations |
| `project_list` | List project board tasks |
| `project_set_status` | Move tasks between columns |

## Plugin Files (Phase 2)

The `hermes-plugin/` directory contains the gateway adapter for Phase 2 (Hermes-specific):

- `PLUGIN.yaml` - Plugin metadata and required env vars
- `adapter.py` - WebSocket adapter connecting Hermes gateway to the broker

## REST API

### Connection Registry

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/chat/connections` | List all registered connections |
| POST | `/api/chat/connections` | Create a new connection |
| PUT | `/api/chat/connections/:id` | Update a connection |
| DELETE | `/api/chat/connections/:id` | Delete a connection |
| POST | `/api/chat/connections/:id/test` | Test connection |

### Conversation Proxy

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/chat/conversations/:id/chat` | Send message to Chat API |

## Troubleshooting

**"Chat API connection not found"** - The `chatConnectionId` on the conversation doesn't match any registered connection. Re-register the connection or check its ID.

**"Chat API error: 401"** - The API key is wrong. Update it in Manage chat connections.

**"Chat API request failed: fetch failed"** - Can't reach the API. Check that the server is running and the URL is correct.

**No Chat toggle in spawn dialog** - No connections are registered. Add one via Cmd+P > Manage chat connections first.
