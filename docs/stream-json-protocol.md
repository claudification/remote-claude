# Claude Code Stream-JSON Protocol Reference

> Reverse-engineered from CC v2.1.96 source code (`cli.js`, function `qK7`, class `ffA`, function `EK7`).\
> Confirmed with live tests. Not an official Anthropic document.\
> Last updated: 2026-04-08

## Overview

Stream-JSON is Claude Code's structured I/O protocol for non-interactive (headless) usage.
Instead of spawning a PTY with colored terminal output, CC reads NDJSON on stdin and writes
NDJSON on stdout. Every line is a self-contained JSON object with a `type` field.

The protocol is **asymmetric** - the set of message types you can send on stdin is different
from what CC emits on stdout. Notably, you cannot inject tool results from the outside; tool
execution is fully internal to CC.

**Primary use cases:**

- SDK integration (TypeScript/Python Agent SDK)
- CI/CD pipelines wanting structured output
- Headless agent sessions without terminal interaction
- Programmatic multi-turn conversations

## Quick Start

Minimal single-turn example:

```bash
echo '{"type":"user","session_id":"","message":{"role":"user","content":"Say hello"},"parent_tool_use_id":null}' \
  | claude --print \
    --input-format stream-json \
    --output-format stream-json \
    --no-session-persistence \
    --model haiku
```

Output (one JSON object per line):

```jsonc
{"type":"system","subtype":"init","session_id":"...","cwd":"...","model":"...","tools":[...],...}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}],...}}
{"type":"result","subtype":"success","total_cost_usd":0.001,"duration_ms":1234,...}
```

## CLI Flags

| Flag | Description |
|------|-------------|
| `--print` / `-p` | **Required.** Non-interactive mode. Reads from stdin, prints to stdout, exits. Skips workspace trust dialog |
| `--output-format stream-json` | Emit NDJSON on stdout with full message lifecycle. Implicitly enables `--verbose` |
| `--output-format json` | Single JSON blob at end with all messages (alternative to streaming) |
| `--input-format stream-json` | Accept structured NDJSON on stdin for multi-turn conversations |
| `--include-partial-messages` | Add `stream_event` entries with raw Anthropic API SSE deltas (token-by-token streaming) |
| `--include-hook-events` | Include `system` entries for hook lifecycle (`hook_started`, `hook_response`) |
| `--replay-user-messages` | Echo user messages back on stdout for acknowledgment. Requires both input AND output = `stream-json` |
| `--session-id <uuid>` | Set explicit session UUID. Must be a valid UUID. Cannot combine with `--continue`/`--resume` unless `--fork-session` is also set |
| `--resume <id>` | Resume session by ID. Works with `--print` - subsequent calls retrieve context from prior calls |
| `--continue` / `-c` | Resume most recent conversation in current directory |
| `--fork-session` | When resuming, create a new session ID instead of reusing the original |
| `--no-session-persistence` | Don't save session to disk. Only valid with `--print` |
| `--name <name>` | Display name for session (shown in `/resume` and terminal title) |
| `--brief` | Enables the `SendUserMessage` tool for agent-to-user communication. NOT about output brevity |
| `--bare` | Skip hooks, LSP, plugins, auto-memory, CLAUDE.md discovery. Sets `CLAUDE_CODE_SIMPLE=1`. Minimal mode |
| `--max-budget-usd <amount>` | Spending cap per invocation. Only valid with `--print` |
| `--max-turns` | Cap on agentic turns (hidden flag) |
| `--model <model>` | Model to use (e.g. `haiku`, `sonnet`, `opus`) |
| `--permission-prompt-tool` | MCP-based permission handling (alternative to `control_request`/`control_response`) |

**Session persistence pattern for multi-turn:**

```bash
# First call - establish session
echo '...' | claude --print --input-format stream-json --output-format stream-json \
  --session-id "550e8400-e29b-41d4-a716-446655440000"

# Subsequent calls - resume with context
echo '...' | claude --print --input-format stream-json --output-format stream-json \
  --resume "550e8400-e29b-41d4-a716-446655440000"
```

