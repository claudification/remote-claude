import { Save } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSessionsStore, wsSend } from '@/hooks/use-sessions'
import { resolveToolDisplay, type SettingsTab, TOOL_DISPLAY_KEYS } from '@/lib/control-panel-prefs'
import { extractProjectLabel } from '@/lib/types'
import { clearCacheAndReload } from '@/lib/utils'
import { BUILD_VERSION } from '../../../src/shared/version'
import { KeyCapture } from './settings/key-capture'
import { NotificationsSection } from './settings/notifications-section'
import { ProjectLinksSection } from './settings/session-links-section'
import {
  BubbleColorPicker,
  ColorInput,
  GroupHeader,
  ServerIcon,
  SettingRow,
  SizePicker,
} from './settings/settings-inputs'
import { SettingsShell, type SettingsShellTab } from './settings/settings-shell'

// --- Default session picker ---
function DefaultSessionPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const sessions = useSessionsStore(s => s.sessions)
  const projectSettings = useSessionsStore(s => s.projectSettings)
  // Unique projects by project URI
  const options = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of sessions) {
      if (s.project && !seen.has(s.project)) {
        seen.set(s.project, projectSettings[s.project]?.label || extractProjectLabel(s.project) || s.project)
      }
    }
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [sessions, projectSettings])

  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-44 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground"
    >
      <option value="">None</option>
      {options.map(([uri, label]) => (
        <option key={uri} value={uri}>
          {label}
        </option>
      ))}
    </select>
  )
}

// --- Shortcuts (inline) ---
const SHORTCUTS = [
  ['Command palette', 'Ctrl+K'],
  ['Toggle sidebar', 'Ctrl+B'],
  ['Toggle verbose', 'Ctrl+O'],
  ['Quick note', 'Ctrl+Shift+N'],
  ['Open NOTES.md', 'Ctrl+Shift+Alt+N'],
  ['Toggle terminal', 'Ctrl+Shift+T'],
  ['Debug console', 'Ctrl+Shift+D'],
  ['Shortcut help', 'Shift+?'],
  ['Go home / focus input', 'Escape'],
]

// --- Main settings content ---

interface SettingItem {
  tab: SettingsTab
  group: string
  label: string
  description: string
  server?: boolean
  keywords?: string // extra search terms
  render: (ctx: SettingsContext) => React.ReactNode
}

const DASHBOARD_TABS: SettingsShellTab[] = [
  { id: 'general', label: 'General' },
  { id: 'display', label: 'Display' },
  { id: 'input', label: 'Input' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'system', label: 'System' },
]

interface SettingsContext {
  // Server settings (local draft state)
  server: Record<string, unknown>
  setServer: (key: string, value: unknown) => void
  // Client prefs
  prefs: ReturnType<typeof useSessionsStore.getState>['controlPanelPrefs']
  updatePrefs: ReturnType<typeof useSessionsStore.getState>['updateControlPanelPrefs']
}

