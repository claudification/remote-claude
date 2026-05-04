# Changelog

## 2026-05-04 -- v1.0.0 / Wire Protocol v2 (BREAKING)

**This is a hard break. v1 agent hosts cannot talk to a v2 broker, and a
v2 agent host cannot talk to a v1 broker. Upgrade both sides at the same
time. Old binaries get a `protocol_upgrade_required` reply with a copy-
pastable upgrade command.**

### Wire protocol changes

- **`session` -> `conversation` everywhere** in the wire protocol. The
  identity that survives `/clear`, reconnect, and revival is a
  *conversation*, not a session. Every field carrying that id is now
  `conversationId`. The CC-internal session id is now `ccSessionId`.
- **`wrapper` -> `agent_host`** for every wire-visible name. The process
  hosting the Agent (Claude Code) is the *Agent Host*, per
  `.claude/docs/plan-fabric.md`. Renamed types: `WrapperBoot` ->
  `AgentHostBoot`, `WrapperNotify` -> `AgentHostNotify`,
  `WrapperLaunchEvent`/`Phase`/`Step` -> `AgentHostLaunchEvent`/`Phase`/`Step`,
  `WrapperRateLimit` -> `AgentHostRateLimit`. Renamed message-type
  strings: `wrapper_boot` -> `agent_host_boot`, `wrapper_started` ->
  `agent_host_started`, `wrapper_booted` -> `agent_host_booted`.
- **New `protocolVersion` field** on `meta` and `agent_host_boot`. The
  broker rejects any client below `AGENT_HOST_PROTOCOL_VERSION` (2) and
  replies with `protocol_upgrade_required` containing the install
  command. Dashboards show the rejection as a persistent toast with a
  copy-command button.

### Resilience

- New `requireString` / `requireStrings` / `requireProtocolVersion`
  helpers (`src/broker/handlers/validate.ts`). Every input-receiving
  handler validates required wire fields BEFORE touching state. Bad data
  gets a structured `[bad-data]` log warn + a typed `bad_message` reply
  to the sender naming the offending field.
- `createConversation()` now throws if called with a non-string id.
- The conversation store's loader drops null-id rows on startup (defense
  in depth against legacy persistence).
- The verbose periodic logger is wrapped in try/catch and filters bad
  rows so a single malformed conversation cannot crash the broker.
- The dashboard's Zustand entry point drops conversations with invalid
  ids before they reach renderers.

### Upgrading

```bash
bun install -g @claudewerk/agent-host @claudewerk/sentinel
```

Restart any running agent hosts and your sentinel after upgrading. The
broker auto-rejects v1 binaries on connect; restarting cleans them up.

### Background

This release was triggered by a 2026-05-04 deploy incident where a
single legacy wrapper sent a meta with `sessionId` (the v1 field name).
The broker accepted it, created an in-memory conversation keyed by
`undefined`, persisted it as a NULL-id row, and entered a 60s crash
loop. v2 closes the door at the handler boundary so a future bad-data
event gets rejected with a clear message instead of taking the broker
down.

---

## 2026-04-14

### Features
- `449da5c` Agent direct-spawns headless sessions via `Bun.spawn()` (no tmux)
  - PID registry for restart survival (`~/.rclaude/agent-sessions.json`)
  - Immediate crash detection + stderr capture as diag entries
  - Early failure detection (exit < 5s = likely hook/config issue)
  - `SpawnFailed` protocol message for async crash reporting
  - SIGTERM/SIGINT: unref children, persist registry, clean exit
  - PTY/interactive sessions still use tmux via revive-session.sh
- `ab5c5bd` Cache TTL countdown timer with live expiry warning
- `bd359e5` Filter subagent task_progress/task_notification from parent transcript
- `d8b5ac5` Launch monitor UI - live pipeline status in RunTaskDialog

### Fixes
- `37460cd` Ad-hoc sessions auto-terminate after first result
- `5445d9a` Ad-hoc task runner - prompt delivery, shell quoting, session names

### Chores
- `1022d1e` Add task-statuses shared module, biome formatting fixes
- `cee8326` Fix all 155 biome lint diagnostics

---

## 2026-04-12

### Features
- `fb5514d` Right-click rename sessions + fix rename regex capturing XML tags
- `ebada97` Add handlers for PermissionDenied, TaskCreated, FileChanged hook events

### Fixes
- `6a2e6b0` Clean up /rename rendering in transcript
- `99077c7` Revive sessions with their original name instead of auto-generating
- `91d82d0` Cache warning uses last-turn token usage instead of cumulative stats

