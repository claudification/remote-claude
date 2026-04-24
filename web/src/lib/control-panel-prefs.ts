export interface ToolDisplayPrefs {
  defaultOpen: boolean
  lineLimit: number
}

// Tools that have meaningful output to display
export const TOOL_DISPLAY_KEYS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'Agent',
  'REPL',
  'MCP',
] as const
export type ToolDisplayKey = (typeof TOOL_DISPLAY_KEYS)[number]

const DEFAULT_TOOL_DISPLAY: Record<ToolDisplayKey, ToolDisplayPrefs> = {
  Bash: { defaultOpen: false, lineLimit: 10 },
  Read: { defaultOpen: false, lineLimit: 10 },
  Write: { defaultOpen: true, lineLimit: 10 },
  Edit: { defaultOpen: true, lineLimit: 0 },
  Grep: { defaultOpen: false, lineLimit: 10 },
  Glob: { defaultOpen: false, lineLimit: 10 },
  WebSearch: { defaultOpen: false, lineLimit: 15 },
  WebFetch: { defaultOpen: false, lineLimit: 15 },
  Agent: { defaultOpen: false, lineLimit: 0 },
  REPL: { defaultOpen: false, lineLimit: 20 },
  MCP: { defaultOpen: false, lineLimit: 15 },
}

export interface ControlPanelPrefs {
  showEndedSessions: boolean // show [ENDED] sessions within CWD groups (organized + unorganized)
  showInactiveByDefault: boolean
  compactMode: boolean
  showVoiceInput: boolean
  showVoiceFab: boolean
  showWsStats: boolean
  showThinking: boolean
  showContextInList: boolean
  showCostInList: boolean
  chatBubbles: boolean
  sessionCacheSize: number // LIFO cache: 0 = disabled, N = keep N recent sessions in memory
  sessionCacheTimeout: number // minutes before cached non-selected sessions are evicted (0 = never)
  defaultView: 'transcript' | 'tty'
  voiceHoldKey: string | null // KeyboardEvent.code for push-to-talk (e.g. 'F13', 'ScrollLock')
  keepMicOpen: boolean // keep mic stream alive permanently (eliminates cold-start latency)
  chatBubbleColor: string // tailwind color class prefix (e.g. 'blue', 'teal', 'purple')
  defaultSessionCwd: string // auto-select this project on dashboard load (per-device)
  showDiag: boolean
  showStreaming: boolean
  showPerfMonitor: boolean
  toolDisplay: Partial<Record<ToolDisplayKey, Partial<ToolDisplayPrefs>>>
  chordTimeoutMs: number // how long to wait for second chord key before dismissing (ms)
  sanitizePaths: boolean // strip redundant `cd <project-path> &&` prefixes from displayed commands
  inputBackend: 'legacy' | 'codemirror' // editor backend for InputEditor (default legacy)
  settingsTab: SettingsTab // last active settings tab (per-device)
}

export type SettingsTab = 'general' | 'display' | 'input' | 'sessions' | 'sentinels' | 'system'

const defaultPrefs: ControlPanelPrefs = {
  showEndedSessions: true,
  showInactiveByDefault: false,
  compactMode: false,
  showVoiceInput: true,
  showVoiceFab: false,
  showWsStats: false,
  showThinking: false,
  showContextInList: true,
  showCostInList: false,
  chatBubbles: true,
  sessionCacheSize: 3,
  sessionCacheTimeout: 10,
  defaultView: 'transcript',
  voiceHoldKey: null,
  keepMicOpen: false,
  chatBubbleColor: 'blue',
  showDiag: false,
  showStreaming: true,
  showPerfMonitor: false,
  defaultSessionCwd: '',
  toolDisplay: {},
  chordTimeoutMs: 3000,
  sanitizePaths: true,
  inputBackend: 'legacy',
  settingsTab: 'general',
}

export function loadPrefs(): ControlPanelPrefs {
  try {
    const raw = localStorage.getItem('control-panel-prefs')
    if (raw) return { ...defaultPrefs, ...JSON.parse(raw) }
  } catch {}
  return defaultPrefs
}

export function resolveToolDisplay(prefs: ControlPanelPrefs, tool: ToolDisplayKey): ToolDisplayPrefs {
  const custom = prefs.toolDisplay?.[tool]
  const defaults = DEFAULT_TOOL_DISPLAY[tool] || { defaultOpen: false, lineLimit: 10 }
  return { ...defaults, ...custom }
}