---

## Input Protocol (stdin)

Wire format: NDJSON (newline-delimited JSON). Each line is a complete JSON object.

### User Messages

Send a user prompt to CC.

```json
{
  "type": "user",
  "session_id": "",
  "message": {
    "role": "user",
    "content": "Your prompt here"
  },
  "parent_tool_use_id": null,
  "uuid": "msg_optional_dedup_id"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"user"` | Yes | Must be exactly `"user"`. Any other value (except control types) is **fatal** |
| `session_id` | `string` | Yes | Can be empty string `""`. CC manages session ID internally via CLI flags. This field is passthrough metadata for the output stream - it is NOT used for routing |
| `message.role` | `"user"` | Yes | Must be exactly `"user"`. Mismatched role is **fatal** (`process.exit(1)`) |
| `message.content` | `string \| ContentBlock[]` | Yes | Plain string or array of Anthropic API content blocks |
| `parent_tool_use_id` | `null \| string` | Yes | Always `null` for input messages. Non-null values are passthrough metadata used in output for grouping subagent messages |
| `uuid` | `string` | No | Deduplication ID. If set, CC checks persistent + in-memory stores and silently skips already-processed UUIDs. Enables at-least-once delivery on reconnect |

#### Content Block Types

When `message.content` is an array, it accepts standard Anthropic Messages API `ContentBlockParam` types:

**Text block:**
```json
{"type": "text", "text": "Your prompt text"}
```

**Base64 image block:**
```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "iVBORw0KGgo..."
  }
}
```

**URL image block:**
```json
{
  "type": "image",
  "source": {
    "type": "url",
    "url": "https://example.com/image.png"
  }
}
```

CC does NOT validate content block structure at the stdin parsing layer - it passes `message.content`
directly to the agent loop and then to the API. Invalid blocks cause an API error, not a CC
parsing error.

#### The `uuid` Field

Provides three capabilities:

1. **Deduplication** - Same UUID won't be processed twice. Survives reconnects via persistent storage + in-memory set
2. **Replay acknowledgment** - With `--replay-user-messages`, CC echoes already-processed messages back with `isReplay: true`
3. **Prompt correlation** - UUID is passed through to the agent loop as `promptUuid` and attached to output messages

#### Multi-Turn Conversations

You can send multiple user messages on stdin. CC processes them sequentially, one turn at a time.

```bash
printf '%s\n%s\n' \
  '{"type":"user","session_id":"","message":{"role":"user","content":"remember BANANA"},"parent_tool_use_id":null}' \
  '{"type":"user","session_id":"","message":{"role":"user","content":"what word did I say?"},"parent_tool_use_id":null}' \
  | claude --print --input-format stream-json --output-format stream-json --model haiku
```

Each user message is pushed to an internal `queuedCommands` list. The main loop pulls one
prompt at a time. When a turn finishes (tool loop complete, response emitted), the loop
checks for the next queued command.

**stdin EOF behavior:** Closing stdin is NOT immediate termination. CC sets `inputClosed = true`
and rejects any pending permission requests, but continues processing queued commands. The
process exits only when the agent loop is not running AND no more commands are queued.

You can either:
- Send all messages upfront, close stdin, and CC processes them all
- Keep stdin open and send messages as they arrive - CC processes them one turn at a time

---

### Control Messages

#### `initialize` (SDK Handshake)

Sent BEFORE any user messages. CC responds with capabilities metadata. Can only be sent **once** -
a second `initialize` gets `{subtype: "error", error: "Already initialized"}`.

