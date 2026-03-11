# Command Registry & Dispatcher - Design Plan

## Problem

Keyboard shortcuts are scattered across 6+ components as manual `addEventListener('keydown')` handlers in `useEffect` blocks. Each component independently manages its own shortcuts with no central registry, no discoverability, and no way to list them programmatically. The `shortcut-help.tsx` is a hardcoded list that drifts from reality. Adding the `>` command palette mode to the session switcher requires a central registry that both keybinding dispatch and palette UI can query.

## Architecture Overview

```mermaid
graph TD
    CR[CommandRegistry<br/>standalone Map] --> |"provides commands"| CP[Command Palette<br/>> mode in switcher]
    CR --> |"provides commands"| SH[Shortcut Help<br/>auto-generated]
    CR --> |"provides bindings"| HK[@tanstack/react-hotkeys<br/>HotkeyManager singleton]
    HK --> |"fires executeCommand"| CR
    CR --> |"reads state via getState"| SS[SessionsStore<br/>Zustand]

    subgraph "Registration (module load)"
        RC[registerCommand + registerKeybinding] --> CR
    end

    subgraph "Consumers"
        CP
        SH
        MB[Menu Buttons<br/>onClick -> executeCommand]
    end
```

**Three distinct concerns:**

1. **Command Registry** - A `Map<string, Command>` storing command metadata, `execute` functions, and `isEnabled` predicates. NOT a Zustand store - standalone module with store access.
2. **Keybinding Layer** - `@tanstack/react-hotkeys` `HotkeyManager` singleton maps key combos to command IDs. Separate from commands so one command can have multiple bindings (or none).
3. **Palette UI** - The `>` mode in session-switcher queries the registry, fuzzy-matches on title, and shows keybinding hints. Disabled commands show **greyed out** with reason.

## Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Disabled commands in palette | **Greyed out** with reason | User discovers what's possible |
| Command arguments | **Optional sub-prompt** | Default fire-and-forget, but commands CAN declare `promptForInput` |
| Shortcut help generation | **Auto from registry** | Single source of truth, replaces hardcoded arrays |
| Registry location | **Standalone Map + module** | Not reactive - reads Zustand via `getState()` on demand |
| Enable/disable pattern | **Derived from state** | `isEnabled()` reads Zustand - no explicit enable/disable calls |
| Keybinding library | **@tanstack/react-hotkeys** | `Mod` key, type-safe, TanStack ecosystem |

## Why NOT a Zustand Store for the Registry

The registry is a static `Map` that changes only at module load time (commands register once). Making it a Zustand store would cause unnecessary re-renders every time we check `isEnabled` (which reads FROM the sessions store). Instead:

- Registry = plain `Map<string, Command>` in a module
- `isEnabled` functions call `useSessionsStore.getState()` - evaluated on-demand, not reactively
- Palette UI calls `getCommands()` which evaluates `isEnabled` at render time
- No subscriptions, no proxy overhead, no re-render cascades

## Command Interface

```typescript
// web/src/lib/command-registry.ts

interface Command {
  /** Unique identifier, dot-namespaced: "session.revive", "view.toggleVerbose" */
  id: string

  /** Human-readable label for command palette: "Revive Session" */
  label: string

  /** Category for grouping in palette UI and shortcut help */
  group: CommandGroup

  /** Execute the command. */
  execute: () => void

  /**
   * Whether the command can currently execute.
   * Called on-demand (not reactive). Reads store state via getState().
   * If omitted, command is always enabled.
   */
  isEnabled?: () => boolean

  /**
   * Human-readable reason why the command is disabled.
   * Shown greyed out next to disabled commands in palette.
   * Only called when isEnabled returns false.
   */
  disabledReason?: () => string

  /**
   * Optional sub-prompt for commands that need input.
   * When selected in palette, replaces the input with a sub-prompt.
   * Like S: spawn mode does for path input.
   */
  promptForInput?: {
    placeholder: string
    execute: (input: string) => void
  }
}

type CommandGroup =
  | 'Session'       // session lifecycle: select, revive, spawn
  | 'View'          // UI state: verbose, terminal, tabs
  | 'Navigation'    // moving between sessions/panels
  | 'Terminal'      // terminal-scoped: close, settings
  | 'Tools'         // quick note, file editor, settings
  | 'Input'         // input bar (display-only in help, not in palette)

interface Keybinding {
  /** Command ID to fire */
  commandId: string

  /** TanStack hotkey string: "Mod+K", "Mod+Shift+T", "Shift+?" */
  hotkey: string

  /** Display string for help screen (auto-generated if omitted) */
  display?: string

  /**
   * Context predicate - when should this binding be active?
   * If omitted, binding is always active (global).
   */
  when?: () => boolean
}
```

