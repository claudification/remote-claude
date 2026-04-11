import { Bug, Settings } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { NerdModal } from '@/components/nerd-modal'
import { SettingsDialog } from '@/components/settings-page'
import { UsageBar } from '@/components/usage-bar'
import { useSessionsStore } from '@/hooks/use-sessions'
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
      className="text-[10px] text-muted-foreground/70 font-mono tabular-nums whitespace-nowrap hover:text-muted-foreground transition-colors cursor-pointer hidden sm:inline"
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

  useEffect(() => {
    function handleOpen() {
      setShowSettings(true)
    }
    window.addEventListener('open-settings', handleOpen)
    return () => window.removeEventListener('open-settings', handleOpen)
  }, [])
  const showStats = useSessionsStore(s => s.dashboardPrefs.showWsStats)
  const isConnected = useSessionsStore(s => s.isConnected)
  const agentConnected = useSessionsStore(s => s.agentConnected)
  const error = useSessionsStore(s => s.error)

  return (
    <header className="border border-border p-2 sm:p-3 font-mono select-none">
      <div className="flex items-center gap-2 sm:gap-4 text-xs sm:text-sm">
        <span
          className={`text-xs sm:text-sm shrink-0 ${isConnected ? 'text-active' : 'text-destructive animate-pulse'}`}
          title={error || (isConnected ? 'WebSocket connected' : 'WebSocket disconnected')}
        >
          {isConnected ? '● WS' : '○ WS'}
          {!isConnected && error && (
            <span className="hidden sm:inline text-[10px] text-destructive/70 ml-1">
              {error.length > 40 ? `${error.slice(0, 40)}...` : error}
            </span>
          )}
        </span>
        <span
          className={`hidden sm:inline text-xs sm:text-sm shrink-0 ${agentConnected ? 'text-active' : 'text-muted-foreground'}`}
        >
          {agentConnected ? '● Agent' : '○ Agent'}
        </span>

        <UsageBar />

        <span className="flex-1" />

        {showStats && (
          <>
            <WsStats onClick={() => setShowStatsModal(true)} />
            <button
              type="button"
              onClick={() => {
                haptic('tap')
                setShowStatsModal(true)
              }}
              className="sm:hidden text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              title="Debug stats"
            >
              <Bug className="w-3.5 h-3.5" />
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Settings"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>

      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />
      <NerdModal open={showStatsModal} onClose={() => setShowStatsModal(false)} />
    </header>
  )
}