**Request:**
```json
{
  "type": "control_request",
  "request_id": "unique-uuid",
  "request": {
    "subtype": "initialize",
    "systemPrompt": "Custom system prompt",
    "appendSystemPrompt": "Additional instructions appended to default prompt",
    "agents": [],
    "hooks": {
      "PreToolUse": [{"callbackId": "hook1", "timeout": 30000}]
    },
    "jsonSchema": {},
    "sdkMcpServers": ["server-name"]
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subtype` | `"initialize"` | Yes | Handshake identifier |
| `systemPrompt` | `string` | No | Override the system prompt entirely |
| `appendSystemPrompt` | `string` | No | Append to the default system prompt |
| `agents` | `array` | No | Register custom agent definitions |
| `hooks` | `object` | No | Register hook callbacks with callback IDs and timeouts |
| `jsonSchema` | `object` | No | Set structured output schema |
| `sdkMcpServers` | `string[]` | No | Register SDK-managed MCP servers |

**Response (CC -> stdout):**
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "unique-uuid",
    "response": {
      "commands": [
        {"name": "/help", "description": "Show help", "argumentHint": ""}
      ],
      "output_style": "concise",
      "available_output_styles": ["concise", "verbose"],
      "models": [
        {"value": "claude-sonnet-4-20250514", "displayName": "Sonnet", "description": "..."}
      ],
      "account": {
        "email": "user@example.com",
        "organization": "Org Name",
        "subscriptionType": "pro",
        "tokenSource": "oauth",
        "apiKeySource": null
      }
    }
  }
}
```

#### `control_response` (Permission Answers)

When CC sends a `control_request` on stdout (e.g., asking for tool permission), you respond
with `control_response` on stdin.

**Envelope:**
```json
{
  "type": "control_response",
  "response": {
    "request_id": "<uuid-from-the-request>",
    "subtype": "can_use_tool",
    "response": { ... }
  }
}
```

**Allow variant:**
```json
{
  "type": "control_response",
  "response": {
    "request_id": "abc-123",
    "subtype": "can_use_tool",
    "response": {
      "behavior": "allow",
      "updatedInput": {},
      "updatedPermissions": [],
      "toolUseID": "toolu_xxx"
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `behavior` | `"allow"` | Yes | Grant permission |
| `updatedInput` | `Record<string, unknown>` | Yes | Replaces tool input parameters. Pass `{}` to keep original input unchanged |
| `updatedPermissions` | `PermissionRule[]` | No | Permission rule mutations (the "ALWAYS allow" mechanism) |
| `toolUseID` | `string` | No | Tool use ID reference |

**Deny variant:**
```json
{
  "type": "control_response",
  "response": {
    "request_id": "abc-123",
    "subtype": "can_use_tool",
    "response": {
      "behavior": "deny",
      "message": "Reason for denial",
      "interrupt": false,
      "toolUseID": "toolu_xxx"
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `behavior` | `"deny"` | Yes | Deny permission |
| `message` | `string` | No | Human-readable denial reason |
| `interrupt` | `boolean` | No | If `true`, aborts the entire turn via `abortController.abort()`. Hard-cancel from outside |
| `toolUseID` | `string` | No | Tool use ID reference |

**Error variant:**
```json
{
  "type": "control_response",
  "response": {
    "request_id": "abc-123",
    "subtype": "error",
    "error": "Human-readable error message"
  }
}
```

The pending request's Promise is rejected with the error message. The handler typically
falls back to deny behavior.

**Permission rule types (`updatedPermissions` array):**

| Type | Fields | Effect |
|------|--------|--------|
| `addRules` | `rules: [{toolName, ruleContent?}]`, `behavior: allow/deny/ask`, `destination` | Add permission rules |
| `replaceRules` | Same as `addRules` | Replace existing rules |
| `removeRules` | Same as `addRules` | Remove rules |
| `setMode` | `mode`, `destination` | Change permission mode |
| `addDirectories` | `directories: string[]`, `destination` | Add allowed directories |
| `removeDirectories` | `directories: string[]`, `destination` | Remove allowed directories |

Where `destination` is one of: `userSettings`, `projectSettings`, `localSettings`, `session`, `cliArg`.

**`hook_callback` response (for hook lifecycle events):**

Either async acknowledgment:
```json
{"async": true, "asyncTimeout": 30000}
```

Or synchronous result:
```json
{
  "continue": true,
  "suppressOutput": false,
  "stopReason": "...",
  "decision": "approve|block",
  "reason": "...",
  "systemMessage": "...",
  "hookSpecificOutput": {"hookEventName": "PreToolUse"}
}
```

All fields optional. `hookSpecificOutput` is event-specific: PreToolUse gets
`permissionDecision`/`updatedInput`, UserPromptSubmit gets `additionalContext`, etc.

#### Other Control Request Subtypes (stdin -> CC)

These are sent as `control_request` messages with `request_id`:

| Subtype | Purpose | Response |
|---------|---------|----------|
| `interrupt` | Abort the current turn (calls `abortController.abort()`) | Success ack |
| `set_permission_mode` | Change permission mode (e.g., `bypassPermissions`) | Success with new mode |
| `set_model` | Change active model mid-session (`"default"` resets to original) | Success ack |
| `set_max_thinking_tokens` | Change thinking budget (`null` to clear) | Success ack |
| `mcp_status` | Query MCP server connection status | List of servers with status |
| `mcp_message` | Forward raw MCP protocol message to a named server | MCP response |
| `mcp_set_servers` | Hot-reload MCP server configuration (add/remove/update) | Added/removed/errors |
| `rewind_files` | Revert file changes to a specific user message checkpoint | Success or error |

**Example - interrupt:**
```json
{
  "type": "control_request",
  "request_id": "int-001",
  "request": {
    "subtype": "interrupt"
  }
}
```

**Example - change model:**
```json
{
  "type": "control_request",
  "request_id": "mdl-001",
  "request": {
    "subtype": "set_model",
    "model": "claude-sonnet-4-20250514"
  }
}
```

#### `keep_alive`

Heartbeat message. Silently consumed by CC - returns nothing.

```json
{"type": "keep_alive"}
```

No other fields. Used by both directions (stdin heartbeat to keep pipe alive,
stdout heartbeat from WebSocket transport).

---

### Error Handling (Input)

The stdin parser is strict and unforgiving. Most errors are **fatal** (`process.exit(1)`).

| Condition | Behavior |
|-----------|----------|
| Malformed JSON (parse error) | **FATAL** - `process.exit(1)` |
| Unknown `type` (not `user`, `control_*`, `keep_alive`) | **FATAL** - `process.exit(1)` |
| `type: "user"` with `message.role` != `"user"` | **FATAL** - `process.exit(1)` |
| `type: "control_request"` without `request` field | **FATAL** - `process.exit(1)` |
| Unmatched `control_response` (no pending request for `request_id`) | Handled gracefully - queued as orphaned permission or silently dropped |
| `control_response` with `subtype: "error"` | Handled gracefully - pending request Promise rejected |
| stdin close while requests pending | All pending permission requests rejected with error |

---

## Output Protocol (stdout)

All output is NDJSON. Each line has a `type` field.

### System Messages

#### `init` (Session Metadata)

Emitted once at the start. Contains everything about the session.

```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "cwd": "/Users/jonas/projects/myapp",
  "model": "claude-sonnet-4-20250514",
  "permissionMode": "default",
  "claude_code_version": "2.1.96",
  "tools": [
    {"name": "Read", "description": "..."},
    {"name": "Write", "description": "..."},
    {"name": "Bash", "description": "..."},
    {"name": "mcp__server__tool", "description": "..."}
  ],
  "mcp_servers": [
    {"name": "rclaude", "status": "connected"}
  ],
  "agents": [],
  "skills": [
    {"name": "/help", "description": "..."}
  ],
  "plugins": [],
  "fast_mode_state": {}
}
```

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | CC's internal session UUID |
| `cwd` | `string` | Working directory |
| `model` | `string` | Active model string |
| `tools` | `array` | Full list of available tools (including MCP tools) |
| `mcp_servers` | `array` | MCP server names + connection status |
| `permissionMode` | `string` | Current permission mode |
| `claude_code_version` | `string` | CC version string |
| `agents` | `array` | Available agent definitions |
| `skills` | `array` | Available skills/slash commands |
| `plugins` | `array` | Loaded plugins with paths |
| `fast_mode_state` | `object` | Effort level state |

#### `hook_started` / `hook_response`

Only emitted with `--include-hook-events`. Shows hook lifecycle but NOT the hook's input data.

```json
{"type": "system", "subtype": "hook_started", "hook_event": "SessionStart"}
{"type": "system", "subtype": "hook_response", "hook_event": "SessionStart", "exit_code": 0, "stdout": "", "stderr": ""}
```

**Important:** These events only show hook name, event type, and execution result (exit_code,
stdout, stderr). They do NOT contain the hook's input data (e.g., `tool_input` for PreToolUse).
For full hook data, you still need a separate hook HTTP receiver.

#### Other System Subtypes

| Subtype | Description |
|---------|-------------|
| `api_retry` | API call being retried (rate limit, transient error) |
| `status` | Status update (e.g., "Thinking...") |
| `compact_boundary` | Context compaction occurred |
| `informational` | Informational message (warnings, notices) |

---

### Assistant Messages

Full assistant response with content blocks.

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      {"type": "text", "text": "Here is my response."}
    ],
    "model": "claude-sonnet-4-20250514",
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 567,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 800,
      "speed": "standard"
    },
    "stop_reason": "end_turn"
  },
  "parent_tool_use_id": null
}
```

**Tool use in assistant messages:**
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_01ABC123",
        "name": "Read",
        "input": {
          "file_path": "/Users/jonas/projects/myapp/src/index.ts"
        }
      }
    ]
  },
  "parent_tool_use_id": null
}
```

The `parent_tool_use_id` field is `null` for top-level messages. Non-null values indicate
subagent messages (child of a tool execution context) - these are excluded from top-level
conversation history but still emitted on stdout for observation.

The `usage.speed` field maps to effort levels: `fast` = low, `standard` = medium, `extended` = high.

---

### User Messages (Echo)

Tool results emitted by CC after internal tool execution. Also appears when `--replay-user-messages` is active.

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01ABC123",
        "content": "file contents here..."
      }
    ]
  },
  "parent_tool_use_id": null
}
```