## Registry Implementation

```typescript
// web/src/lib/command-registry.ts

const commands = new Map<string, Command>()
const keybindings: Keybinding[] = []

function registerCommand(cmd: Command): void {
  if (commands.has(cmd.id)) {
    console.warn(`[commands] duplicate: ${cmd.id}`)
  }
  commands.set(cmd.id, cmd)
}

function registerKeybinding(binding: Keybinding): void {
  keybindings.push(binding)
}

function executeCommand(id: string): boolean {
  const cmd = commands.get(id)
  if (!cmd) return false
  if (cmd.isEnabled && !cmd.isEnabled()) return false
  cmd.execute()
  return true
}

function getCommands(): Array<Command & { enabled: boolean }> {
  return [...commands.values()].map(cmd => ({
    ...cmd,
    enabled: cmd.isEnabled ? cmd.isEnabled() : true,
  }))
}

function getEnabledCommands(): Command[] {
  return [...commands.values()].filter(c => !c.isEnabled || c.isEnabled())
}

function getCommandsByGroup(): Map<CommandGroup, Array<Command & { enabled: boolean }>> {
  const groups = new Map<CommandGroup, Array<Command & { enabled: boolean }>>()
  for (const cmd of getCommands()) {
    const list = groups.get(cmd.group) || []
    list.push(cmd)
    groups.set(cmd.group, list)
  }
  return groups
}

function getKeybindingsForCommand(id: string): string[] {
  return keybindings.filter(b => b.commandId === id).map(b => b.display || b.hotkey)
}

function getAllKeybindings(): Array<Keybinding & { label: string; group: CommandGroup }> {
  return keybindings
    .filter(b => commands.has(b.commandId))
    .map(b => {
      const cmd = commands.get(b.commandId)!
      return { ...b, label: cmd.label, group: cmd.group }
    })
}
```

## Context Helpers

Composable predicates that read Zustand state. Commands use these in `isEnabled`.

```typescript
// web/src/lib/command-context.ts

import { useSessionsStore } from '@/hooks/use-sessions'
import { canTerminal } from '@/lib/types'

export const ctx = {
  hasSession: () => !!useSessionsStore.getState().selectedSessionId,

  sessionIsActive: () => {
    const s = useSessionsStore.getState()
    const session = s.sessions.find(x => x.id === s.selectedSessionId)
    return session?.status === 'active' || session?.status === 'idle'
  },

  sessionIsEnded: () => {
    const s = useSessionsStore.getState()
    const session = s.sessions.find(x => x.id === s.selectedSessionId)
    return session?.status === 'ended'
  },

  hasTerminal: () => {
    const s = useSessionsStore.getState()
    const session = s.sessions.find(x => x.id === s.selectedSessionId)
    return !!session && canTerminal(session)
  },

  terminalOpen: () => useSessionsStore.getState().showTerminal,
  agentConnected: () => useSessionsStore.getState().agentConnected,

  notInInput: () => {
    const el = document.activeElement as HTMLElement | null
    return el?.tagName !== 'INPUT' && el?.tagName !== 'TEXTAREA' && !el?.closest('.xterm')
  },
}
```

Usage:

```typescript
registerCommand({
  id: 'terminal.open',
  label: 'Open Terminal',
  group: 'Terminal',
  isEnabled: () => ctx.hasTerminal() && !ctx.terminalOpen(),
  disabledReason: () => !ctx.hasSession() ? 'No session selected' : 'No terminal capability',
  execute: () => {
    const s = useSessionsStore.getState()
    const session = s.sessions.find(x => x.id === s.selectedSessionId)
    if (session?.wrapperIds?.[0]) s.openTerminal(session.wrapperIds[0])
  },
})

registerKeybinding({ commandId: 'terminal.open', hotkey: 'Mod+Shift+T' })
```

## @tanstack/react-hotkeys Integration

### Installation

