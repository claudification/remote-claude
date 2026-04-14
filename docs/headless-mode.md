# Headless Mode & MCP Channel

## Headless Mode (stream-json backend)

`rclaude --headless` or `RCLAUDE_HEADLESS=1` uses Claude's `--print` mode with
structured NDJSON I/O instead of PTY. Default for agent-spawned sessions.

**Protocol reference:** `docs/stream-json-protocol.md` (879 lines, reverse-engineered)

```
rclaude --headless
  -> spawns: claude --print --output-format stream-json --input-format stream-json
             --include-partial-messages --permission-prompt-tool stdio
  -> stdin:  NDJSON user messages, control_request (set_model, interrupt), control_response (permissions)
  -> stdout: NDJSON system/init, assistant, user, stream_event, result, rate_limit_event, control_request
```

**Headless vs PTY tradeoffs:**

| Headless gives | PTY gives |
|---|---|
| Token-by-token streaming | Web terminal |
| Exact cost per turn (`total_cost_usd`) | Clipboard capture (OSC 52) |
| Rate limit status and reset times | |
| Dynamic model switching (`set_model`) | |
| Turn interruption (`interrupt`) | |
| Full session metadata in init | |
| Slash command autocomplete data | |

**Permission flow:** `--permission-prompt-tool stdio` sends `control_request` with
`subtype: "can_use_tool"` for sensitive writes. Wrapper checks auto-approve rules
(rclaude.json + built-in rules), then auto-approves or forwards to dashboard.

**Streaming:** CC sends `stream_event` with `content_block_delta`/`text_delta`.
Wrapper unwraps and forwards as `stream_delta` WS messages.

**Subagent routing:** Entries with non-null `parent_tool_use_id` route to subagent
transcript via `onSubagentEntry`. Wrapper maps `toolUseId -> agentId` from `task_started`.

**Edit diffs:** CC puts `structuredPatch`, `oldString`, `newString` on `tool_use_result`.
Stream backend copies to camelCase `toolUseResult`. Wrapper's `augmentEditPatches` caches
Edit inputs from assistant entries and computes patches for results.

**AskUserQuestion (headless only):** `can_use_tool` with `tool_name: "AskUserQuestion"` ->
wrapper intercepts -> `ask_question` WS -> dashboard shows banners -> user answers ->
`control_response` with `{behavior: "allow", updatedInput: {questions, answers}}`.

**Plan Mode (headless only):** Via `can_use_tool` control_request flow.
- EnterPlanMode: wrapper checks `allowPlanMode` config, auto-approves, broadcasts `plan_mode_changed`
- ExitPlanMode: wrapper reads plan from `~/.claude/plans/` (most recent `.md`), forwards as
  `plan_approval` WS. Dashboard renders in DialogModal. Auto-approves if WS disconnected.
- Config: `allowPlanMode` in `.rclaude/rclaude.json` (default: true). `RCLAUDE_NO_PLAN_MODE=1` for agents.
- CC writes plan to `~/.claude/plans/{slug}.md` before firing -- plan NOT in `can_use_tool` input.

**Env vars:**
- `RCLAUDE_HEADLESS=1` - enable headless mode
- `RCLAUDE_SHOW_TRANSCRIPT=1` - dump raw NDJSON to stderr
- `RCLAUDE_SHOW_TRANSCRIPT_PRETTY=1` - colorized indented JSON to stderr
- `RCLAUDE_SHOW_WEBSOCKET_MESSAGES=1` - log all WS traffic

**Files:** `src/wrapper/stream-backend.ts`, `docs/stream-json-protocol.md`

## MCP Channel

When started with `--channels` (default ON), rclaude becomes an MCP Streamable HTTP
server. Disable with `--no-channels` or `RCLAUDE_CHANNELS=0`.

```
Dashboard input -> concentrator WS -> rclaude -> MCP notification
  -> Claude sees <channel source="rclaude">message</channel>
```

Requires `--dangerously-load-development-channels server:rclaude` (auto-confirmed).
MCP config: `.claude/.rclaude/mcp-{id}.json`.

**MCP tools:** `notify`, `share_file`, `list_sessions`, `send_message`,
`toggle_plan_mode`, `tasks`, `set_task_status`, `dialog` -- always available
regardless of channel state.

**CC limitation (2.1.83+):** `AskUserQuestion` and plan mode disabled when channels
active. Headless mode does NOT use channels, so these tools work there.

## Transport Abstraction

**HIGH-LEVEL FUNCTION -> HIGH-LEVEL CALLBACK -> RCLAUDE RESOLVES TRANSPORT**

MCP tool handlers MUST NEVER call transport-specific functions directly. Call
high-level callbacks (e.g. `onDeliverMessage`), `index.ts` wires to correct transport:

- **PTY+channel**: `pushChannelMessage`
- **Headless**: `streamProc.sendUserMessage` (stdin `<channel>` tag)

MCP channel module declares needs via `McpChannelCallbacks`, `index.ts` fulfills.
Headless has no MCP channel connection -- `pushChannelMessage` silently drops messages.