These appear in the output stream to show the complete tool use lifecycle:

1. `assistant` message with `tool_use` content block (CC wants to use a tool)
2. `user` message with `tool_result` content block (CC executed the tool internally)
3. `assistant` message with response text (CC processes the result)

With `--replay-user-messages`, user prompts are echoed back with an `isReplay` flag for
already-processed UUIDs.

---

### Stream Events (Partial Messages)

Only emitted with `--include-partial-messages`. These are raw Anthropic API SSE deltas
wrapped in a `stream_event` envelope. Enables token-by-token streaming.

**Message lifecycle:**

```json
{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[],"model":"..."}}}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hey"}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there!"}}}
{"type":"stream_event","event":{"type":"content_block_stop","index":0}}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}}
{"type":"stream_event","event":{"type":"message_stop"}}
```

| Event Type | Description |
|------------|-------------|
| `message_start` | New assistant message beginning. Contains role, model, empty content array |
| `content_block_start` | New content block starting at `index`. Contains initial block structure |
| `content_block_delta` | Incremental content update at `index`. `delta.type` is `text_delta` for text |
| `content_block_stop` | Content block at `index` is complete |
| `message_delta` | Message-level update (e.g., `stop_reason`, usage stats) |
| `message_stop` | Message is fully complete |

These follow the standard Anthropic Messages API streaming format.

