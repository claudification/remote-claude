import { Bell, BellOff, Cloud, Monitor } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { getPushStatus, subscribeToPush, useSessionsStore } from '@/hooks/use-sessions'

interface DashboardPrefs {
  showInactiveByDefault: boolean
  compactMode: boolean
  showVoiceInput: boolean
}

function loadPrefs(): DashboardPrefs {
  try {
    const raw = localStorage.getItem('dashboard-prefs')
    if (raw) return { ...defaultPrefs, ...JSON.parse(raw) }
  } catch {}
  return defaultPrefs
}

function savePrefs(prefs: DashboardPrefs) {
  localStorage.setItem('dashboard-prefs', JSON.stringify(prefs))
  window.dispatchEvent(new Event('prefs-changed'))
}

const defaultPrefs: DashboardPrefs = {
  showInactiveByDefault: false,
  compactMode: false,
  showVoiceInput: true,
}

export function usePrefs() {
  const [prefs, setPrefs] = useState(loadPrefs)
  function update(patch: Partial<DashboardPrefs>) {
    setPrefs(prev => {
      const next = { ...prev, ...patch }
      savePrefs(next)
      return next
    })
  }
  return { prefs, update }
}

export function getShowVoiceInput(): boolean {
  return loadPrefs().showVoiceInput
}

function SectionLabel({ icon: Icon, label, hint }: { icon: typeof Cloud; label: string; hint: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="w-3.5 h-3.5 text-muted-foreground" />
      <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{label}</h3>
      <span className="text-[9px] text-muted-foreground/60 font-mono">{hint}</span>
    </div>
  )
}

function ServerSettings() {
  const globalSettings = useSessionsStore(s => s.globalSettings)
  const [idleTimeout, setIdleTimeout] = useState<number>(10)
  const [userLabel, setUserLabel] = useState('')
  const [agentLabel, setAgentLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    const val = globalSettings.idleTimeoutMinutes
    if (typeof val === 'number') {
      setIdleTimeout(val)
    }
    if (typeof globalSettings.userLabel === 'string') setUserLabel(globalSettings.userLabel as string)
    if (typeof globalSettings.agentLabel === 'string') setAgentLabel(globalSettings.agentLabel as string)
    setDirty(false)
  }, [globalSettings.idleTimeoutMinutes, globalSettings.userLabel, globalSettings.agentLabel])

  // Fetch on mount if not yet populated
  useEffect(() => {
    if (typeof globalSettings.idleTimeoutMinutes === 'number') return
    fetch('/api/settings')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data) useSessionsStore.setState({ globalSettings: data })
      })
      .catch(() => {})
  }, [])

  async function saveServerSettings() {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idleTimeoutMinutes: idleTimeout, userLabel, agentLabel }),
      })
      if (res.ok) {
        const data = await res.json()
        useSessionsStore.setState({ globalSettings: data.settings })
        setDirty(false)
      }
    } catch {}
    setSaving(false)
  }

  return (
    <section className="mb-6">
      <SectionLabel icon={Cloud} label="Server" hint="shared across all clients" />
      <div className="space-y-3">
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
              setDirty(true)
            }}
            className="w-16 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground text-right"
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-foreground">User label</div>
            <div className="text-[10px] text-muted-foreground">Name tag for user messages in transcript</div>
          </div>
          <input
            type="text"
            maxLength={20}
            value={userLabel}
            placeholder="USER"
            onChange={e => {
              setUserLabel(e.target.value)
              setDirty(true)
            }}
            className="w-28 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground text-right placeholder:text-muted-foreground/40"
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-foreground">Agent label</div>
            <div className="text-[10px] text-muted-foreground">Name tag for Claude messages in transcript</div>
          </div>
          <input
            type="text"
            maxLength={20}
            value={agentLabel}
            placeholder="AGENT"
            onChange={e => {
              setAgentLabel(e.target.value)
              setDirty(true)
            }}
            className="w-28 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground text-right placeholder:text-muted-foreground/40"
          />
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={saveServerSettings}
            disabled={saving || !dirty}
            className={`px-2 py-1 text-[10px] font-mono border transition-colors ${dirty ? 'border-active/50 text-active hover:bg-active/20' : 'border-border text-muted-foreground/40 cursor-not-allowed'}`}
          >
            {saving ? '...' : 'Save'}
          </button>
        </div>
      </div>
    </section>
  )
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { prefs, update } = usePrefs()
  const [pushState, setPushState] = useState<
    'loading' | 'unsupported' | 'prompt' | 'subscribing' | 'subscribed' | 'denied'
  >('loading')

  useEffect(() => {
    if (!open) return
    getPushStatus().then(status => {
      if (!status.supported) setPushState('unsupported')
      else if (status.subscribed) setPushState('subscribed')
      else if (status.permission === 'denied') setPushState('denied')
      else setPushState('prompt')
    })
  }, [open])

  async function handlePushToggle() {
    if (pushState === 'subscribing') return
    setPushState('subscribing')
    const result = await subscribeToPush()
    setPushState(result.success ? 'subscribed' : 'denied')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-6">
        <DialogTitle className="uppercase tracking-wider mb-6">Settings</DialogTitle>

        {/* Server settings */}
        <ServerSettings />

        {/* Client-side display settings */}
        <section className="mb-6">
          <SectionLabel icon={Monitor} label="Display" hint="this browser only" />
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
          </div>
        </section>

        {/* Notifications - client-side */}
        <section className="mb-6">
          <SectionLabel icon={Bell} label="Notifications" hint="this browser only" />
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
          </div>
        </section>

        {/* Keyboard shortcuts reference */}
        <section>
          <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">Shortcuts</h3>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Command palette</span>
              <kbd className="px-1.5 py-0.5 bg-muted text-muted-foreground border border-border text-[10px] font-mono">
                Ctrl+K
              </kbd>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Terminal (when active)</span>
              <span className="text-[10px] text-muted-foreground">Click TTY button</span>
            </div>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  )
}