```bash
cd web && bun add @tanstack/hotkeys @tanstack/react-hotkeys
```

### HotkeyManager Singleton

TanStack Hotkeys uses a singleton `HotkeyManager` with one event listener regardless of registration count:

```typescript
// web/src/lib/command-registry.ts (continued)

import { HotkeyManager } from '@tanstack/hotkeys'
import type { HotkeyRegistrationHandle } from '@tanstack/hotkeys'

const handles: HotkeyRegistrationHandle[] = []

function activateKeybindings(): void {
  const manager = HotkeyManager.getInstance()

  for (const binding of keybindings) {
    const handle = manager.register(binding.hotkey, () => {
      if (binding.when && !binding.when()) return
      executeCommand(binding.commandId)
    }, {
      preventDefault: true,
      stopPropagation: true,
      ignoreInputs: false, // we handle input guards via when/isEnabled
    })
    handles.push(handle)
  }
}

function deactivateKeybindings(): void {
  for (const h of handles) h.unregister()
  handles.length = 0
}
```

### Key Format

`Mod` auto-resolves to Cmd on macOS, Ctrl on Windows/Linux:

| Current code | TanStack format |
|-------------|----------------|
| `(e.ctrlKey \|\| e.metaKey) && e.key === 'k'` | `Mod+K` |
| `e.ctrlKey && e.shiftKey && e.key === 'T'` | `Mod+Shift+T` |
| `e.ctrlKey && e.shiftKey && e.key === 'N'` | `Mod+Shift+N` |
| `(e.ctrlKey \|\| e.metaKey) && e.key === 'o'` | `Mod+O` |
| `e.key === '?' && e.shiftKey` | `Shift+?` |

### React Setup

```tsx
// web/src/app.tsx
import { HotkeysProvider } from '@tanstack/react-hotkeys'
import '@/lib/commands'  // side-effect: registers all commands

export function App() {
  return (
    <HotkeysProvider>
      <AuthGate><Dashboard /></AuthGate>
    </HotkeysProvider>
  )
}

// In Dashboard component:
useEffect(() => {
  activateKeybindings()
  return () => deactivateKeybindings()
}, [])
```

### xterm.js Integration

Terminal's `attachCustomKeyEventHandler` queries registry instead of hardcoding keys:

```typescript
terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
  if (isRegisteredHotkey(e)) return false // let registry handle it
  if (useSessionsStore.getState().showSwitcher) return false
  return true
})
```

## Command Palette (`>` mode)

### Session Switcher Integration

Add `>` detection alongside `F:` and `S:`:

```typescript
const isCommandMode = filter.startsWith('>')
const commandFilter = isCommandMode ? filter.slice(1).trim() : ''

const allCommands = getCommands().filter(c => c.group !== 'Input')
const commandFzf = useMemo(
  () => new Fzf(allCommands, {
    selector: (c) => `${c.group} ${c.label}`,
  }),
  [allCommands],
)
const filteredCommands = commandFilter
  ? commandFzf.find(commandFilter).map(r => r.item)
  : allCommands
```

### Rendering

```tsx
{filteredCommands.map(cmd => (
  <button
    key={cmd.id}
    disabled={!cmd.enabled}
    onClick={() => {
      if (!cmd.enabled) return
      if (cmd.promptForInput) {
        setSubPromptCommand(cmd)
        setFilter('')
      } else {
        executeCommand(cmd.id)
        onClose()
      }
    }}
    className={cn(
      'w-full px-3 py-2 flex items-center justify-between text-left',
      cmd.enabled ? 'hover:bg-[#283457]' : 'opacity-40 cursor-not-allowed',
    )}
  >
    <div>
      <span className="text-xs text-[#565f89] mr-2">{cmd.group}</span>
      <span className="text-sm">{cmd.label}</span>
      {!cmd.enabled && cmd.disabledReason && (
        <span className="text-[10px] text-[#565f89] ml-2">
          ({cmd.disabledReason()})
        </span>
      )}
    </div>
    {getKeybindingsForCommand(cmd.id).map(kb => (
      <kbd key={kb} className="text-[10px] text-[#565f89] bg-[#33467c]/30 px-1.5 py-0.5">
        {kb}
      </kbd>
    ))}
  </button>
))}
```

### Sub-Prompt Flow

For commands with `promptForInput`:

