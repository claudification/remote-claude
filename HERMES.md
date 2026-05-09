# Hermes Integration

Hermes Agent (by Nous Research) integrates as a conversation backend in Claudwerk. Hermes conversations appear in the control panel sidebar alongside Claude Code sessions.

## Architecture

```
User (Control Panel) --> Broker --> Hermes API (/v1/chat/completions)
                           |
                           +--> Hermes MCP Client --> Broker /mcp endpoint
```

**v1 (this implementation):** The broker proxies user messages to the Hermes API directly via HTTP/SSE. No sentinel, no subprocess - just API calls.

**v2 (future):** Hermes gateway connects to the broker via WebSocket using a platform adapter plugin. Enables proactive features like cron scheduling and multi-platform delivery.

## Setup

### 1. Run Hermes in Docker

```bash
docker run -d \
  --name hermes \
  -v ~/.hermes:/opt/data \
  -p 8642:8642 \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  -e API_SERVER_ENABLED=true \
  -e API_SERVER_HOST=0.0.0.0 \
  -e API_SERVER_KEY="${HERMES_API_KEY}" \
  nousresearch/hermes-agent gateway run
```

### 2. Register a Hermes Agent

Open the command palette (Cmd+P) and type `> Manage Hermes agents`.

Add an agent:
- **Name:** Display name (e.g. "Personal", "Work")
- **URL:** Hermes API endpoint (e.g. `http://hermes:8642` or `http://localhost:8642`)
- **API Key:** The `API_SERVER_KEY` value from your Docker config
- **Model:** (Optional) Default model for this agent
- **Icon:** (Optional) Emoji for sidebar display
- **Color:** (Optional) Hex color for sidebar badge

Use the "test" button to verify the connection.

### 3. Start a Hermes Conversation

Open the spawn dialog (Cmd+G, L) and select the "Hermes" backend toggle. Pick your registered agent, give the conversation a name, and spawn.

Hermes conversations appear in the sidebar like any other conversation. They support rename, categories, and all existing decoration features.

## How It Works

### Conversation Proxy

When a user sends input to a Hermes conversation:

1. The broker looks up the linked Hermes agent via `hermesAgentId` on the conversation metadata
2. Rebuilds conversation history from the transcript cache
3. POSTs to the agent's `/v1/chat/completions` endpoint with the full message history
4. Streams the SSE response back, accumulating the full text
5. Adds the assistant response as a transcript entry
6. Reports token usage from the response

Hermes is stateless from the broker's perspective - the broker manages all conversation history.

### Project URIs

Hermes conversations use `hermes://{agentName}` as their project URI:
- Each registered Hermes agent becomes a project in the sidebar
- Multiple conversations with the same agent are grouped under that project
- Project links, settings, and grouping work the same as Claude Code projects

### Spawn Bypass

When `backend: 'hermes'` in a spawn request:
- The sentinel is bypassed entirely (no process to spawn)
- The conversation is created immediately with `status: 'active'`
- `agentHostType` is set to `'hermes'`
- `hermesAgentId` is stored in the conversation's `agentHostMeta`

## MCP Server Endpoint

The broker exposes Claudwerk tools at `/mcp` via Streamable HTTP MCP. This allows Hermes (or any MCP client) to call Claudwerk capabilities.

### Authentication

Bearer token in the Authorization header. Use the same `RCLAUDE_SECRET` or a dedicated MCP secret.

### Available Tools

| Tool | Description |
|------|-------------|
| `notify` | Push notification to user's devices |
| `search_transcripts` | FTS5 search across all conversations |
| `get_transcript_context` | Sliding window around a transcript entry |
| `send_message` | Inter-conversation messaging |
| `spawn_session` | Spawn a new conversation (Claude or Hermes) |
| `list_conversations` | List active conversations |
| `project_list` | List project board tasks |
| `project_set_status` | Move tasks between columns |

### Hermes MCP Config

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  claudwerk:
    url: "https://concentrator.frst.dev/mcp"
    headers:
      Authorization: "Bearer ${CLAUDWERK_MCP_SECRET}"
```

After restart, Hermes sees tools as `mcp_claudwerk_notify`, `mcp_claudwerk_spawn_session`, etc.

## Plugin Files (Phase 2)

The `hermes-plugin/` directory contains the gateway adapter for Phase 2:

- `PLUGIN.yaml` - Plugin metadata and required env vars
- `adapter.py` - WebSocket adapter connecting Hermes gateway to the broker

### Installation

```bash
cp -r hermes-plugin/ ~/.hermes/plugins/claudwerk/
```

Add env vars to the Hermes Docker container:
```
CLAUDWERK_BROKER_URL=wss://concentrator.frst.dev/ws
CLAUDWERK_ADAPTER_SECRET=${RCLAUDE_SECRET}
CLAUDWERK_DEFAULT_PROJECT=hermes://personal
```

Restart the gateway. The adapter connects to the broker and registers as an `agentHostType: 'hermes'` agent host.

## REST API

### Agent Registry

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/hermes/agents` | List all registered agents |
| POST | `/api/hermes/agents` | Create a new agent |
| PUT | `/api/hermes/agents/:id` | Update an agent |
| DELETE | `/api/hermes/agents/:id` | Delete an agent |
| POST | `/api/hermes/agents/:id/test` | Test connection |

### Conversation Proxy

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/hermes/conversations/:id/chat` | Send message to Hermes |

## Troubleshooting

**"Hermes agent not found"** - The `hermesAgentId` on the conversation doesn't match any registered agent. Re-register the agent or check its ID.

**"Hermes API error: 401"** - The API key is wrong. Update it in Manage Hermes Agents.

**"Hermes request failed: fetch failed"** - Can't reach the Hermes API. Check that the Docker container is running and the URL is correct. If running in Docker, use the container name (e.g., `http://hermes:8642`) not `localhost`.

**No Hermes toggle in spawn dialog** - No agents are registered. Add one via Cmd+P > Manage Hermes agents first.

**MCP tools not showing in Hermes** - Check `~/.hermes/config.yaml` has the `claudwerk` MCP server configured. Restart the Hermes gateway after changes.
