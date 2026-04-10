import { Bell, BellOff, Cloud, Save } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { getPushStatus, subscribeToPush, useSessionsStore, wsSend } from '@/hooks/use-sessions'
import { resolveToolDisplay, TOOL_DISPLAY_KEYS } from '@/lib/dashboard-prefs'
import { clearCacheAndReload, cn } from '@/lib/utils'
import { BUILD_VERSION } from '../../../src/shared/version'
import { BUBBLE_COLOR_OPTIONS } from './transcript/group-view'

// --- Color input with live preview ---
const PALETTE = [
  '#f9a8d4',
  '#f472b6',
  '#c084fc',
  '#a78bfa',
  '#818cf8',
  '#60a5fa',
  '#38bdf8',
  '#22d3ee',
  '#2dd4bf',
  '#4ade80',
  '#a3e635',
  '#facc15',
  '#fbbf24',
  '#fb923c',
  '#f87171',
  '#e2e8f0',
]

const OPACITY_STEPS = [100, 85, 70, 50, 35, 20, 10, 0]

function hexToRgba(hex: string, opacity: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${(opacity / 100).toFixed(2)})`
}

function parseRgbaOpacity(rgba: string): number {
  const m = rgba.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/)
  return m ? Math.round(Number.parseFloat(m[1]) * 100) : 100
}

function parseRgbaHex(rgba: string): string | null {
  const m = rgba.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (!m) return null
  const toHex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${toHex(Number(m[1]))}${toHex(Number(m[2]))}${toHex(Number(m[3]))}`
}

