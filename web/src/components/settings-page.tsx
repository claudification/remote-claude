import { Bell, BellOff, Cloud, Info, Keyboard, Monitor } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { getPushStatus, subscribeToPush, useSessionsStore } from '@/hooks/use-sessions'
import { resolveToolDisplay, TOOL_DISPLAY_KEYS } from '@/lib/dashboard-prefs'
import { BUILD_VERSION } from '../../../src/shared/version'

// --- Color input with live preview ---
// 16 curated pastel/muted colors that look good on dark backgrounds
const PALETTE = [
  '#f9a8d4', // pink
  '#f472b6', // hot pink
  '#c084fc', // purple
  '#a78bfa', // violet
  '#818cf8', // indigo
  '#60a5fa', // blue
  '#38bdf8', // sky
  '#22d3ee', // cyan
  '#2dd4bf', // teal
  '#4ade80', // green
  '#a3e635', // lime
  '#facc15', // yellow
  '#fbbf24', // amber
  '#fb923c', // orange
  '#f87171', // red
  '#e2e8f0', // slate/white
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
      {/* Color swatches */}
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

      {/* Opacity slider */}
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

      {/* Preview + reset */}
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

// --- Tab components ---

function ServerTab() {
  const globalSettings = useSessionsStore(s => s.globalSettings)
  const [idleTimeout, setIdleTimeout] = useState<number>(10)
  const [userLabel, setUserLabel] = useState('')
  const [agentLabel, setAgentLabel] = useState('')
  const [userColor, setUserColor] = useState('')
  const [agentColor, setAgentColor] = useState('')
  const [userSize, setUserSize] = useState('')
  const [agentSize, setAgentSize] = useState('')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    const val = globalSettings.idleTimeoutMinutes
    if (typeof val === 'number') setIdleTimeout(val)
    if (typeof globalSettings.userLabel === 'string') setUserLabel(globalSettings.userLabel as string)
    if (typeof globalSettings.agentLabel === 'string') setAgentLabel(globalSettings.agentLabel as string)
    if (typeof globalSettings.userColor === 'string') setUserColor(globalSettings.userColor as string)
    if (typeof globalSettings.agentColor === 'string') setAgentColor(globalSettings.agentColor as string)
    if (typeof globalSettings.userSize === 'string') setUserSize(globalSettings.userSize as string)
    if (typeof globalSettings.agentSize === 'string') setAgentSize(globalSettings.agentSize as string)
    setDirty(false)
  }, [
    globalSettings.idleTimeoutMinutes,
    globalSettings.userLabel,
    globalSettings.agentLabel,
    globalSettings.userColor,
    globalSettings.agentColor,
    globalSettings.userSize,
    globalSettings.agentSize,
  ])

  // Global settings are fetched on app mount (app.tsx) - no need to fetch here

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idleTimeoutMinutes: idleTimeout,
          userLabel,
          agentLabel,
          userColor,
          agentColor,
          userSize,
          agentSize,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        useSessionsStore.setState({ globalSettings: data.settings })
        setDirty(false)
      }
    } catch {}
    setSaving(false)
  }

  function markDirty() {
    setDirty(true)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-foreground">Idle timeout</div>
          <div className="text-[10px] text-muted-foreground">Minutes before active session is marked idle</div>
        </div>
        <input
          type="number"
          min={1}
          max={120}
          value={idleTimeout}
          onChange={e => {
            setIdleTimeout(Number(e.target.value))
            markDirty()
          }}
          className="w-16 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground text-right"
        />
      </div>

      {/* Label + color pairs */}
      <div className="space-y-3">
        <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">User tag</div>
        <div className="flex items-center justify-between">
          <div className="text-sm text-foreground">Label</div>
          <input
            type="text"
            maxLength={20}
            value={userLabel}
            placeholder="USER"
            onChange={e => {
              setUserLabel(e.target.value)
              markDirty()
            }}
            className="w-28 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground text-right placeholder:text-muted-foreground/40"
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="text-sm text-foreground">Size</div>
          <SizePicker
            value={userSize}
            onChange={v => {
              setUserSize(v)
              markDirty()
            }}
          />
        </div>
        <div>
          <div className="text-sm text-foreground mb-1">Background color</div>
          <ColorInput
            value={userColor}
            onChange={v => {
              setUserColor(v)
              markDirty()
            }}
            defaultColor="rgba(234,179,8,1)"
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Agent tag</div>
        <div className="flex items-center justify-between">
          <div className="text-sm text-foreground">Label</div>
          <input
            type="text"
            maxLength={20}
            value={agentLabel}
            placeholder="AGENT"
            onChange={e => {
              setAgentLabel(e.target.value)
              markDirty()
            }}
            className="w-28 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground text-right placeholder:text-muted-foreground/40"
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="text-sm text-foreground">Size</div>
          <SizePicker
            value={agentSize}
            onChange={v => {
              setAgentSize(v)
              markDirty()
            }}
          />
        </div>
        <div>
          <div className="text-sm text-foreground mb-1">Background color</div>
          <ColorInput
            value={agentColor}
            onChange={v => {
              setAgentColor(v)
              markDirty()
            }}
            defaultColor="rgba(168,85,247,1)"
          />
        </div>
      </div>

      <div className="flex justify-end pt-1">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className={`px-2 py-1 text-[10px] font-mono border transition-colors ${dirty ? 'border-active/50 text-active hover:bg-active/20' : 'border-border text-muted-foreground/40 cursor-not-allowed'}`}
        >
          {saving ? '...' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function DisplayTab() {
  const prefs = useSessionsStore(s => s.dashboardPrefs)
  const update = useSessionsStore(s => s.updateDashboardPrefs)

  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <div className="text-sm text-foreground">Show inactive sessions</div>
          <div className="text-[10px] text-muted-foreground">Show ended sessions in sidebar by default</div>
        </div>
        <input
          type="checkbox"
          checked={prefs.showInactiveByDefault}
          onChange={e => update({ showInactiveByDefault: e.target.checked })}
          className="accent-primary w-4 h-4"
        />
      </label>
      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <div className="text-sm text-foreground">Compact mode</div>
          <div className="text-[10px] text-muted-foreground">Reduce spacing in session list</div>
        </div>
        <input
          type="checkbox"
          checked={prefs.compactMode}
          onChange={e => update({ compactMode: e.target.checked })}
          className="accent-primary w-4 h-4"
        />
      </label>
      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <div className="text-sm text-foreground">Voice input</div>
          <div className="text-[10px] text-muted-foreground">Show microphone button in input bar</div>
        </div>
        <input
          type="checkbox"
          checked={prefs.showVoiceInput}
          onChange={e => update({ showVoiceInput: e.target.checked })}
          className="accent-primary w-4 h-4"
        />
      </label>
      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <div className="text-sm text-foreground">WS traffic stats</div>
          <div className="text-[10px] text-muted-foreground">Show msg/s and KB/s in header bar</div>
        </div>
        <input
          type="checkbox"
          checked={prefs.showWsStats}
          onChange={e => update({ showWsStats: e.target.checked })}
          className="accent-primary w-4 h-4"
        />
      </label>
      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <div className="text-sm text-foreground">Show thinking</div>
          <div className="text-[10px] text-muted-foreground">Display model thinking blocks in transcript</div>
        </div>
        <input
          type="checkbox"
          checked={prefs.showThinking}
          onChange={e => update({ showThinking: e.target.checked })}
          className="accent-primary w-4 h-4"
        />
      </label>
      {/* Per-tool verbose display settings */}
      <div className="pt-2 border-t border-border">
        <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
          Tool output (verbose mode)
        </div>
        <div className="space-y-1">
          {TOOL_DISPLAY_KEYS.map(tool => {
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
                    update({ toolDisplay: td })
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
                    update({ toolDisplay: td })
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
                      update({ toolDisplay: td })
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
    </div>
  )
}

function NotificationsTab() {
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
    // Unsubscribe existing, then re-subscribe with current VAPID key
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
    <div className="space-y-3">
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

function ShortcutsTab() {
  const shortcuts = [
    ['Command palette', 'Ctrl+K'],
    ['Toggle sidebar', 'Ctrl+B'],
    ['Toggle verbose', 'Ctrl+O'],
    ['Quick note', 'Ctrl+Shift+N'],
    ['Open terminal', 'Ctrl+Shift+T'],
    ['Debug console', 'Ctrl+Shift+D'],
    ['Shortcut help', 'Shift+?'],
    ['Go home / focus input', 'Escape'],
  ]

  return (
    <div className="space-y-1.5">
      {shortcuts.map(([name, key]) => (
        <div key={name} className="flex justify-between text-xs">
          <span className="text-muted-foreground">{name}</span>
          <kbd className="px-1.5 py-0.5 bg-muted text-muted-foreground border border-border text-[10px] font-mono">
            {key}
          </kbd>
        </div>
      ))}
    </div>
  )
}

function VersionTab() {
  const buildDate = BUILD_VERSION.buildTime
    ? new Date(BUILD_VERSION.buildTime).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        hour12: false,
      })
    : 'unknown'

  return (
    <div className="space-y-4 font-mono text-xs">
      <div className="space-y-2">
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
      </div>

      {BUILD_VERSION.recentCommits?.length > 0 && (
        <div className="border-t border-border pt-3">
          <div className="text-muted-foreground mb-2 uppercase tracking-wider text-[10px]">Recent commits</div>
          <div className="space-y-1.5">
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
  )
}

const settingsTabs = [
  { id: 'server', label: 'Server', icon: Cloud, component: ServerTab },
  { id: 'display', label: 'Display', icon: Monitor, component: DisplayTab },
  { id: 'notify', label: 'Notify', icon: Bell, component: NotificationsTab },
  { id: 'keys', label: 'Keys', icon: Keyboard, component: ShortcutsTab },
  { id: 'version', label: 'Version', icon: Info, component: VersionTab },
] as const

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [activeTab, setActiveTab] = useState<string>('server')

  const ActiveComponent = settingsTabs.find(t => t.id === activeTab)?.component ?? ServerTab

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 gap-0">
        <DialogTitle className="uppercase tracking-wider px-6 pt-6 pb-0">Settings</DialogTitle>

        {/* Tab bar */}
        <div className="flex border-b border-border px-6 mt-4">
          {settingsTabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono transition-colors border-b-2 -mb-px ${
                activeTab === tab.id
                  ? 'border-active text-active'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <tab.icon className="w-3 h-3" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="px-6 py-5 min-h-[200px]">
          <ActiveComponent />
        </div>
      </DialogContent>
    </Dialog>
  )
}