1. User types `> send` and selects "Send Message"
2. Palette input clears, placeholder changes to command's `promptForInput.placeholder`
3. User types message, hits Enter
4. `promptForInput.execute(input)` fires, palette closes

Same pattern as `S:` spawn mode's path input.

## Full Command Inventory

Extracted from reading the actual codebase.

### Session Commands

| ID | Label | Keybinding | isEnabled | Source |
|----|-------|-----------|-----------|--------|
| `session.switcher` | Session Switcher | `Mod+K` | always | app.tsx:89 |
| `session.revive` | Revive Session | -- | session ended + agent connected | session-detail.tsx |
| `session.spawn` | Spawn New Session | -- | agent connected | session-switcher.tsx |
| `session.copyTranscript` | Copy Transcript | -- | has transcript | (new) |

### View Commands

| ID | Label | Keybinding | isEnabled | Source |
|----|-------|-----------|-----------|--------|
| `view.toggleVerbose` | Toggle Verbose | `Mod+O` | not in terminal/input | app.tsx:94 |
| `view.toggleFollow` | Toggle Auto-Follow | -- | has transcript | session-detail.tsx |
| `view.toggleThinking` | Toggle Thinking | -- | has transcript | session-detail.tsx |
| `view.expandInfo` | Toggle Session Info | -- | session selected | session-detail.tsx |

### Navigation Commands

| ID | Label | Keybinding | isEnabled | Source |
|----|-------|-----------|-----------|--------|
| `nav.nextSession` | Next Session | `Mod+]` | has sessions | (new) |
| `nav.prevSession` | Previous Session | `Mod+[` | has sessions | (new) |
| `nav.tabTranscript` | Show Transcript | `Mod+1` | session selected | (new) |
| `nav.tabEvents` | Show Events | `Mod+2` | session selected | (new) |
| `nav.tabAgents` | Show Agents | `Mod+3` | has subagents | (new) |
| `nav.tabTasks` | Show Tasks | `Mod+4` | has tasks | (new) |
| `nav.tabFiles` | Show Files | `Mod+5` | session active | (new) |
| `nav.tabDiag` | Show Diagnostics | `Mod+6` | session selected | (new) |
| `nav.filePicker` | File Browser | -- | session active | session-switcher.tsx |
| `nav.backFromSubagent` | Back from Agent | `Escape` | viewing subagent | session-detail.tsx |

### Terminal Commands

| ID | Label | Keybinding | isEnabled | Source |
|----|-------|-----------|-----------|--------|
| `terminal.open` | Open Terminal | `Mod+Shift+T` | has terminal + not open | app.tsx:102 |
| `terminal.close` | Close Terminal | `Mod+Shift+Q` | terminal open | web-terminal.tsx:212 |
| `terminal.settings` | Terminal Settings | `Mod+,` | terminal open | web-terminal.tsx:217 |
| `terminal.popout` | Pop Out Terminal | -- | has terminal | session-detail.tsx |

### Tools Commands

| ID | Label | Keybinding | isEnabled | Source |
|----|-------|-----------|-----------|--------|
| `tools.quickNote` | Quick Note | `Mod+Shift+N` | session active | quick-note-modal.tsx:28 |
| `tools.settings` | Dashboard Settings | -- | always | settings |
| `tools.shortcutHelp` | Keyboard Shortcuts | `Shift+?` | not in input/terminal | shortcut-help.tsx:31 |
| `tools.projectSettings` | Project Settings | -- | session selected | project-settings |

### Input Commands (help-only, not in palette)

| ID | Label | Keybinding | Context |
|----|-------|-----------|---------|
| `input.send` | Send Message | `Enter` | input focused |
| `input.newline` | New Line | `Shift+Enter` | input focused |
| `input.paste` | Paste | `Mod+V` | input focused |

## Auto-Generated Shortcut Help

Replace `shortcut-help.tsx` hardcoded arrays with registry queries:

