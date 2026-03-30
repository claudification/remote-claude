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
  'MCP',
] as const
export type ToolDisplayKey = (typeof TOOL_DISPLAY_KEYS)[number]

export const DEFAULT_TOOL_DISPLAY: Record<ToolDisplayKey, ToolDisplayPrefs> = {
  Bash: { defaultOpen: false, lineLimit: 10 },
  Read: { defaultOpen: false, lineLimit: 10 },
  Write: { defaultOpen: true, lineLimit: 10 },
  Edit: { defaultOpen: true, lineLimit: 0 },
  Grep: { defaultOpen: false, lineLimit: 10 },
  Glob: { defaultOpen: false, lineLimit: 10 },
  WebSearch: { defaultOpen: false, lineLimit: 15 },
  WebFetch: { defaultOpen: false, lineLimit: 15 },
  Agent: { defaultOpen: false, lineLimit: 0 },
  MCP: { defaultOpen: false, lineLimit: 15 },
}

export interface DashboardPrefs {
  showInactiveByDefault: boolean
  compactMode: boolean
  showVoiceInput: boolean
  showVoiceFab: boolean
  showWsStats: boolean
  showThinking: boolean
  showContextInList: boolean
  chatBubbles: boolean
  sessionCacheSize: number // LIFO cache: 0 = disabled, N = keep N recent sessions in memory
  sessionCacheTimeout: number // minutes before cached non-selected sessions are evicted (0 = never)
  defaultView: 'transcript' | 'tty'
  toolDisplay: Partial<Record<ToolDisplayKey, Partial<ToolDisplayPrefs>>>
}

export const defaultPrefs: DashboardPrefs = {
  showInactiveByDefault: false,
  compactMode: false,
  showVoiceInput: true,
  showVoiceFab: false,
  showWsStats: false,
  showThinking: false,
  showContextInList: true,
  chatBubbles: true,
  sessionCacheSize: 3,
  sessionCacheTimeout: 10,
  defaultView: 'transcript',
  toolDisplay: {},
}

export function loadPrefs(): DashboardPrefs {
  try {
    const raw = localStorage.getItem('dashboard-prefs')
    if (raw) return { ...defaultPrefs, ...JSON.parse(raw) }
  } catch {}
  return defaultPrefs
}

export function resolveToolDisplay(prefs: DashboardPrefs, tool: ToolDisplayKey): ToolDisplayPrefs {
  const custom = prefs.toolDisplay?.[tool]
  const defaults = DEFAULT_TOOL_DISPLAY[tool] || { defaultOpen: false, lineLimit: 10 }
  return { ...defaults, ...custom }
}