---

### Control Requests (CC -> stdout)

CC sends these when it needs input from the controlling process.

#### `can_use_tool` (Permission Prompt)

```json
{
  "type": "control_request",
  "request_id": "perm-001",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "Bash",
    "tool_input": {
      "command": "rm -rf /tmp/test"
    }
  }
}
```

Respond with a `control_response` on stdin (see Input Protocol section).

#### `hook_callback`

Hook lifecycle event requiring a response.

```json
{
  "type": "control_request",
  "request_id": "hook-001",
  "request": {
    "subtype": "hook_callback",
    "hook_event": "PreToolUse",
    "callback_id": "registered-callback-id"
  }
}
```

#### `mcp_message`

MCP protocol message forwarded from a connected MCP server.

```json
{
  "type": "control_request",
  "request_id": "mcp-001",
  "request": {
    "subtype": "mcp_message",
    "server_name": "rclaude",
    "message": { ... }
  }
}
```

#### `control_cancel_request`

CC cancels a previously-sent `control_request` (e.g., aborting a permission prompt because
the turn was interrupted).

```json
{
  "type": "control_cancel_request",
  "request_id": "perm-001"
}
```

When the agent's `abortController` fires (e.g., an `interrupt` control_request was received),
any pending permission requests are automatically cancelled via `control_cancel_request` on stdout.