```typescript
const GROUP_ORDER: CommandGroup[] = ['Session', 'View', 'Navigation', 'Terminal', 'Tools', 'Input']

function ShortcutHelp() {
  const bindings = getAllKeybindings()
  const groups = new Map<CommandGroup, typeof bindings>()

  for (const b of bindings) {
    const list = groups.get(b.group) || []
    list.push(b)
    groups.set(b.group, list)
  }

  return (
    // ... same ASCII art KEYS banner ...
    {GROUP_ORDER.map(group => {
      const cmds = groups.get(group)
      if (!cmds?.length) return null
      return (
        <div key={group}>
          <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">{group}</div>
          {cmds.map(cmd => (
            <div key={cmd.commandId} className="flex justify-between py-1 border-b border-[#33467c]/30">
              <kbd>{cmd.display || cmd.hotkey}</kbd>
              <span>{cmd.label}</span>
            </div>
          ))}
        </div>
      )
    })}
  )
}
```

## Migration Plan

### Phase 1: Foundation (no behavior change)

1. `cd web && bun add @tanstack/hotkeys @tanstack/react-hotkeys`
2. Create `web/src/lib/command-registry.ts` - types, Map, register/execute/query functions
3. Create `web/src/lib/command-context.ts` - ctx helpers
4. Create `web/src/lib/commands/` with per-category files:
   - `session-commands.ts`, `view-commands.ts`, `navigation-commands.ts`
   - `terminal-commands.ts`, `tools-commands.ts`
   - `index.ts` (side-effect imports all)
5. Add `HotkeysProvider` in app.tsx, call `activateKeybindings()` in Dashboard

### Phase 2: Migrate existing shortcuts

Remove manual `addEventListener` handlers one component at a time:

1. **app.tsx** - Remove `useEffect` with `handleKeyDown` (Mod+K, Mod+O, Mod+Shift+T)
2. **shortcut-help.tsx** - Replace hardcoded arrays with `getAllKeybindings()`
3. **quick-note-modal.tsx** - Remove keyboard handler, keep `open-quick-note` custom event for mobile
4. **web-terminal.tsx** - Remove keyboard handler for Ctrl+Shift+Q and Ctrl+,
5. **markdown-input.tsx** - Readline bindings stay as local `onKeyDown` (textarea-specific)

### Phase 3: Command palette (`>` mode)

1. Add `>` detection in `session-switcher.tsx`
2. Import registry query functions
3. Render command list with disabled state, shortcut hints, sub-prompt support
4. Update placeholder: `'Switch session... (F: files, S: spawn, > commands)'`

### Phase 4: New commands + polish

1. Add `Mod+]` / `Mod+[` for next/prev session
2. Add `Mod+1` through `Mod+6` for tab switching
3. Add `Mod+Shift+C` for copy transcript
4. Consider `@tanstack/react-hotkeys-devtools` for dev builds

## File Structure

```
web/src/lib/
  command-registry.ts       # Map, types, register/execute/query, keybinding activation
  command-context.ts        # ctx.hasSession(), ctx.sessionIsActive(), etc.
  commands/
    index.ts                # side-effect imports all command files
    session-commands.ts     # session.* commands + keybindings
    view-commands.ts        # view.* commands + keybindings
    navigation-commands.ts  # nav.* commands + keybindings
    terminal-commands.ts    # terminal.* commands + keybindings
    tools-commands.ts       # tools.* commands + keybindings
```

## Open Questions

1. **Terminal-scoped shortcuts** - `Mod+Shift+Q` and `Mod+,` only make sense when terminal is open. Register globally with `when: () => ctx.terminalOpen()`, or keep as local handlers? Leaning global + when clause so they show in help screen.

2. **`Mod` display** - Should help screen show `Ctrl+K` on Linux/Windows and `Cmd+K` on macOS? TanStack can detect platform. Low effort, nice polish.

3. **Command history** - Should recently used commands float to top of `>` list? Nice UX but adds localStorage state. Deferred to v2.

4. **Dynamic commands** - Should components register commands at mount time (e.g., file editor registers "Save File")? Current design avoids this - register everything upfront, gate with `isEnabled`. Simpler, no cleanup needed.

5. **xterm passthrough** - `Mod+K` must be intercepted before xterm sends it to PTY. Current `attachCustomKeyEventHandler` approach should work with `isRegisteredHotkey(e)` check, but needs testing.

6. **Tab number shortcuts** - `Mod+1` through `Mod+6` for tabs vs `Mod+1`..`Mod+9` for sessions? Tabs makes more sense since session switching has Ctrl+K fuzzy finder.

7. **Devtools** - `@tanstack/react-hotkeys-devtools` shows all registered hotkeys and fire counts. Free to add for dev builds.