### Reverts
- `4fd70b0` Revert "fix: user-set session names (/rename) overwritten by auto-generated names"

---

## 2026-04-06

### Features
- `90cc7d7` Session sharing - server foundation (token-based temporary access, persisted to shares.json)
- `b842be4` Dashboard shared mode (MVP) - limited UI for share viewers at `/#/share/TOKEN`
- `2fc4adf` Silicon Valley + sci-fi quotes in share screens
- `07aaa5f` WS-pushed share updates + permission checkboxes (chat, files:read, terminal:read)
- `be0c947` Share management UI + session list indicator (share icon in sidebar)
- `c01a9f8` Nicer rendering for tool errors + persisted output

### Fixes
- `c659b4e` Share API accepts bearer token auth
- `38e5335` Share hash regex handles leading slash (`/#/share/TOKEN`)
- `c332601` Detect share token at module load time (before WS URL)
- `5b7d6dd` Shared view scrolls to bottom after transcript loads
- `a25fb60` Shared view container needs overflow-hidden + flex col for scroll
- `94773eb` Move ShareBanner above collapsible info section - always visible
- `bf21e31` Push initial shares state on WS subscribe for admin users
- `ab8ec72` broadcastSharesUpdate sent to admin-role users, not just bearer auth

### Security
- `60e02db` Gate ALL HTTP endpoints with permission checks
- `eef24a8` Fix broadcast leaks + add missing WS permission checks

---

## 2026-04-05

### Features
- `517975a` Grant-based permission model with temporal bounds
- `678d2ff` Wire requirePermission into all WS handlers
- `b455b00` Grant-based UI gating with named permission flags (canChat, canEditUsers, etc.)
- `91afcb2` Gate input bar behind canChat permission
- `049d442` Server-pushed permissions + grant expiry enforcement
- `bd7c8a4` CLI grant management for multi-user permissions
- `7ab3a0a` Server roles (user-editor) + canEditUsers permission flag
- `dc29f1e` Per-user push subscriptions with grant-gated notifications
- `3bc5682` User admin API endpoints (user-editor gated)
- `2bfbb1a` User admin UI with grant editor + invite flow
- `d0dea1b` Passkey delete UI + credential details in admin panel
- `83e60bd` CLI server roles, time-bounded grants, passkey delete
- `1ebc7c9` Inline grant editing + immediate permission refresh (hot-reload to live WS)
- `9afd38e` Frequency-weighted session switcher ordering (LRU top 2 + frequency for rest)
- `0e1ea99` Startup update check + MCP check_update tool
- `dca58c8` add --rclaude-version and --rclaude-check-update flags
- `4131fc8` Rich send_message rendering with clickable targets and markdown
- `e453f4d` Add C# syntax highlighting (csharp, cs, c#)
- `b85f68a` Deferred delivery check for queued inter-session messages

### Fixes
- `50f1086` Filter session list by user grants (chat:read per CWD)
- `23ba692` CLI auto-detect Docker cache dir + bearer auth for user-editor API
- `6c440a5` Sidebar always visible + auto-select single session
- `dd30259` Voice FAB stuck-in-refining safety timeout
- `96fea2d` Handle voice stop while Deepgram WS still connecting
- `c50a7c9` Re-fetch sidebar metadata on reconnect and visibility restore
- `a2c026d` User admin dialog layout - proper padding and scroll area
- `b2e641b` Remove duplicate case labels in tool-line switch

### Refactors
- `5adb134` Separate roles from permissions in grant model
- `15039e0` Lazy-load beautiful-mermaid and xterm.js
- `a11e70b` Rename quit_session MCP tool to terminate_session
- `6d08d2b` Migrate dashboard mutations from HTTP to WebSocket

---

## 2026-04-02

### Features
- `ddd18b0` Spawn/revive rendezvous callback protocol (no more polling with list_sessions)
- `b65ccf9` Show Claude account info (email, subscription) in session header
- `242fee1` Add Read support + absolute path patterns to permission auto-approve (21 tests)

### Fixes
- `160dd7d` Boot script auto-spawns fresh session after QUIT (duplicate session bug)
- `f796a7f` Revive sends `--mode continue` to prevent boot script fallthrough
- `9feb9ac` Force transcript refetch after mobile background resume (>5s)
- `dd49448` Inline code styling in chat bubbles (bg-black/25, rounded, lighter text)

## 2026-04-01

