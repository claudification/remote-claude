import { Bell, BellOff, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { SettingsDialog } from '@/components/settings-page'
import { getPushStatus, subscribeToPush, useSessionsStore } from '@/hooks/use-sessions'

export function Header() {
  const [showSettings, setShowSettings] = useState(false)
  const [pushState, setPushState] = useState<
    'loading' | 'unsupported' | 'prompt' | 'subscribing' | 'subscribed' | 'denied'
  >('loading')
  const { isConnected, agentConnected, error } = useSessionsStore()

  useEffect(() => {
    getPushStatus().then(status => {
      if (!status.supported) setPushState('unsupported')
      else if (status.subscribed) setPushState('subscribed')
      else if (status.permission === 'denied') setPushState('denied')
      else setPushState('prompt')
    })
  }, [])

  async function handlePushToggle(e: React.MouseEvent) {
    e.stopPropagation()
    if (pushState === 'subscribing') return
    setPushState('subscribing')
    const result = await subscribeToPush()
    setPushState(result.success ? 'subscribed' : 'denied')
  }

  return (
    <header className="border border-border p-2 sm:p-3 font-mono select-none">
      <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-xs sm:text-sm">
        <span
          className={`text-xs sm:text-sm ${isConnected ? 'text-active' : 'text-destructive animate-pulse'}`}
          title={error || (isConnected ? 'WebSocket connected' : 'WebSocket disconnected')}
        >
          {isConnected ? '● WS' : '○ WS'}
          {!isConnected && error && (
            <span className="hidden sm:inline text-[10px] text-destructive/70 ml-1">
              {error.length > 40 ? `${error.slice(0, 40)}...` : error}
            </span>
          )}
        </span>
        <span className={`text-xs sm:text-sm ${agentConnected ? 'text-active' : 'text-muted-foreground'}`}>
          {agentConnected ? '● Agent' : '○ Agent'}
        </span>

        {pushState !== 'unsupported' && pushState !== 'loading' && (
          <button
            type="button"
            onClick={handlePushToggle}
            className={`flex items-center gap-1 text-xs transition-colors ${
              pushState === 'subscribed'
                ? 'text-active'
                : pushState === 'denied'
                  ? 'text-destructive'
                  : 'text-muted-foreground hover:text-foreground'
            }`}
            title={
              pushState === 'subscribed'
                ? 'Push notifications enabled'
                : pushState === 'denied'
                  ? 'Notifications denied'
                  : 'Enable push notifications'
            }
          >
            {pushState === 'subscribed' ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{pushState === 'subscribing' ? '...' : 'Push'}</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Settings"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>

      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />
    </header>
  )
}