const SETTINGS: SettingItem[] = [
  // --- General ---
  {
    tab: 'general',
    group: 'General',
    label: 'User label',
    description: 'Tag shown next to user messages',
    server: true,
    keywords: 'tag name',
    render: ctx => (
      <input
        type="text"
        maxLength={20}
        value={(ctx.server.userLabel as string) ?? ''}
        placeholder="USER"
        onChange={e => ctx.setServer('userLabel', e.target.value)}
        className="w-28 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground text-right placeholder:text-muted-foreground/40"
      />
    ),
  },
  {
    tab: 'general',
    group: 'General',
    label: 'User tag size',
    description: 'Size of the user label badge',
    server: true,
    render: ctx => (
      <SizePicker value={(ctx.server.userSize as string) ?? ''} onChange={v => ctx.setServer('userSize', v)} />
    ),
  },
  {
    tab: 'general',
    group: 'General',
    label: 'User tag color',
    description: 'Background color for user label',
    server: true,
    keywords: 'colour background',
    render: ctx => (
      <div className="w-full">
        <ColorInput
          value={(ctx.server.userColor as string) ?? ''}
          onChange={v => ctx.setServer('userColor', v)}
          defaultColor="rgba(234,179,8,1)"
        />
      </div>
    ),
  },
  {
    tab: 'general',
    group: 'General',
    label: 'Agent label',
    description: 'Tag shown next to agent messages',
    server: true,
    keywords: 'tag name',
    render: ctx => (
      <input
        type="text"
        maxLength={20}
        value={(ctx.server.agentLabel as string) ?? ''}
        placeholder="AGENT"
        onChange={e => ctx.setServer('agentLabel', e.target.value)}
        className="w-28 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground text-right placeholder:text-muted-foreground/40"
      />
    ),
  },
  {
    tab: 'general',
    group: 'General',
    label: 'Agent tag size',
    description: 'Size of the agent label badge',
    server: true,
    render: ctx => (
      <SizePicker value={(ctx.server.agentSize as string) ?? ''} onChange={v => ctx.setServer('agentSize', v)} />
    ),
  },
  {
    tab: 'general',
    group: 'General',
    label: 'Agent tag color',
    description: 'Background color for agent label',
    server: true,
    keywords: 'colour background',
    render: ctx => (
      <div className="w-full">
        <ColorInput
          value={(ctx.server.agentColor as string) ?? ''}
          onChange={v => ctx.setServer('agentColor', v)}
          defaultColor="rgba(168,85,247,1)"
        />
      </div>
    ),
  },
  {
    tab: 'general',
    group: 'General',
    label: 'Default session',
    description: 'Auto-select this project when opening the dashboard (per-device)',
    keywords: 'startup auto select home',
    render: ctx => (
      <DefaultSessionPicker
        value={ctx.prefs.defaultSessionCwd ?? ''}
        onChange={v => ctx.updatePrefs({ defaultSessionCwd: v })}
      />
    ),
  },
  // --- Display ---
  {
    tab: 'general',
    group: 'General',
    label: 'Default view',
    description: 'What to show when selecting a session (per-device)',
    keywords: 'terminal tty transcript',
    render: ctx => (
      <select
        value={ctx.prefs.defaultView ?? 'transcript'}
        onChange={e => ctx.updatePrefs({ defaultView: e.target.value as 'transcript' | 'tty' })}
        className="bg-muted border border-border text-foreground text-xs px-2 py-1 font-mono"
      >
        <option value="transcript">Transcript</option>
        <option value="tty">TTY</option>
      </select>
    ),
  },
  // --- Input ---
  {
    tab: 'input',
    group: 'Input',
    label: 'Editor backend',
    description: 'Legacy textarea (default) or CodeMirror (experimental, better markdown rendering)',
    keywords: 'codemirror editor markdown input experimental',
    render: ctx => (
      <select
        value={ctx.prefs.inputBackend ?? 'legacy'}
        onChange={e => ctx.updatePrefs({ inputBackend: e.target.value as 'legacy' | 'codemirror' })}
        className="bg-muted border border-border text-foreground text-xs px-2 py-1 font-mono"
      >
        <option value="legacy">Legacy (textarea)</option>
        <option value="codemirror">CodeMirror (experimental)</option>
      </select>
    ),
  },
  {
    tab: 'input',
    group: 'Input',
    label: 'CR delay',
    description: 'Delay (ms) before carriage return after paste (0 = auto)',
    server: true,
    keywords: 'carriage return paste delay',
    render: ctx => (
      <input
        type="number"
        min={0}
        max={2000}
        step={50}
        value={(ctx.server.carriageReturnDelay as number) ?? 0}
        onChange={e => ctx.setServer('carriageReturnDelay', Math.max(0, Number(e.target.value) || 0))}
        className="w-20 bg-muted border border-border px-2 py-1 text-xs font-mono text-foreground text-right"
      />
    ),
  },
  {
    tab: 'input',
    group: 'Input',
    label: 'Voice input',
    description: 'Show microphone button in input bar',
    keywords: 'mic microphone',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.showVoiceInput}
        onChange={e => ctx.updatePrefs({ showVoiceInput: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'input',
    group: 'Input',
    label: 'Voice FAB (touch)',
    description: 'Floating hold-to-record button on touch devices',
    keywords: 'mic microphone fab',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.showVoiceFab}
        onChange={e => ctx.updatePrefs({ showVoiceFab: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'input',
    group: 'Input',
    label: 'Push-to-talk key',
    description: 'Hold a key to record voice input (desktop)',
    keywords: 'voice key hotkey ptt mic keyboard',
    render: ctx => (
      <KeyCapture value={ctx.prefs.voiceHoldKey} onChange={code => ctx.updatePrefs({ voiceHoldKey: code })} />
    ),
  },
  {
    tab: 'input',
    group: 'Input',
    label: 'Keep mic open',
    description: 'Keep microphone stream alive permanently to eliminate cold-start latency',
    keywords: 'voice mic latency warm always connected',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.keepMicOpen}
        onChange={e => ctx.updatePrefs({ keepMicOpen: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  // --- Voice ---
  {
    tab: 'input',
    group: 'Voice',
    label: 'LLM refinement',
    description: 'Post-process voice transcripts with Haiku to fix ASR errors',
    server: true,
    keywords: 'speech recognition',
    render: ctx => (
      <input
        type="checkbox"
        checked={(ctx.server.voiceRefinement as boolean) ?? true}
        onChange={e => ctx.setServer('voiceRefinement', e.target.checked)}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'input',
    group: 'Voice',
    label: 'Refinement prompt',
    description: 'Custom system prompt for voice refinement (leave empty for default)',
    server: true,
    keywords: 'speech recognition prompt',
    render: ctx => (
      <div className="w-full">
        <textarea
          value={(ctx.server.voiceRefinementPrompt as string) ?? ''}
          onChange={e => ctx.setServer('voiceRefinementPrompt', e.target.value)}
          placeholder="You are an expert ASR post-processor..."
          rows={4}
          className="w-full px-3 py-2 text-xs font-mono bg-muted border border-border text-foreground placeholder:text-muted-foreground/30 resize-y min-h-[60px]"
        />
        <div className="text-[9px] text-muted-foreground/50 text-right mt-0.5">
          {((ctx.server.voiceRefinementPrompt as string) ?? '').length}/2000
        </div>
      </div>
    ),
  },
  // --- Display ---
  {
    tab: 'display',
    group: 'Display',
    label: 'Show ended sessions',
    description: 'Show [ENDED] sessions within CWD groups in sidebar',
    keywords: 'sidebar ended filter',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.showEndedSessions}
        onChange={e => ctx.updatePrefs({ showEndedSessions: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'display',
    group: 'Display',
    label: 'Show inactive projects',
    description: 'Show projects with only ended sessions at bottom of sidebar',
    keywords: 'sidebar inactive',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.showInactiveByDefault}
        onChange={e => ctx.updatePrefs({ showInactiveByDefault: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'display',
    group: 'Display',
    label: 'Compact mode',
    description: 'Reduce spacing in session list',
    keywords: 'dense',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.compactMode}
        onChange={e => ctx.updatePrefs({ compactMode: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'display',
    group: 'Display',
    label: 'Show thinking',
    description: 'Display model thinking blocks in transcript',
    keywords: 'reasoning',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.showThinking}
        onChange={e => ctx.updatePrefs({ showThinking: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'system',
    group: 'Performance',
    label: 'Session cache size',
    description: 'Keep N recent sessions in memory for instant switching (0 = disabled)',
    keywords: 'cache lifo mru fast switch',
    render: ctx => (
      <input
        type="number"
        min={0}
        max={10}
        value={ctx.prefs.sessionCacheSize}
        onChange={e => ctx.updatePrefs({ sessionCacheSize: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })}
        className="w-16 bg-muted border border-border rounded px-2 py-1 text-xs"
      />
    ),
  },
  {
    tab: 'system',
    group: 'Performance',
    label: 'Cache timeout (min)',
    description: 'Evict cached non-selected sessions after N minutes (0 = never)',
    keywords: 'cache timeout evict memory',
    render: ctx => (
      <input
        type="number"
        min={0}
        max={60}
        value={ctx.prefs.sessionCacheTimeout}
        onChange={e => ctx.updatePrefs({ sessionCacheTimeout: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })}
        className="w-16 bg-muted border border-border rounded px-2 py-1 text-xs"
      />
    ),
  },
  {
    tab: 'system',
    group: 'Keyboard',
    label: 'Chord timeout (s)',
    description: 'How long to wait for second chord key (⌘K … / ⌘G …) before dismissing',
    keywords: 'chord shortcut keyboard timeout cmd+k cmd+g',
    render: ctx => (
      <input
        type="number"
        min={0.5}
        max={10}
        step={0.5}
        value={(ctx.prefs.chordTimeoutMs ?? 3000) / 1000}
        onChange={e =>
          ctx.updatePrefs({ chordTimeoutMs: Math.max(500, Math.min(10000, Math.round(Number(e.target.value) * 1000))) })
        }
        className="w-16 bg-muted border border-border rounded px-2 py-1 text-xs"
      />
    ),
  },
  {
    tab: 'display',
    group: 'Display',
    label: 'Chat bubbles',
    description: 'iMessage-style bubbles for user messages',
    keywords: 'bubble imessage chat style',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.chatBubbles}
        onChange={e => ctx.updatePrefs({ chatBubbles: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'display',
    group: 'Display',
    label: 'Bubble color',
    description: 'Color for user chat bubbles',
    keywords: 'bubble color theme',
    render: ctx => (
      <BubbleColorPicker value={ctx.prefs.chatBubbleColor} onChange={c => ctx.updatePrefs({ chatBubbleColor: c })} />
    ),
  },
  {
    tab: 'display',
    group: 'Display',
    label: 'Context bar in sidebar',
    description: 'Show context window usage on session cards',
    keywords: 'tokens progress percentage',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.showContextInList}
        onChange={e => ctx.updatePrefs({ showContextInList: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'display',
    group: 'Display',
    label: 'Cost in sidebar',
    description: 'Show session cost badges on session cards',
    keywords: 'cost money dollars pricing',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.showCostInList}
        onChange={e => ctx.updatePrefs({ showCostInList: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'display',
    group: 'Display',
    label: 'WS traffic stats',
    description: 'Show msg/s and KB/s in header bar',
    keywords: 'websocket bandwidth',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.showWsStats}
        onChange={e => ctx.updatePrefs({ showWsStats: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'system',
    group: 'Performance',
    label: 'Clear cache & reload',
    description: 'Wipe service worker cache and reload the dashboard',
    keywords: 'cache clear reload service worker sw',
    render: () => (
      <button
        type="button"
        onClick={() => clearCacheAndReload()}
        className="px-3 py-1 text-[11px] font-bold bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30 transition-colors"
      >
        Clear & Reload
      </button>
    ),
  },
  {
    tab: 'system',
    group: 'Debug',
    label: 'Show Diag tab',
    description: 'Show the Diag tab in session detail (debug info)',
    keywords: 'diagnostics debug',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.showDiag}
        onChange={e => ctx.updatePrefs({ showDiag: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'system',
    group: 'Developer',
    label: 'Performance monitor',
    description: 'Track render times, grouping cost, WS processing. View in nerd modal Perf tab',
    keywords: 'performance profiler perf monitor render',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.showPerfMonitor}
        onChange={e => ctx.updatePrefs({ showPerfMonitor: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'sessions',
    group: 'Sessions',
    label: 'Default launch mode',
    description: 'Default mode when spawning/reviving sessions (per-project overrides this)',
    keywords: 'headless pty terminal launch mode spawn',
    render: ctx => (
      <select
        value={(ctx.server.defaultLaunchMode as string) || 'headless'}
        onChange={e => ctx.setServer('defaultLaunchMode', e.target.value)}
        className="bg-muted border border-border px-2 py-1 text-xs font-mono text-foreground"
      >
        <option value="headless">Headless</option>
        <option value="pty">PTY (terminal)</option>
      </select>
    ),
  },
  {
    tab: 'sessions',
    group: 'Sessions',
    label: 'Default effort',
    description: 'Default --effort level for new sessions (per-project overrides this)',
    keywords: 'effort thinking budget low medium high xhigh max',
    render: ctx => (
      <select
        value={(ctx.server.defaultEffort as string) || 'default'}
        onChange={e => ctx.setServer('defaultEffort', e.target.value)}
        className="bg-muted border border-border px-2 py-1 text-xs font-mono text-foreground"
      >
        <option value="default">Default (no flag)</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="xhigh">XHigh (Opus 4.7)</option>
        <option value="max">Max</option>
      </select>
    ),
  },
  {
    tab: 'sessions',
    group: 'Sessions',
    label: 'Default model',
    description: 'Default --model for new sessions (per-project overrides this)',
    keywords: 'model opus sonnet haiku claude',
    render: ctx => (
      <input
        type="text"
        value={(ctx.server.defaultModel as string) || ''}
        onChange={e => ctx.setServer('defaultModel', e.target.value)}
        placeholder="e.g. sonnet, opus"
        className="bg-muted border border-border px-2 py-1 text-xs font-mono text-foreground w-40 placeholder:text-muted-foreground/50"
      />
    ),
  },
  {
    tab: 'display',
    group: 'Display',
    label: 'Show streaming',
    description: 'Show token-by-token streaming block for headless sessions',
    keywords: 'streaming tokens live headless',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.showStreaming !== false}
        onChange={e => ctx.updatePrefs({ showStreaming: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
  {
    tab: 'display',
    group: 'Display',
    label: 'Sanitize paths',
    description: 'Strip redundant cd <path> prefixes from displayed commands',
    keywords: 'sanitize paths cd path clean strip',
    render: ctx => (
      <input
        type="checkbox"
        checked={ctx.prefs.sanitizePaths !== false}
        onChange={e => ctx.updatePrefs({ sanitizePaths: e.target.checked })}
        className="accent-primary w-4 h-4"
      />
    ),
  },
]

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [filter, setFilter] = useState('')
  const globalSettings = useSessionsStore(s => s.globalSettings)
  const prefs = useSessionsStore(s => s.controlPanelPrefs)
  const updatePrefs = useSessionsStore(s => s.updateControlPanelPrefs)

  // Local draft of server settings (only committed on Save)
  const [serverDraft, setServerDraft] = useState<Record<string, unknown>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const filterRef = useRef<HTMLInputElement>(null)

  // Sync draft from server on open or when globalSettings change
  useEffect(() => {
    setServerDraft({ ...globalSettings })
    setDirty(false)
  }, [globalSettings])

  function setServer(key: string, value: unknown) {
    setServerDraft(prev => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  function handleSave() {
    setSaving(true)
    const sent = wsSend('update_settings', { settings: serverDraft })
    if (sent) setDirty(false)
    setSaving(false)
  }

  const ctx: SettingsContext = {
    server: serverDraft,
    setServer,
    prefs,
    updatePrefs,
  }

  // Filter settings (flat view; tabs hidden when filter is active)
  const lowerFilter = filter.toLowerCase()
  const isFiltering = lowerFilter.length > 0
  const filtered = useMemo(() => {
    if (!lowerFilter) return SETTINGS
    return SETTINGS.filter(
      s =>
        s.label.toLowerCase().includes(lowerFilter) ||
        s.description.toLowerCase().includes(lowerFilter) ||
        s.group.toLowerCase().includes(lowerFilter) ||
        s.keywords?.toLowerCase().includes(lowerFilter),
    )
  }, [lowerFilter])

  const activeTab: SettingsTab = (prefs.settingsTab ?? 'general') as SettingsTab
  const visibleItems = isFiltering ? filtered : SETTINGS.filter(s => s.tab === activeTab)

  // Group visible settings for rendering (preserves in-tab sub-group headers)
  const groups = useMemo(() => {
    const map = new Map<string, SettingItem[]>()
    for (const item of visibleItems) {
      const existing = map.get(item.group)
      if (existing) existing.push(item)
      else map.set(item.group, [item])
    }
    return map
  }, [visibleItems])

  // Focus filter on open
  useEffect(() => {
    if (open) setTimeout(() => filterRef.current?.focus(), 50)
  }, [open])

  const buildDate = BUILD_VERSION.buildTime
    ? new Date(BUILD_VERSION.buildTime).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        hour12: false,
      })
    : 'unknown'

  return (
    <SettingsShell
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      tabs={DASHBOARD_TABS}
      activeTab={activeTab}
      onTabChange={v => updatePrefs({ settingsTab: v as SettingsTab })}
      showTabs={!isFiltering}
      headerContent={
        <input
          ref={filterRef}
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter settings..."
          className="w-full px-3 py-1.5 text-xs font-mono bg-muted border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-ring"
        />
      }
      footer={
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono border transition-colors ${
              dirty
                ? 'border-active/50 text-active hover:bg-active/20'
                : 'border-border text-muted-foreground/40 cursor-not-allowed'
            }`}
          >
            <Save className="w-3 h-3" />
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      }
    >
      {Array.from(groups.entries()).map(([group, items]) => (
        <div key={group}>
          <GroupHeader label={group} />
          <div className="space-y-3">
            {items.map(item => {
              const rendered = item.render(ctx)
              // Full-width items (color pickers, textareas) get stacked layout
              const isFullWidth =
                item.label.includes('color') || item.label.includes('Color') || item.label === 'Refinement prompt'
              if (isFullWidth) {
                return (
                  <div key={item.label}>
                    <div className="flex items-start gap-1.5 mb-1">
                      {item.server && <ServerIcon />}
                      <div>
                        <div className="text-sm text-foreground">{item.label}</div>
                        <div className="text-[10px] text-muted-foreground">{item.description}</div>
                      </div>
                    </div>
                    {rendered}
                  </div>
                )
              }
              return (
                <SettingRow key={item.label} label={item.label} description={item.description} server={item.server}>
                  {rendered}
                </SettingRow>
              )
            })}
          </div>
        </div>
      ))}

      {/* Tool output -- pinned to Sessions tab; filter-matches override */}
      {(isFiltering
        ? 'tool output verbose'.includes(lowerFilter) ||
          TOOL_DISPLAY_KEYS.some(t => t.toLowerCase().includes(lowerFilter))
        : activeTab === 'sessions') && (
        <div>
          <GroupHeader label="Tool output" />
          <div className="space-y-1">
            {TOOL_DISPLAY_KEYS.filter(
              t => !lowerFilter || t.toLowerCase().includes(lowerFilter) || 'tool output verbose'.includes(lowerFilter),
            ).map(tool => {
              const effective = resolveToolDisplay(prefs, tool)
              const custom = prefs.toolDisplay?.[tool]
              return (
                <div key={tool} className="flex items-center gap-2 text-xs font-mono">
                  <span className="w-20 text-muted-foreground truncate">{tool}</span>
                  <button
                    type="button"
                    onClick={() => {
                      const td = { ...prefs.toolDisplay }
                      td[tool] = { ...td[tool], defaultOpen: !effective.defaultOpen }
                      updatePrefs({ toolDisplay: td })
                    }}
                    className={`px-1.5 py-0.5 text-[9px] border transition-colors ${
                      effective.defaultOpen
                        ? 'border-active/50 text-active bg-active/10'
                        : 'border-border text-muted-foreground'
                    }`}
                    title="Default expanded in verbose mode"
                  >
                    {effective.defaultOpen ? 'open' : 'closed'}
                  </button>
                  <select
                    value={effective.lineLimit}
                    onChange={e => {
                      const td = { ...prefs.toolDisplay }
                      td[tool] = { ...td[tool], lineLimit: Number(e.target.value) }
                      updatePrefs({ toolDisplay: td })
                    }}
                    className="bg-card border border-border text-foreground text-[10px] px-1 py-0.5"
                    title="Line truncation limit (0 = no limit)"
                  >
                    {[0, 5, 10, 15, 20, 30, 50, 100].map(n => (
                      <option key={n} value={n}>
                        {n === 0 ? 'all' : `${n}L`}
                      </option>
                    ))}
                  </select>
                  {custom && (
                    <button
                      type="button"
                      onClick={() => {
                        const td = { ...prefs.toolDisplay }
                        delete td[tool]
                        updatePrefs({ toolDisplay: td })
                      }}
                      className="text-[8px] text-muted-foreground hover:text-foreground"
                      title="Reset to default"
                    >
                      x
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Project Links -- pinned to System tab */}
      {(isFiltering ? 'links project connect persist'.includes(lowerFilter) : activeTab === 'system') && (
        <div>
          <GroupHeader label="Project Links" />
          <ProjectLinksSection />
        </div>
      )}

      {/* Notifications -- pinned to System tab */}
      {(isFiltering ? 'notifications push notify bell'.includes(lowerFilter) : activeTab === 'system') && (
        <div>
          <GroupHeader label="Notifications" />
          <NotificationsSection />
        </div>
      )}

      {/* Shortcuts -- pinned to System tab */}
      {(isFiltering
        ? 'shortcuts keyboard keys hotkey'.includes(lowerFilter) ||
          SHORTCUTS.some(([n, k]) => n.toLowerCase().includes(lowerFilter) || k.toLowerCase().includes(lowerFilter))
        : activeTab === 'system') && (
        <div>
          <GroupHeader label="Shortcuts" />
          <div className="space-y-1.5">
            {SHORTCUTS.filter(
              ([n, k]) =>
                !lowerFilter ||
                n.toLowerCase().includes(lowerFilter) ||
                k.toLowerCase().includes(lowerFilter) ||
                'shortcuts keyboard keys hotkey'.includes(lowerFilter),
            ).map(([name, key]) => (
              <div key={name} className="flex justify-between text-xs">
                <span className="text-muted-foreground">{name}</span>
                <kbd className="px-1.5 py-0.5 bg-muted text-muted-foreground border border-border text-[10px] font-mono">
                  {key}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Version -- pinned to System tab */}
      {(isFiltering ? 'version build commit'.includes(lowerFilter) : activeTab === 'system') && (
        <div>
          <GroupHeader label="Version" />
          <div className="space-y-2 font-mono text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">commit</span>
              <span className="text-active">{BUILD_VERSION.gitHashShort}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">built</span>
              <span>{buildDate}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">dirty</span>
              <span>{BUILD_VERSION.dirty ? 'yes' : 'no'}</span>
            </div>
            {BUILD_VERSION.recentCommits?.length > 0 && (
              <div className="border-t border-border pt-2">
                <div className="text-muted-foreground mb-1.5 uppercase tracking-wider text-[10px]">Recent commits</div>
                <div className="space-y-1">
                  {BUILD_VERSION.recentCommits.map(c => (
                    <div key={c.hash} className="flex gap-2">
                      <span className="text-active shrink-0">{c.hash}</span>
                      <span className="text-foreground/70 truncate">{c.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </SettingsShell>
  )
}