### Features
- `2da3e5d` Permission auto-approve rules via `.claude/rclaude.json` + ALWAYS ALLOW button
- `45079ed` JSON Schema for `.claude/rclaude.json` with IDE autocompletion
- `35d98a7` Error styling on failed tool calls (red border, ERROR badge, auto-expand)
- `efc65ef` Auth session renewal + expired session modal
- `3851b22` Project description field visible in list_sessions

### Fixes
- `f091598` Escape angle brackets in markdown code blocks (raw `<tag>` in unfenced code was invisible)
- `61883a0` User input chat bubbles render code fences and tables correctly
- `61883a0` System prompt guards against CC native SendMessage for inter-session replies
- `6cde640` Server-side WS auth expiry + linkedSessions type mismatch
- `30983dd` Ended sessions persist 28 days instead of 24 hours

### Refactors
- `0d333f3` Limit permission auto-approve to Write/Edit only (CC handles the rest)

## 2026-03-31

### Features
- `1b243c6` Rich inter-session message rendering in transcript
- `239447d` Benevolent session lifecycle tools (revive + quit)
- `697dacd` Trust levels for inter-session messaging
- `134ec5c` Wire conversation view into session detail
- `91c7f38` Session links management UI + conversation view
- `11df0ef` Persistent inter-session links + message history
- `4869f62` Voice key recording indicator banner
- `778c706` Push-to-talk key binding + chat bubble color picker
- `5189ee5` CC 2.1.88 - PermissionDenied hook + show thinking by default

### Fixes
- `0336b8f` MCP tool display - session names, clean list rendering
- `a31a96d` Inter-session messages rendered as empty chat bubbles
- `d6f7f0b` Add diagnostic logging to hook forwarding pipeline
- `96e5c55` Deterministic local server port from session ID
- `5b53e82` Session stuck in STARTING when hooks not flowing
- `0473aed` Voice key re-entry guard for double keydown on modifier keys
- `9c61593` Voice key blocked by textarea focus guard
- `d6d1adb` Bubble text centering via inline markdown + disable input autocomplete
- `aa17e8f` Voice key inverted guard + bubble text centering
- `ccddffc` Transcript sync resilience + voice FAB touch + task display

### Refactors
- `88d3da3` Rename taskSummaryJsx to createTaskSummary
- `3aa2f31` Code review cleanup - DRY, dedup, efficiency

### Reverts
- `c9a5eeb` Remove broken transcript-based status activation
- `85d728a` showThinking default back to false

---

## 2026-03-30

### Features
- `6539787` Details for Nerds modal with Cache, Traffic, and Log tabs
- `f0a946e` LIFO session cache for instant switching
- `ceada6f` Peek selected session below collapsed group instead of expanding
- `449bdd3` Auto-expand group + scroll into view on session select
- `2301d1f` Quit session from context menu + fix clipboard duplicates
- `7fa92d0` MCP tool output display with configurable line limits
- `4ca35fb` MCP tools always available, channel input separate
- `73f5adf` Add toggle_plan_mode MCP tool for plan mode fallback
- `59f2bed` Shared tab - per-CWD server-side log with delete
- `649baaf` Shared tab with uploaded files + clipboard copy history
- `66e4ef2` Right-click context menu for session cards
- `c22681f` Shared files log with 90-day retention + API endpoint
- `5b3ca4c` Chat bubbles on by default
- `94f6902` Push notification deep links into session
- `3482da1` Chat bubble mode for user messages (opt-in experiment)

### Fixes
- `ef36f27` Always fetch transcript on session switch
- `bb73b58` Reset revive state on session switch + context menu for inactive sessions
- `dddfefc` Zombie session eviction at 30 days, not 24 hours
- `53c4862` Evict zombie sessions, log broadcast errors, fix resync storm
- `7a1ffe3` Memory leak audit - cap all unbounded collections
- `2d15ea8` Wrapper crash resilience audit - 18 fixes, zero crash paths
- `def71a3` Skip clipboard detection on initial transcript loads
- `66336a9` Use public origin for shared file URLs, not localhost
- `902d74c` Show project name prominently in collapsed session header

---

## 2026-03-29

### Features
- `1027fed` Detect OSC 52 clipboard in transcript tool results
- `0754cc6` Force OSC 52 clipboard via SSH_TTY env in PTY spawn
- `9609871` OSC 52 clipboard capture with dashboard relay