function ColorInput({
  value,
  onChange,
  defaultColor,
}: {
  value: string
  onChange: (v: string) => void
  defaultColor: string
}) {
  const preview = value || defaultColor
  const currentHex = (value && parseRgbaHex(value)) || null
  const currentOpacity = value ? parseRgbaOpacity(value) : 100

  function pickColor(hex: string) {
    onChange(hexToRgba(hex, currentOpacity))
  }

  function pickOpacity(opacity: number) {
    const hex = currentHex || parseRgbaHex(defaultColor) || PALETTE[0]
    onChange(hexToRgba(hex, opacity))
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {PALETTE.map(hex => (
          <button
            key={hex}
            type="button"
            onClick={() => pickColor(hex)}
            className={`w-5 h-5 border transition-transform hover:scale-125 ${
              currentHex === hex ? 'border-white scale-110' : 'border-border/50'
            }`}
            style={{ backgroundColor: hex }}
            title={hex}
          />
        ))}
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[9px] text-muted-foreground w-8 shrink-0">alpha</span>
        <div className="flex gap-0.5 flex-1">
          {OPACITY_STEPS.map(op => (
            <button
              key={op}
              type="button"
              onClick={() => pickOpacity(op)}
              className={`flex-1 h-5 text-[8px] font-mono border transition-colors ${
                currentOpacity === op
                  ? 'border-white text-foreground'
                  : 'border-border/50 text-muted-foreground hover:border-border'
              }`}
              style={{ backgroundColor: hexToRgba(currentHex || parseRgbaHex(defaultColor) || PALETTE[0], op) }}
            >
              {op}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 border border-border shrink-0" style={{ backgroundColor: preview }} />
        <span className="text-[10px] font-mono text-muted-foreground flex-1 truncate">{value || defaultColor}</span>
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="text-[9px] text-muted-foreground hover:text-foreground shrink-0 border border-border px-1.5 py-0.5"
          >
            reset
          </button>
        )}
      </div>
    </div>
  )
}

const LABEL_SIZES = [
  { id: 'xs', label: 'XS' },
  { id: 'sm', label: 'S' },
  { id: '', label: 'M' },
  { id: 'lg', label: 'L' },
  { id: 'xl', label: 'XL' },
]

function SizePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-0.5">
      {LABEL_SIZES.map(s => (
        <button
          key={s.id}
          type="button"
          onClick={() => onChange(s.id)}
          className={`px-2 py-0.5 text-[9px] font-mono border transition-colors ${
            value === s.id
              ? 'border-white text-foreground bg-muted'
              : 'border-border/50 text-muted-foreground hover:border-border'
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  )
}

// --- Cloud icon for server settings ---
function ServerIcon() {
  return (
    <span title="Server setting (shared)">
      <Cloud className="w-3 h-3 text-blue-400/70 shrink-0" />
    </span>
  )
}

// --- Setting row wrapper ---
function SettingRow({
  label,
  description,
  server,
  children,
}: {
  label: string
  description: string
  server?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-start gap-1.5 min-w-0">
        {server && <ServerIcon />}
        <div className="min-w-0">
          <div className="text-sm text-foreground">{label}</div>
          <div className="text-[10px] text-muted-foreground">{description}</div>
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

// --- Group header ---
function GroupHeader({ label }: { label: string }) {
  return (
    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider pt-3 pb-1 border-t border-border first:border-t-0 first:pt-0">
      {label}
    </div>
  )
}

// --- Notifications (inline, not a separate tab) ---
function NotificationsSection() {
  const [pushState, setPushState] = useState<
    'loading' | 'unsupported' | 'prompt' | 'subscribing' | 'subscribed' | 'denied'
  >('loading')

  useEffect(() => {
    getPushStatus().then(status => {
      if (!status.supported) setPushState('unsupported')
      else if (status.subscribed) setPushState('subscribed')
      else if (status.permission === 'denied') setPushState('denied')
      else setPushState('prompt')
    })
  }, [])

  async function handlePushToggle() {
    if (pushState === 'subscribing') return
    setPushState('subscribing')
    const result = await subscribeToPush()
    setPushState(result.success ? 'subscribed' : 'denied')
  }

  async function handleReRegister() {
    if (pushState === 'subscribing') return
    setPushState('subscribing')
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js')
      if (reg) {
        const sub = await reg.pushManager.getSubscription()
        if (sub) await sub.unsubscribe()
      }
    } catch {}
    const result = await subscribeToPush()
    setPushState(result.success ? 'subscribed' : 'denied')
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-foreground">Push notifications</div>
          <div className="text-[10px] text-muted-foreground">Get notified when Claude needs input</div>
        </div>
        <button
          type="button"
          onClick={handlePushToggle}
          disabled={pushState === 'unsupported' || pushState === 'loading'}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border transition-colors ${
            pushState === 'subscribed'
              ? 'bg-active/20 text-active border-active/50'
              : pushState === 'denied'
                ? 'bg-red-400/20 text-red-400 border-red-400/50'
                : pushState === 'unsupported'
                  ? 'bg-muted text-muted-foreground border-border cursor-not-allowed'
                  : 'bg-transparent text-foreground border-border hover:border-primary'
          }`}
        >
          {pushState === 'subscribed' ? <Bell className="w-3 h-3" /> : <BellOff className="w-3 h-3" />}
          {pushState === 'loading' && '...'}
          {pushState === 'unsupported' && 'Not supported'}
          {pushState === 'subscribing' && 'Enabling...'}
          {pushState === 'subscribed' && 'Enabled'}
          {pushState === 'denied' && 'Denied'}
          {pushState === 'prompt' && 'Enable'}
        </button>
      </div>
      {pushState === 'subscribed' && (
        <button
          type="button"
          onClick={handleReRegister}
          className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
        >
          Re-register push (use after VAPID key change)
        </button>
      )}
    </div>
  )
}

// --- Default session picker ---
function DefaultSessionPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const sessions = useSessionsStore(s => s.sessions)
  const projectSettings = useSessionsStore(s => s.projectSettings)
  // Unique projects by CWD
  const options = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of sessions) {
      if (s.cwd && !seen.has(s.cwd)) {
        seen.set(s.cwd, projectSettings[s.cwd]?.label || s.cwd.split('/').pop() || s.cwd)
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
      {options.map(([cwd, label]) => (
        <option key={cwd} value={cwd}>
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
  group: string
  label: string
  description: string
  server?: boolean
  keywords?: string // extra search terms
  render: (ctx: SettingsContext) => React.ReactNode
}

interface SettingsContext {
  // Server settings (local draft state)
  server: Record<string, unknown>
  setServer: (key: string, value: unknown) => void
  // Client prefs
  prefs: ReturnType<typeof useSessionsStore.getState>['dashboardPrefs']
  updatePrefs: ReturnType<typeof useSessionsStore.getState>['updateDashboardPrefs']
}

const SETTINGS: SettingItem[] = [
  // --- General ---
  {
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
    group: 'General',
    label: 'User tag size',
    description: 'Size of the user label badge',
    server: true,
    render: ctx => (
      <SizePicker value={(ctx.server.userSize as string) ?? ''} onChange={v => ctx.setServer('userSize', v)} />
    ),
  },
  {
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
    group: 'General',
    label: 'Agent tag size',
    description: 'Size of the agent label badge',
    server: true,
    render: ctx => (
      <SizePicker value={(ctx.server.agentSize as string) ?? ''} onChange={v => ctx.setServer('agentSize', v)} />
    ),
  },
  {
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
    group: 'Display',
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
    group: 'Input',
    label: 'Push-to-talk key',
    description: 'Hold a key to record voice input (desktop)',
    keywords: 'voice key hotkey ptt mic keyboard',
    render: ctx => (
      <KeyCapture value={ctx.prefs.voiceHoldKey} onChange={code => ctx.updatePrefs({ voiceHoldKey: code })} />
    ),
  },
  // --- Voice ---
  {
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
    group: 'Display',
    label: 'Show inactive sessions',
    description: 'Show ended sessions in sidebar by default',
    keywords: 'sidebar ended',
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
    group: 'Display',
    label: 'Bubble color',
    description: 'Color for user chat bubbles',
    keywords: 'bubble color theme',
    render: ctx => (
      <BubbleColorPicker value={ctx.prefs.chatBubbleColor} onChange={c => ctx.updatePrefs({ chatBubbleColor: c })} />
    ),
  },
  {
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
    group: 'Sessions',
    label: 'Default effort',
    description: 'Default --effort level for new sessions (per-project overrides this)',
    keywords: 'effort thinking budget low medium high max',
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
        <option value="max">Max</option>
      </select>
    ),
  },
  {
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
]

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [filter, setFilter] = useState('')
  const globalSettings = useSessionsStore(s => s.globalSettings)
  const prefs = useSessionsStore(s => s.dashboardPrefs)
  const updatePrefs = useSessionsStore(s => s.updateDashboardPrefs)

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

  // Filter settings
  const lowerFilter = filter.toLowerCase()
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

  // Group filtered settings
  const groups = useMemo(() => {
    const map = new Map<string, SettingItem[]>()
    for (const item of filtered) {
      const existing = map.get(item.group)
      if (existing) existing.push(item)
      else map.set(item.group, [item])
    }
    return map
  }, [filtered])

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 gap-0 max-h-[85vh] overflow-hidden flex flex-col">
        <DialogTitle className="uppercase tracking-wider px-6 pt-6 pb-0">Settings</DialogTitle>

        {/* Filter input */}
        <div className="px-6 pt-4 pb-2">
          <input
            ref={filterRef}
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter settings..."
            className="w-full px-3 py-1.5 text-xs font-mono bg-muted border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-ring"
          />
        </div>

        {/* Scrollable settings list */}
        <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-3">
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

          {/* Tool output -- only show when not filtered or filter matches */}
          {(!lowerFilter ||
            'tool output verbose'.includes(lowerFilter) ||
            TOOL_DISPLAY_KEYS.some(t => t.toLowerCase().includes(lowerFilter))) && (
            <div>
              <GroupHeader label="Tool output" />
              <div className="space-y-1">
                {TOOL_DISPLAY_KEYS.filter(
                  t =>
                    !lowerFilter ||
                    t.toLowerCase().includes(lowerFilter) ||
                    'tool output verbose'.includes(lowerFilter),
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

          {/* Inter-Session Links */}
          {(!lowerFilter || 'links inter-session session connect persist'.includes(lowerFilter)) && (
            <div>
              <GroupHeader label="Inter-Session Links" />
              <SessionLinksSection />
            </div>
          )}

          {/* Notifications */}
          {(!lowerFilter || 'notifications push notify bell'.includes(lowerFilter)) && (
            <div>
              <GroupHeader label="Notifications" />
              <NotificationsSection />
            </div>
          )}

          {/* Shortcuts */}
          {(!lowerFilter ||
            'shortcuts keyboard keys hotkey'.includes(lowerFilter) ||
            SHORTCUTS.some(
              ([n, k]) => n.toLowerCase().includes(lowerFilter) || k.toLowerCase().includes(lowerFilter),
            )) && (
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

          {/* Version */}
          {(!lowerFilter || 'version build commit'.includes(lowerFilter)) && (
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
                    <div className="text-muted-foreground mb-1.5 uppercase tracking-wider text-[10px]">
                      Recent commits
                    </div>
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
        </div>

        {/* Sticky save button at bottom */}
        <div className="px-6 py-3 border-t border-border flex justify-end">
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
      </DialogContent>
    </Dialog>
  )
}

// --- Bubble color picker ---

const BUBBLE_PREVIEW_COLORS: Record<string, string> = {
  blue: 'bg-[#2563eb]',
  teal: 'bg-teal-600',
  purple: 'bg-purple-600',
  green: 'bg-emerald-600',
  orange: 'bg-amber-600',
  pink: 'bg-pink-600',
  indigo: 'bg-indigo-600',
}

function BubbleColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex gap-1.5">
      {BUBBLE_COLOR_OPTIONS.map(color => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          className={cn(
            'w-5 h-5 rounded-full transition-all',
            BUBBLE_PREVIEW_COLORS[color],
            value === color
              ? 'ring-2 ring-white ring-offset-1 ring-offset-background scale-110'
              : 'opacity-70 hover:opacity-100',
          )}
          title={color}
        />
      ))}
    </div>
  )
}

// --- Key capture for push-to-talk ---

const CODE_LABELS: Record<string, string> = {
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  MetaLeft: 'Left Cmd',
  MetaRight: 'Right Cmd',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Backspace: 'Backspace',
  Delete: 'Del',
  Insert: 'Ins',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  PrintScreen: 'PrtSc',
  ScrollLock: 'ScrLk',
  Pause: 'Pause',
  NumLock: 'NumLk',
  ContextMenu: 'Menu',
  Space: 'Space',
  CapsLock: 'Caps',
  Enter: 'Enter',
  Tab: 'Tab',
}

export function formatKeyCode(code: string): string {
  if (code in CODE_LABELS) return CODE_LABELS[code]
  const fKey = code.match(/^F(\d{1,2})$/)
  if (fKey) return `F${fKey[1]}`
  const numpad = code.match(/^Numpad(.+)$/)
  if (numpad) return `Num ${numpad[1]}`
  const letter = code.match(/^Key([A-Z])$/)
  if (letter) return letter[1]
  const digit = code.match(/^Digit(\d)$/)
  if (digit) return digit[1]
  return code
}

// Disallowed: keys that conflict with normal usage
const DISALLOWED_KEYS = new Set(['Escape', 'Tab', 'Enter', 'Backspace', 'Delete'])

function KeyCapture({ value, onChange }: { value: string | null; onChange: (code: string | null) => void }) {
  const [capturing, setCapturing] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const handleCapture = useCallback(() => setCapturing(true), [])

  useEffect(() => {
    if (!capturing) return

    function handleKeyDown(e: KeyboardEvent) {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') {
        setCapturing(false)
        return
      }
      if (DISALLOWED_KEYS.has(e.code)) return
      onChange(e.code)
      setCapturing(false)
    }

    function handleClickOutside(e: MouseEvent) {
      if (!buttonRef.current?.contains(e.target as Node)) setCapturing(false)
    }

    // Small delay so the click that opened capture doesn't immediately fire
    const t = setTimeout(() => {
      window.addEventListener('keydown', handleKeyDown, { capture: true })
      window.addEventListener('mousedown', handleClickOutside)
    }, 100)

    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
      window.removeEventListener('mousedown', handleClickOutside)
    }
  }, [capturing, onChange])

  return (
    <div className="flex items-center gap-2">
      <button
        ref={buttonRef}
        type="button"
        onClick={capturing ? () => setCapturing(false) : handleCapture}
        className={cn(
          'px-3 py-1 text-xs font-mono border rounded transition-all min-w-[100px] text-center',
          capturing
            ? 'border-blue-500 bg-blue-500/20 text-blue-400 animate-pulse'
            : value
              ? 'border-border bg-muted text-foreground'
              : 'border-border/50 bg-muted/50 text-muted-foreground',
        )}
      >
        {capturing ? 'Press a key...' : value ? formatKeyCode(value) : 'Not set'}
      </button>
      {value && !capturing && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-[10px] text-muted-foreground hover:text-destructive"
        >
          clear
        </button>
      )}
    </div>
  )
}

// --- Session Links Management ---

const LINKS_API = `${window.location.protocol}//${window.location.host}/api/links`

interface LinkItem {
  cwdA: string
  cwdB: string
  nameA: string
  nameB: string
  createdAt: number
  lastUsed: number
  online: boolean
  sessionIdA?: string
  sessionIdB?: string
}

function SessionLinksSection() {
  const [links, setLinks] = useState<LinkItem[]>([])
  const [loading, setLoading] = useState(true)

  const fetchLinks = useCallback(async () => {
    try {
      const res = await fetch(LINKS_API)
      if (!res.ok) return
      const data = (await res.json()) as { links: LinkItem[] }
      setLinks(data.links)
    } catch {
      // network error
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchLinks()
  }, [fetchLinks])

  async function removeLink(cwdA: string, cwdB: string) {
    await fetch(LINKS_API, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwdA, cwdB }),
    })
    fetchLinks()
  }

  function formatAge(ts: number): string {
    const diff = Date.now() - ts
    if (diff < 60_000) return 'just now'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
    return `${Math.floor(diff / 86400_000)}d ago`
  }

  if (loading) return <div className="text-xs text-muted-foreground font-mono">Loading...</div>

  if (links.length === 0) {
    return (
      <div className="text-xs text-muted-foreground font-mono py-2">
        No persisted links. Links are created when you approve inter-session messaging.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {links.map(link => (
        <div key={`${link.cwdA}:${link.cwdB}`} className="flex items-center gap-2 text-xs">
          <span className={cn('w-2 h-2 rounded-full shrink-0', link.online ? 'bg-green-400' : 'bg-zinc-600')} />
          <span className="text-teal-400 font-mono truncate">{link.nameA}</span>
          <span className="text-muted-foreground">↔</span>
          <span className="text-sky-400 font-mono truncate">{link.nameB}</span>
          <span className="text-[9px] text-muted-foreground/50 ml-auto shrink-0">{formatAge(link.lastUsed)}</span>
          <button
            type="button"
            onClick={() => removeLink(link.cwdA, link.cwdB)}
            className="text-[9px] text-muted-foreground hover:text-destructive shrink-0"
          >
            x
          </button>
        </div>
      ))}
    </div>
  )
}
