# UI Features

## Dialog Tool

The `dialog` MCP tool replaces `AskUserQuestion` (disabled when channels active)
with a rich, declarative UI system. **Use proactively whenever you need user input.**

**Do NOT ask questions in plain text when dialog is available.** Dashboard user
may be on a phone -- structured UI is faster.

**14 components:** Markdown, Diagram, Image, Alert, Divider, Options, TextInput,
ImagePicker, Toggle, Slider, Button, Stack, Grid, Group

**Key features:**
- Local file paths in Image/ImagePicker auto-uploaded by wrapper
- `pages` array for wizard-style multi-page flows
- Buttons record `id` as `_action` but don't dismiss (only Submit does)
- 5-minute timeout, auto-extends 50% on interaction
- Pending dialogs survive dashboard reload

## Clipboard Capture (OSC 52)

PTY mode intercepts OSC 52 clipboard sequences, relays to dashboard as CLIPBOARD banners.

**How:** `pty-spawn.ts` sets `SSH_TTY` -> CC uses OSC 52 instead of `pbcopy` ->
`Osc52Parser` in `osc52-parser.ts` extracts payload -> `clipboard_capture` WS message.

**Transcript-side:** `terminal-copy` OSC 52 goes to CC's captured stdout. Concentrator's
`session-store.ts` scans tool_result content for OSC 52 sequences.

**Dashboard:** Stack of 4, newest on top. Text preview (500 chars), image thumbnail.
Logged to `shared-files.jsonl` (per-CWD, 90-day retention).

## Copy Format Menu

Transcript text blocks: copy button (hover desktop, always visible touch).

**Formats:** Rich Text (HTML), Markdown, Plain Text, Image (PNG).\
**Desktop:** Click = markdown, right-click = picker.\
**Mobile:** Tap = picker.

**Copy as Image:** `html-to-image` (pre-loaded eagerly -- Safari breaks gesture chain
on dynamic import). Canvas post-processing for padding. Blob promise passed directly
to `ClipboardItem` (Safari requirement). Component: `copy-menu.tsx`.

## Haptics

**Every interactive touch action MUST have haptic feedback.**

```ts
import { haptic } from 'web/src/lib/utils'

haptic('tap')     // button presses, toggles, selections
haptic('tick')    // subtle state changes, threshold crossings
haptic('double')  // important actions starting
haptic('success') // completed actions
haptic('error')   // failures, cancellations
```

**iOS limitation:** Haptics ONLY work from user gesture handlers. WS handlers,
timers, async callbacks silently ignored by WebKit. Don't add haptics to non-gesture paths.

## Dashboard Commands & Shortcuts

**Commands are first-class, shortcuts are optional accelerators.** Mobile users
rely on command palette (Ctrl+K).

**Adding a new action:**
1. Add to Zustand store
2. Register as command in session-switcher
3. Optionally bind keyboard shortcut in `app.tsx`
4. Add to `shortcut-help.tsx` if shortcut exists

| Command | Shortcut | Store method |
|---------|----------|-------------|
| Session switcher | Ctrl+K | `toggleSwitcher()` |
| Spawn session | Ctrl+Shift+S | `openSwitcherWithFilter('S:./')` |
| Quick note | Ctrl+Shift+N | event: `open-quick-note` |
| Open terminal | Ctrl+Shift+T | `openTerminal(wrapperId)` |
| Toggle verbose | Ctrl+O | `toggleExpandAll()` |
| Debug console | Ctrl+Shift+D | `toggleDebugConsole()` |
| Shortcut help | Shift+? | local state |
| Interrupt | Esc Esc (700ms) | `wsSend('send_interrupt')` |

**Naming:** Imperative verbs. `toggleX()` for on/off, `openX()` for show.

## Capabilities

Declared via `SessionMeta.capabilities`. Dashboard conditionally shows features.

Current: `terminal`, `channel`.\
Disable terminal: `--no-terminal`.\
Enable channel: `--channels` (default ON).

`set_task_status` moves task notes between columns without Bash `mv` (avoids
permission prompts). Takes `id` and `status` (open/in-progress/done/archived).