### Fixes
- `f8875f0` Clipboard COPY button with async/await and textarea fallback
- `888d275` Clipboard buttons use onPointerDown for reliable touch handling
- `f711f10` Add stream_close_delay to Caddy reverse proxy for WS resilience
- `a038a85` Defensive re-clear of input after successful send
- `8b8e099` Improve AskUserQuestion card contrast
- `f9a4c50` Parse truncated JSON in permission dialog with regex fallback
- `0064cba` CwdChanged tracks currentCwd, not project root

---

## 2026-03-28

### Features
- `be8457c` Render GitHub-flavored markdown alerts (TIP, NOTE, WARNING, etc)

### Fixes
- `a5110d6` Parse inline markdown inside alert callouts and blockquotes
- `605a46e` Alert callout regex handles `</p>` after `[!TIP]` marker
- `6aeccb2` Replace --append-system-prompt-file with --append-system-prompt
- `0a8ad81` Passthrough CLI subcommands directly to claude binary

---

## 2026-03-27

### Features
- `9385772` Show bash command immediately, before output arrives
- `7ee873c` Always show bash command with output, max 10 lines
- `b3c228c` Show bash description as summary instead of raw command
- `9ae9c68` AskUserQuestion relay via PreToolUse hooks (CC 2.1.85+)

### Fixes
- `8036cf1` Show bash command block for non-structured output too
- `c806191` Strip redundant leading comment from bash commands in transcript
- `1b964b2` Guard AskUserQuestion hook endpoint against non-matching tools

---

## 2026-03-26

### Features
- `44c7b73` Context window usage bar in session sidebar
- `fc5e7e6` Rich permission dialog with tool-specific formatting
- `71ca284` Add TaskCreated hook event (CC 2.1.84)
- `e93a0b8` Epoch+seq sync protocol + WS send refactor + zero TS errors
- `5fd6b85` Expand project icon library from 150 to 251 icons
- `430477d` Dependency updates, TS6 migration, UX fixes

### Fixes
- `53302af` Version mismatch check ignores -dirty suffix
- `3512b92` Resolve all biome lint issues and last TS error
- `d9e8494` Allow clearing project icon/label/color on save
- `05f6424` Only force-refresh on visibility restore for touch devices
- `d55f908` Use lightweight refresh_sessions instead of re-subscribe on resume
- `144a749` Always refresh sessions + transcript on iOS app resume
- `e75be30` SessionList crash guard, queued message layout, error display, new hooks

### Refactors
- `ea6c9d4` Simplify sync protocol after code review

---

## 2026-03-25

### Features
- `89847f3` Show plan content inline at ExitPlanMode in transcript view

### Fixes
- `d96f3fa` Version-aware hook injection to prevent settings rejection
- `3fe2822` install.sh preserves existing config on reinstall

---

## 2026-03-22

### Features
- `0343729` Permission relay via MCP channel
- `6086080` Machine fingerprint for agent identify
- `05cf202` Strikethrough rendering - custom GFM del with max length protection

### Fixes
- `5598e85` Input highlighter skips italic/bold inside code spans

---

## 2026-03-20

### Features
- `51f2698` Show link status (connected/blocked) in list_sessions results
- `b2892e6` Fullscreen markdown preview with ESC to close
- `fbfb5e3` Draggable file list divider + title tooltips + deep path validation
- `e02f378` Recursive .claude/**/*.md scanning in files tab
- `21dc99f` Clickable attention banner + CLAUDE.md updates + lint fixes
- `c089290` Linked session display in sidebar + session info with sever button
- `8e7c2d0` Dashboard UI for inter-session link approval + message decoration
- `77e7226` Inter-session communication - list_sessions + send_message
- `c659ed3` Replace reply tool with share_file, update system prompt
- `8996cdc` Add channel-specific system prompt instructions
- `cab7377` Show channel origin badge on user messages in transcript
- `eb79c0e` Channel keepalive, disconnect detection, transcript rendering
- `644859a` Report channel capability + show capabilities as pills in session info
- `e1cf1ae` MCP Channel prototype - replace PTY input with channel notifications
- `6f65d2b` Ctrl+Shift+Alt+T for fullscreen terminal toggle
- `a8a5423` WS pub/sub subscription system with channel-filtered routing

