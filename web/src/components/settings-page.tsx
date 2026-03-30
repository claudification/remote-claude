import { Bell, BellOff, Cloud, Save } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { getPushStatus, subscribeToPush, useSessionsStore } from '@/hooks/use-sessions'
import { resolveToolDisplay, TOOL_DISPLAY_KEYS } from '@/lib/dashboard-prefs'
import { BUILD_VERSION } from '../../../src/shared/version'

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
    label: 'Voice FAB (mobile)',
    description: 'Floating hold-to-record button on right edge',
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

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serverDraft),
      })
      if (res.ok) {
        const data = await res.json()
        useSessionsStore.setState({ globalSettings: data.settings })
        setDirty(false)
      }
    } catch {}
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
      <DialogContent className="max-w-md p-0 gap-0 max-h-[85vh] flex flex-col">
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
