import { Bell, BellOff, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getPushStatus, subscribeToPush } from '@/hooks/use-sessions'

interface DashboardPrefs {
  showInactiveByDefault: boolean
  compactMode: boolean
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
}

const defaultPrefs: DashboardPrefs = {
  showInactiveByDefault: false,
  compactMode: false,
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

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const { prefs, update } = usePrefs()
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

  return (
    <div
      className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex items-start justify-center pt-[10vh] overflow-y-auto"
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-md border border-border bg-background p-6 relative">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
        >
          <X className="w-4 h-4" />
        </button>

        <h2 className="text-sm font-bold text-primary uppercase tracking-wider mb-6">Settings</h2>

        {/* Push Notifications */}
        <section className="mb-6">
          <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">Notifications</h3>
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

        {/* Display */}
        <section className="mb-6">
          <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">Display</h3>
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
      </div>
    </div>
  )
}