### Fixes
- `bb19d7e` Deduplicate agent completion notifications in transcript
- `3bbb466` stopImmediatePropagation on ESC in fullscreen to prevent tab switch
- `944a509` Use base36 for blob hashes (shorter URLs, same 64-bit security)
- `69f7030` Reset current/lastGroup after dedup splice to prevent detached groups
- `0cb34e1` Add logging capability for keepalive notifications
- `40483e5` Detect 'Enter to confirm' in Ink TUI output for auto-confirm
- `4480e4e` Strip ANSI escape codes before matching dev channel warning
- `e4d6c0a` Auto-confirm dev channel warning prompt on startup
- `3e87afe` Set idleTimeout to 255s for MCP SSE long-lived connections
- `1895236` Single MCP transport instance, connect once
- `7e9d5c0` Use stateful MCP transport with per-session transport instances
- `fe1d71a` Wrap --mcp-config JSON in mcpServers key
- `95bd847` Buffer and debounce diag messages, flush on WS connect
- `16a8b4e` Never write to console/stderr, ship channel logs via diag
- `3e83c92` Stop clearing requestedTab so Ctrl+Shift+T toggle works
- `4d1caed` Ctrl+Shift+T toggles between transcript and TTY tab, not fullscreen
- `2f96ebf` Correct markdown syntax in share_file description

### Security
- `e967be2` Replace DJB2 blob hash with SHA-256 truncated to 16 hex chars
- `014364e` Bind local server to 127.0.0.1 + restrict share_file to CWD
- `3e0cb2f` Remove approve/block MCP tools, route link requests to dashboard

### Refactors
- `7c95ea7` Use --mcp-config flag instead of writing .mcp.json

---

## 2026-03-19

### Features
- `4ba24b5` Extract session metadata from transcript entry types

### Fixes
- `9b8caa0` Handle Ctrl+Shift+T directly in terminal-local keydown handler
- `e968be4` Pass Ctrl+Shift+T through xterm to global handler for toggle
- `c32b16a` Ctrl+Shift+T toggles back to transcript tab when closing terminal
- `a09a0c3` Include session metadata in HTTP sessions endpoint
- `2f7fba8` Persist image blobs to disk, survive container restarts
- `2156703` Return empty 404 responses for missing images instead of JSON
- `60aa438` Wire session metadata through toSession mapper to dashboard
- `604de36` Preserve metadata entries when truncating initial transcript batch
- `ff8efe9` Clear input optimistically on submit, restore on failure
- `98f5527` Transcript not reloading on WebSocket reconnect

---

## 2026-03-18

### Features
- `3fa4d44` Detect pending permission/elicitation and show attention banner
- `d8788ba` Render structured bash output with input/stdout/stderr sections
- `ac80700` Add DnD back with tree data model
- `a5eab06` Session order v2 tree data model + API migration
- `af273cd` Show StopFailure as [ERROR] badge + detail banner
- `88df6d4` Add StopFailure hook event (Claude Code 2.1.78)
- `f699bfe` Mermaid diagram rendering in markdown

### Fixes
- `5f0cee2` Improve HTML tag escaping in markdown to handle mixed content
- `b2489a3` Add error handling and logging for failed input submissions
- `0de7ab3` Deduplicate queue-operation synthetic entries with real user entries
- `dd0e1cf` Double paste in xterm.js - preventDefault on Cmd+V keydown
- `3c276ad` Persist sessions on end/dismiss + extend eviction to 24h
- `373e51e` SessionStart/InstructionsLoaded should not set session to active
- `e95ec07` Remove duplicate children rendering in GroupNode
- `2f0f631` Replace react-arborist with simple recursive tree rendering

---

## 2026-03-17

### Features
- `2567d05` Add confirmation to session dismiss buttons
- `36a1a40` Dismiss ended sessions from sidebar

### Fixes
- `d256816` Silence hook forwarder curl errors
- `131015a` Paste in web terminal via Clipboard API
- `7c4ca0c` Mount HighlightStyle CSS for direct highlight plugin
- `6a3b725` Replace broken syntaxHighlighting with direct ViewPlugin
- `a6bc088` Stabilize transcript view + add paste debugging
- `3ccc741` Show input box for 'starting' sessions
- `af1d81e` SHIFT+ENTER double newlines in web terminal
- `874b59a` Add 'starting' session status for spawn/revive
- `9c06e7f` Transcript watcher timeout + kick signal + CM6 highlight fixes

### Refactors
- `5e70b67` Replace hand-rolled HTTP routing with Hono

---

## 2026-03-16

