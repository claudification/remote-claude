import { Bell, BellOff, Settings } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { NerdModal } from '@/components/nerd-modal'
import { SettingsDialog } from '@/components/settings-page'
import { getPushStatus, subscribeToPush, useSessionsStore } from '@/hooks/use-sessions'
import { getRates, subscribe as subscribeStats } from '@/hooks/ws-stats'
import { haptic } from '@/lib/utils'

function formatBytes(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)}B`
  return `${(bps / 1024).toFixed(1)}K`
}

function WsStats({ onClick }: { onClick: () => void }) {
  const rates = useSyncExternalStore(subscribeStats, getRates)
  return (
    <button
      type="button"
      onClick={() => {
        haptic('tap')
        onClick()
      }}
      className="text-[10px] text-muted-foreground/70 font-mono tabular-nums whitespace-nowrap hover:text-muted-foreground transition-colors cursor-pointer"
      title="WS traffic (3s avg) - click for details"
    >
      <span className="opacity-50">in</span> {rates.msgInPerSec.toFixed(0)}m/{formatBytes(rates.bytesInPerSec)}s{' '}
      <span className="opacity-50">out</span> {rates.msgOutPerSec.toFixed(0)}m/{formatBytes(rates.bytesOutPerSec)}s
    </button>
  )
}

export function Header() {
  const [showSettings, setShowSettings] = useState(false)
  const [showStatsModal, setShowStatsModal] = useState(false)
  const showStats = useSessionsStore(s => s.dashboardPrefs.showWsStats)
  const [pushState, setPushState] = useState<
    'loading' | 'unsupported' | 'prompt' | 'subscribing' | 'subscribed' | 'denied'
  >('loading')
  const isConnected = useSessionsStore(s => s.isConnected)
  const agentConnected = useSessionsStore(s => s.agentConnected)
  const error = useSessionsStore(s => s.error)
  const versionMismatch = useSessionsStore(s => s.versionMismatch)

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

        {versionMismatch && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-[10px] text-amber-400/80 hover:text-amber-400 transition-colors"
            title="Server was updated - click to reload"
          >
            update available
          </button>
        )}

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

        {showStats && (
          <>
            <span className="flex-1" />
            <WsStats onClick={() => setShowStatsModal(true)} />
          </>
        )}
      </div>

      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />
      <NerdModal open={showStatsModal} onClose={() => setShowStatsModal(false)} />
    </header>
  )
}