---

### Result Message

Final message emitted when a turn completes. Always the last message in a turn's output.

```json
{
  "type": "result",
  "subtype": "success",
  "total_cost_usd": 0.0234,
  "duration_ms": 4567,
  "duration_api_ms": 3200,
  "num_turns": 3,
  "stop_reason": "end_turn",
  "terminal_reason": "completed",
  "usage": {
    "input_tokens": 5000,
    "output_tokens": 1200,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 3500
  },
  "modelUsage": {
    "claude-sonnet-4-20250514": {
      "input_tokens": 5000,
      "output_tokens": 1200
    }
  },
  "permission_denials": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `subtype` | `string` | Result type (see table below) |
| `total_cost_usd` | `number` | Total API cost for this turn |
| `duration_ms` | `number` | Wall-clock duration |
| `duration_api_ms` | `number` | Time spent in API calls |
| `num_turns` | `number` | Number of agentic turns (tool use cycles) |
| `stop_reason` | `string` | API-level stop reason (`end_turn`, `stop_sequence`, etc.) |
| `terminal_reason` | `string` | Why the turn ended (`completed`, `max_turns`, `budget_exceeded`, etc.) |
| `usage` | `object` | Detailed token breakdown with cache stats |
| `modelUsage` | `object` | Per-model usage breakdown |
| `permission_denials` | `array` | List of denied permissions during this turn |

**Result subtypes:**

| Subtype | Meaning |
|---------|---------|
| `success` | Turn completed normally |
| `error_max_turns` | Hit the max turns limit |
| `error_budget` | Budget cap exceeded |
| `error_api` | API error (rate limit, auth failure, etc.) |
| `error_tool` | Tool execution error |
| `error_interrupted` | Turn was interrupted (via `interrupt` control request) |

---

### Rate Limit Events

```json
{
  "type": "rate_limit_event",
  "retry_after_ms": 5000,
  "message": "Rate limited. Retrying in 5s."
}
```

Emitted when the API returns a rate limit response. CC handles retries automatically - this
is informational for observers.

---

## Complete Message Lifecycle

A typical tool-using turn produces this sequence:

```
init (once, session start)
  hook_started: SessionStart          (with --include-hook-events)
  hook_response: SessionStart         (with --include-hook-events)

Turn 1:
  hook_started: UserPromptSubmit      (with --include-hook-events)
  hook_response: UserPromptSubmit     (with --include-hook-events)
  stream_event: message_start         (with --include-partial-messages)
  stream_event: content_block_start   (with --include-partial-messages)
  stream_event: content_block_delta   (with --include-partial-messages, repeated)
  stream_event: content_block_stop    (with --include-partial-messages)
  stream_event: message_delta         (with --include-partial-messages)
  stream_event: message_stop          (with --include-partial-messages)
  assistant (tool_use: Read)
  control_request (can_use_tool)      --> you respond with control_response
  user (tool_result)
  stream_event: ...                   (with --include-partial-messages)
  assistant (text response)
  hook_started: Stop                  (with --include-hook-events)
  hook_response: Stop                 (with --include-hook-events)
  rate_limit_event                    (if rate limited during turn)
  result (success)