### Fixes
- `71e0b81` Version mismatch in Docker - skip gen-version when no git + exclude self from dirty check
- `627a026` Subscribe to subagent transcript channel for realtime updates
- `f9b0586` CodeMirror syntax highlighting based on file extension
- `efe019e` Deduplicate subagent transcript entries by uuid
- `fd893cf` Remove duplicate [ENDED] badge from session list
- `06a372a` Increase liveness timeout from 30s to 5m (safety net, not feature)
- `030b7f6` Long-press to drag on mobile (300ms), instant drag on desktop (8px)
- `aeb041c` log dropped queue messages and drop oldest instead of newest
- `4bd47da` Replace 1s reconnect delay with ack-based resend
- `a1b926f` Drop byte-aware chunking, keep count-based at 50
- `ad01e19` Improve WS reconnection resilience and prevent oversized frames

---

## 2026-03-15

### Features
- `ebc81ab` Ctrl+Shift+S opens spawn dialog (Ctrl+K prefilled with S:./)
- `a3020ee` Collapsible session groups (persisted to localStorage)
- `5c08ec4` Project settings editor is now a modal dialog instead of inline
- `be54995` Visual drag grip on session cards (CSS only, no separate listeners)
- `f49b075` Full DND for session organization
- `01907c1` Session groups in organized sidebar
- `4d20ab4` Organized/Unorganized session sidebar with drag-to-reorder

### Fixes
- `94163c8` Default spawn root from $RCLAUDE_SPAWN_ROOT env (flag > env > $HOME)
- `450a2a3` SHIFT+ENTER sends ESC+CR in terminal + paste support via clipboard event
- `5d4111a` Resolve relative file paths against session CWD (not reject them)
- `c28654c` Clear input draft from Zustand store after successful send
- `dc05dd3` Smart --continue for spawned sessions (try continue, fallback to fresh)
- `6018be8` Use break-word instead of anywhere for markdown text wrapping
- `3323b96` Parse inline markdown (bold, italic, code) in table cells
- `0bc13f7` Lock viewport scale + resize-content (fixes rotation zoom)
- `ff8a6f0` Prevent drag item jump + remove redundant unpin drop target
- `276c76d` Remove duplicate close button, rename Clear to Reset All
- `a620929` Put ALL dnd props on outer div - no activator separation
- `374269a` Also replace `<button>` with `<div>` in InactiveProjectItem
- `eec2965` Replace `<button>` with `<div>` in SessionItemContent (button captures pointer events)
- `8b8aa51` Use flex layout for drag handles (not absolute positioning)
- `a06a734` DND actually works now - remove TouchSensor conflict, fix handle bounds
- `82cdd2c` Remove Radix context menus from session list (was blocking DND)
- `1d5ee8b` Use setActivatorNodeRef for drag handles + remove left margin
- `30626c3` Separate drag handle from context menu trigger (fixes drag not working)
- `9fcbeec` Forward --spawn-root and --no-spawn args in start-sentinel.sh
- `54fed51` Show copy button on touch devices (iPad) using @media(hover:hover)

### Refactors
- `92747ee` Move path guard from concentrator to wrapper (rclaude)

---

## 2026-03-14

### Features
- `bf545c9` Copy as Image + table markdown source storage
- `e3817ea` Copy format menu - right-click/long-press for Rich Text, Markdown, Plain Text
- `e3ec243` Per-action copy buttons on tool results and text blocks
- `86f45ca` Copy-as-markdown button on assistant groups + break circular dependency
- `0184632` Haptic feedback on live transcript and hook events
- `665caa8` Show "update available" when server version changes
- `feee9fd` Inline TTY tab in content area
- `2644408` Parse task-notification fields + fix raw XML in transcript
- `7676d07` Float queued messages at bottom of transcript until consumed
- `4caabc5` Kill all `as any` casts on transcript entries
- `e158e3e` Discriminated union types for JSONL transcript entries
- `223d84c` Show queued/delivered state for interject messages
- `1cfb64b` Add PostCompact, Elicitation hooks + fix compaction tracking
- `1ed9b4b` Add "ultrathink" keyword detection with effort badges
- `48382e5` Add effort level detection and display
- `d404496` Support 1M context window for Opus 4.6 models

