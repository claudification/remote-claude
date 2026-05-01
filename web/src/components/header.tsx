import { Settings } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { NerdModal } from '@/components/nerd-modal'
import { NotificationBell } from '@/components/notification-bell'
import { ProjectSettingsEditor } from '@/components/project-settings-editor'
import { SettingsDialog } from '@/components/settings-page'
import { UsageBar } from '@/components/usage-bar'
import { useConversationsStore } from '@/hooks/use-sessions'
import { getRates, subscribe as subscribeStats } from '@/hooks/ws-stats'
import { haptic } from '@/lib/utils'

function formatBytes(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)}B`
  return `${(bps / 1024).toFixed(1)}K`
}

const EMPTY_SENTINELS: { sentinelId: string; alias: string; hostname?: string; connected: boolean }[] = []

function StatusIndicator() {
  const isConnected = useConversationsStore(s => s.isConnected)
  const sentinelConnected = useConversationsStore(s => s.sentinelConnected)
  const sentinels = useConversationsStore(s => s.sentinels) || EMPTY_SENTINELS
  const error = useConversationsStore(s => s.error)
  const showStats = useConversationsStore(s => s.controlPanelPrefs.showWsStats)
  const rates = useSyncExternalStore(subscribeStats, getRates)

  const [open, setOpen] = useState(false)
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Dot color: green = all good, amber = WS up but sentinel down, red = WS down
  const dotColor = !isConnected
    ? 'text-destructive animate-pulse'
    : sentinelConnected
      ? 'text-active'
      : 'text-amber-500'

  function handleMouseEnter() {
    hoverTimeout.current = setTimeout(() => setOpen(true), 300)
  }
  function handleMouseLeave() {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current)
    hoverTimeout.current = setTimeout(() => setOpen(false), 200)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`text-xs sm:text-sm shrink-0 cursor-pointer select-none hover:opacity-80 transition-opacity ${dotColor}`}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={() => {
            haptic('tap')
            setOpen(o => !o)
          }}
        >
          {isConnected ? '●' : '○'}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="z-50 w-56 rounded border border-border bg-background/95 backdrop-blur-sm shadow-lg p-3 font-mono"
          sideOffset={8}
          align="start"
          onMouseEnter={() => {
            if (hoverTimeout.current) clearTimeout(hoverTimeout.current)
          }}
          onMouseLeave={handleMouseLeave}
          onOpenAutoFocus={e => e.preventDefault()}
        >
          <div className="space-y-2">
            <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-2">Connection</div>

            <div className="flex items-center gap-2">
              <span className={`text-xs ${isConnected ? 'text-active' : 'text-destructive'}`}>
                {isConnected ? '●' : '○'}
              </span>
              <span className="text-[11px] text-muted-foreground">WebSocket</span>
              <span className={`text-[10px] ml-auto ${isConnected ? 'text-active' : 'text-destructive'}`}>
                {isConnected ? 'connected' : 'disconnected'}
              </span>
            </div>

            {!isConnected && error && (
              <div className="text-[10px] text-destructive/70 pl-5 -mt-1 break-all">{error}</div>
            )}

            {sentinels.length > 0 ? (
              sentinels.map(s => (
                <div key={s.sentinelId} className="flex items-center gap-2">
                  <span className={`text-xs ${s.connected ? 'text-active' : 'text-muted-foreground'}`}>
                    {s.connected ? '●' : '○'}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{s.alias}</span>
                  {s.hostname && <span className="text-[10px] text-muted-foreground/40">{s.hostname}</span>}
                  <span className={`text-[10px] ml-auto ${s.connected ? 'text-active' : 'text-muted-foreground/50'}`}>
                    {s.connected ? 'connected' : 'offline'}
                  </span>
                </div>
              ))
            ) : (
              <div className="flex items-center gap-2">
                <span className={`text-xs ${sentinelConnected ? 'text-active' : 'text-muted-foreground'}`}>
                  {sentinelConnected ? '●' : '○'}
                </span>
                <span className="text-[11px] text-muted-foreground">Sentinel</span>
                <span
                  className={`text-[10px] ml-auto ${sentinelConnected ? 'text-active' : 'text-muted-foreground/50'}`}
                >
                  {sentinelConnected ? 'connected' : 'offline'}
                </span>
              </div>
            )}

            {showStats && isConnected && (
              <>
                <div className="border-t border-border/50 my-2" />
                <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1">
                  Traffic (3s avg)
                </div>
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground/70 tabular-nums">
                  <span>
                    <span className="opacity-50">in</span> {rates.msgInPerSec.toFixed(0)}m/
                    {formatBytes(rates.bytesInPerSec)}s
                  </span>
                  <span>
                    <span className="opacity-50">out</span> {rates.msgOutPerSec.toFixed(0)}m/
                    {formatBytes(rates.bytesOutPerSec)}s
                  </span>
                </div>
              </>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function Header() {
  const [showSettings, setShowSettings] = useState(false)
  const [showStatsModal, setShowStatsModal] = useState(false)
  const [projectSettingsCwd, setProjectSettingsCwd] = useState<string | null>(null)

  useEffect(() => {
    function handleOpen() {
      setShowSettings(true)
    }
    window.addEventListener('open-settings', handleOpen)
    return () => window.removeEventListener('open-settings', handleOpen)
  }, [])

  useEffect(() => {
    function handleOpenProject(e: Event) {
      const detail = (e as CustomEvent<{ project?: string }>).detail
      if (detail?.project) setProjectSettingsCwd(detail.project)
    }
    window.addEventListener('open-project-settings', handleOpenProject)
    return () => window.removeEventListener('open-project-settings', handleOpenProject)
  }, [])
  const showStats = useConversationsStore(s => s.controlPanelPrefs.showWsStats)

  return (
    <header className="border border-border p-2 sm:p-3 font-mono select-none">
      <div className="flex items-center gap-2 sm:gap-4 text-xs sm:text-sm">
        <StatusIndicator />

        <UsageBar />

        <span className="flex-1" />

        {showStats && (
          <button
            type="button"
            onClick={() => {
              haptic('tap')
              setShowStatsModal(true)
            }}
            className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
            title="Debug stats"
          >
            nerd
          </button>
        )}

        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Settings"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>

        <NotificationBell />
      </div>

      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />
      <NerdModal open={showStatsModal} onClose={() => setShowStatsModal(false)} />
      {projectSettingsCwd && (
        <ProjectSettingsEditor project={projectSettingsCwd} onClose={() => setProjectSettingsCwd(null)} />
      )}
    </header>
  )
}