```

---

## Limitations

### No Tool Result Injection

The protocol is asymmetric. You cannot send `tool_result` messages on stdin. Tool execution
is fully internal:

1. CC emits `tool_use` on stdout (observation only)
2. CC sends `control_request` with `can_use_tool` on stdout (permission)
3. You respond with `control_response` on stdin (allow/deny)
4. CC executes the tool internally
5. CC emits `tool_result` on stdout (observation only)

The only way to influence tool execution from outside is through `updatedInput` in the
permission response, which can modify tool parameters before execution.

### No PTY Features

Stream-JSON mode has no pseudo-terminal. You lose:

- Web terminal (no PTY to attach to)
- Clipboard capture (no OSC 52 sequences)
- Interactive terminal features (no keystroke injection, Ctrl+C, resize)
- Colored/formatted terminal output

### Fatal Error Handling

Most input errors are fatal with no recovery:

- Malformed JSON on stdin = `process.exit(1)`
- Unknown message type on stdin = `process.exit(1)`
- Wrong `message.role` on stdin = `process.exit(1)`

There is no error recovery mechanism. The process dies and you must restart.

### No Queue Operations / User Interjections Mid-Turn

In PTY mode, users can interject while Claude is working (queue operations). In stream-JSON
mode, user messages queue up and are processed sequentially - you cannot interrupt a running
turn with a new prompt. Use the `interrupt` control request to abort the current turn first.

### Subagent Visibility

Subagent messages (entries with non-null `parent_tool_use_id`) ARE emitted on stdout but are
marked as child messages. They are excluded from top-level conversation history. Full subagent
tool_use/tool_result lifecycle is visible in the stream.

---

## Source References

| Resource | URL / Path |
|----------|------------|
| CC source (minified) | `cli.js` in the `@anthropic-ai/claude-code` npm package |
| Key functions | `qK7` (prompt wrapper), `ffA` (stdin transport), `EK7` (main stream loop), `we2` (agent loop) |
| Zod schemas | `tD1` (can_use_tool response), `HD1` (hook_callback response), `VD1` (permission rules) |
| GitHub issue (protocol discussion) | https://github.com/anthropics/claude-code/issues/24594 |
| Agent SDK streaming docs | https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode |

---

## Protocol Summary Tables

### stdin Message Types

| Type | Subtypes | Fatal on Error | Description |
|------|----------|----------------|-------------|
| `user` | - | Yes (bad role) | Send user prompt |
| `control_request` | `initialize`, `interrupt`, `set_permission_mode`, `set_model`, `set_max_thinking_tokens`, `mcp_status`, `mcp_message`, `mcp_set_servers`, `rewind_files` | Yes (missing `request`) | SDK control commands |
| `control_response` | `can_use_tool`, `hook_callback`, `error` | No (unmatched = callback) | Answer CC's control requests |
| `keep_alive` | - | No (silently consumed) | Heartbeat |
| Any other type | - | **YES - process.exit(1)** | - |
| Malformed JSON | - | **YES - process.exit(1)** | - |

### stdout Message Types

| Type | Subtypes/Variants | Description |
|------|-------------------|-------------|
| `system` | `init`, `hook_started`, `hook_response`, `api_retry`, `status`, `compact_boundary`, `informational` | System events and metadata |
| `assistant` | Text content, tool_use content | Model responses and tool requests |
| `user` | tool_result content, replayed prompts | Internal tool results, echoed user messages |
| `stream_event` | `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop` | Anthropic API SSE deltas (with `--include-partial-messages`) |
| `control_request` | `can_use_tool`, `hook_callback`, `mcp_message` | Permission prompts, hook lifecycle, MCP messages |
| `control_cancel_request` | - | Cancel a pending control request |
| `result` | `success`, `error_max_turns`, `error_budget`, `error_api`, `error_tool`, `error_interrupted` | Turn completion with cost/usage stats |
| `rate_limit_event` | - | Rate limit notification |