### Fixes
- `6d68c09` Add image padding via canvas post-processing, not DOM mutation
- `c20a503` Pre-load html-to-image eagerly + sync DOM mutation for Safari
- `2a846dc` Pass blob promise to ClipboardItem for Safari compatibility
- `7799968` Add path traversal guard for file editor operations (security)
- `152eceb` Bump mobile copy button opacity from 30% to 60%
- `88230c7` Remove copy button from tool action lines, keep only on text blocks
- `a471b70` Mobile tap opens copy format menu directly (DropdownMenu)
- `38a9ed2` Clear text selection when copy format menu opens on mobile
- `ccd02e6` Use Radix ContextMenu for copy format menu (fixes mobile long-press)
- `fe806eb` Remove non-gesture haptics (iOS blocks them) + add file tap haptic
- `f3673ad` Haptics not firing - scan batch for assistant entries, not just last
- `14c19ab` Use interactive login shell (-li) for tmux spawns + restore --continue
- `4d42909` Spawn tmux sessions with login shell for full environment
- `8ad5546` Queued messages stuck as "queued" after reconnect or task-notifications
- `8c57049` Reliable scroll-to-bottom on session switch
- `cf1b43c` Show file paths and glob filters in Grep/Glob transcript lines
- `cdee38b` ALT+ENTER inserts newline in markdown inputs (like SHIFT+ENTER)
- `d726a7a` Mark agents stopped when killed via TaskStop
- `7f9661d` Remove --continue/fresh race condition in session reviver
- `f58e3dc` Handle tmux session not found in window_count()
- `68ae253` Move default view setting to client prefs (per-device)
- `c27c3c3` Close terminal on session switch to stop stale PTY streaming
- `7a8a112` Memoize FileEditor to prevent re-renders from session updates
- `4c910f0` Token double-counting on transcript reload + long line truncation
- `1726183` Surface queued interject messages in transcript

### Refactors
- `4caabc5` Kill all `as any` casts on transcript entries

---

## 2026-03-13

### Features
- `84c4770` WS stats modal with server-side traffic metrics
- `f51c1b9` Paste format selection when clipboard has both image and text
- `cba98b2` Highlight grep pattern matches in transcript output
- `61170e7` Ctrl+Shift+Alt+N opens NOTES.md in file editor
- `a8a5423` WS pub/sub subscription system with channel-filtered routing
- `d5fe96c` Per-subagent token usage tracking and display
- `5ade677` Default view setting (transcript vs TTY)
- `3939044` Ctrl+Shift+T toggles terminal (was open-only)
- `a90dc89` Unified filterable settings page + move crDelay to server
- `45dca41` Configurable carriage return delay + hide verbose on mobile
- `f9ab0fb` Paste delay scaling, quick note haptics, optimistic transcript
- `93f7900` Voice refinement settings + scrollable settings tabs
- `0f7b6a0` Voice FAB - floating hold-to-record for mobile
- `e29d74f` Detect and display Claude Code version per session
- `9434ad0` Version tab in settings showing build info and recent commits
- `2611259` Agent diagnostics + fix spawn --continue fallback

### Fixes
- `de17d96` Handle stale chunk errors in lazy-loaded AgentInline
- `a7f8c6c` Prevent transcript/event updates from re-rendering file editor
- `57adae5` Compaction state survives session rekey + canceled compaction cleanup
- `cf90ebc` Eliminate Zustand re-render storms causing React error #185 and UI jank
- `3da1339` Retry WS reconnection forever (30s cap) instead of giving up after 10 attempts
- `044be69` Quick note multiline indentation
- `7134c55` Shorten placeholder text on mobile to prevent wrapping
- `59f7d6e` Compacting banner disappears when compaction completes
- `ad4db6a` Vertical caret/text misalignment in markdown input
- `42050cd` Show Files tab for idle sessions, not just active
- `e96c009` Sanitize HTML in AnsiText to prevent style/script injection
- `8427904` Unset CLAUDECODE env vars before agent spawn
- `dd2ce09` Voice FAB pointer race condition + stale closure bugs
- `48b972d` Add error logging and descriptive messages to Voice FAB
- `35d5f64` Add BuildVersion type to version.ts stub
- `9d65830` Standardize RCLAUDE_CONCENTRATOR env var + symlink install
- `534364d` Add debug logging to WebSocket client
- `f935ed0` Memory leak - evict non-selected session data on switch
- `283a1a3` Quick note shortcut no longer swallows Ctrl+Shift+Alt+N
- `77e23e9` Ctrl+Shift+Alt+N shortcut on macOS + paste picker false positives
- `f39711a` Treat file paths as filenames in paste format detection

### Refactors
- `78a2689` Split transcript-view.tsx into focused modules

---

## 2026-03-12

### Features
- `bea5178` Per-tool display settings + migrate dashboard prefs to Zustand
- `4d338bd` Show version + recent commits on error screen
- `b6f034e` Truncate verbose outputs to 10 lines with "show more" button
- `59e95e9` Spawn mkdir support + create-and-spawn UI in command palette
- `e2d11bd` MRU session ordering in Ctrl+K palette (Alt+Tab style)
- `419f941` Code block copy, debug panel resize, WS render batching
- `f9b85c4` Auto-report dashboard crashes to concentrator
- `0da8d47` Add re-register push button in notification settings

### Fixes
- `e6e370e` Prevent sidebar filter input from stealing focus on mobile
- `6871573` Quick note input focuses on mobile + inline mode for MarkdownInput
- `72caf8a` Mobile compose retain-count system for blur-to-collapse
- `9d724dd` Mobile compose overlay behind header, passive hook status fix
- `dc33320` Accurate session status with liveness check + cleaner task display
- `361b3d2` Defer virtualizer ResizeObserver to prevent React #300 errors
- `d190904` Transcript watcher dies after /clear - switch to directory-level watching
- `d2fd580` Transcript watcher exponential backoff + conversationIds in REST API
- `a1a3c3f` RCLAUDE_CONVERSATION_ID leaking across tmux sessions
- `fbb147e` WrapperID leaking across sessions - stale socket registration
- `13bbc1b` Infinite re-render loop from unstable Zustand selector fallbacks
- `5b864bc` React error #310 - hooks called after early returns in GroupView
- `3f1745f` React #300 root cause - immutable groups in useIncrementalGroups
- `f41acb8` Preserve component names in Vite prod build
- `e286655` React error #300 - ResizeObserver + selectorless Zustand stores
- `72da7a1` Stale localStorage keys in error boundary dump
- `77c3535` Preserve component names in prod + localStorage dump in error reports

### Refactors
- `b272eb1` Fix duplicate and confusing symbol names
- `2600ab9` Deduplicate ProjectSettings, FileInfo, BgTaskSummary to shared
- `ad18ae6` Deduplicate SessionSummary and shared types across codebase
- `93683d4` Hook-based session idle detection, remove artificial timer

---

## 2026-03-11

### Features
- `926f13b` Real-time WS traffic stats in header bar
- `e704b71` Live settings broadcast, notification toasts, expanded icons
- `a3ca083` Tabbed settings, label color/size pickers, fix input lag
- `8621ff3` Notification conduit, settings labels, session dedup, UX fixes
- `49c602f` Collapsible sidebar with localStorage persistence
- `fc50d4b` iOS/Android haptic feedback + hold-to-record voice input
- `f9d9d87` Deepgram Nova-3 voice input with two-step TAP refinement
- `feb2aac` Debug console, command palette commands, voice input diagnostics
- `2b532d1` Command palette refactor - extract into sub-components

### Fixes
- `9069efc` Retry transcript watcher startup for brand new projects
- `ed46a5d` Voice-to-text prefix, Go Home command, formatting fixes
- `61c620e` Compacting state only clears on SessionStart, not any random event
- `f3ac425` Sidebar collapses to zero-width floating tab + boost active sessions in fzf
- `ecd5895` Command palette fuzzy search now case-insensitive
- `40a6de1` Move mobile compose toolbar to bottom for thumb reachability
- `52260c8` Disable hljs auto-detect, redesign scroll button as round chevron
- `6625ce6` Survive /clear without losing dashboard session
- `6c65de3` SEND button focuses input when empty (mobile Siri zone workaround)
- `f1247bb` Move input hint to placeholder, remove redundant help text
- `5f068ae` Markdown input alignment, focus borders, and SEND button stretch
- `2cc163b` Verbose toggle, markdown input borders, and Bash expand

---

## 2026-03-10

### Features
- `e903104` Fuzzy matching, Cmd+K support, and session switcher UX improvements
- `644affa` Spawn rclaude sessions from dashboard + dir autocomplete
- `dff4088` Clickable agent status badge + live inline agent transcript
- `c27190f` Stream background task output to dashboard
- `9cf1472` Full bash output with syntax-highlighted command in verbose mode
- `6f33a0f` Auto-open session sidebar on mobile when nothing selected
- `d95d8a1` Persist verbose mode toggle in localStorage

### Fixes
- `1b7c553` Add diag events for bg task output watcher lifecycle
- `b55e198` Show full thinking blocks in verbose mode
- `ad2702a` Focus expanded compose textarea via ref callback
- `45d795e` Don't re-focus textarea after send on mobile
- `ab1618d` Prevent mobile compose modal from opening on session select

### Refactors
- `8fe39cc` Extract isMobileViewport() to shared utils
