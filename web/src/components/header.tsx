import { Bell, BellOff, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { SettingsPage } from '@/components/settings-page'
import { Badge } from '@/components/ui/badge'
import { getPushStatus, subscribeToPush, useSessionsStore } from '@/hooks/use-sessions'

const ASCII_LOGO = `\u00A0██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
\u00A0╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝`

export function Header() {
  const [expanded, setExpanded] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [pushState, setPushState] = useState<
    'loading' | 'unsupported' | 'prompt' | 'subscribing' | 'subscribed' | 'denied'
  >('loading')
  const { sessions, isConnected, agentConnected } = useSessionsStore()

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

  const active = sessions.filter(s => s.status === 'active').length
  const idle = sessions.filter(s => s.status === 'idle').length
  const ended = sessions.filter(s => s.status === 'ended').length
  const totalAgents = sessions.reduce((sum, s) => sum + (s.activeSubagentCount || 0), 0)
  const teamCount = sessions.filter(s => s.team).length

  return (
    <header
      className="border border-border p-2 sm:p-3 font-mono cursor-pointer select-none"
      onClick={() => setExpanded(!expanded)}
    >
      {expanded && (
        <pre className="hidden md:block text-primary text-xs leading-tight whitespace-pre mb-2">{ASCII_LOGO}</pre>
      )}

      {/* Stats row - always visible */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-xs sm:text-sm">
        <span className="text-primary font-bold">CONCENTRATOR</span>
        <span className="text-muted-foreground">|</span>

        <div className="flex items-center gap-1 sm:gap-2">
          <Badge variant="outline" className="bg-active/20 text-active border-active/50 text-xs">
            {active} active
          </Badge>
          <Badge variant="outline" className="bg-idle/20 text-idle border-idle/50 text-xs">
            {idle} idle
          </Badge>
          <Badge variant="outline" className="bg-ended/20 text-ended border-ended/50 text-xs">
            {ended} ended
          </Badge>
          {totalAgents > 0 && (
            <Badge variant="outline" className="bg-pink-400/20 text-pink-400 border-pink-400/50 text-xs">
              {totalAgents} agent{totalAgents !== 1 ? 's' : ''}
            </Badge>
          )}
          {teamCount > 0 && (
            <Badge variant="outline" className="bg-purple-400/20 text-purple-400 border-purple-400/50 text-xs">
              {teamCount} team{teamCount !== 1 ? 's' : ''}
            </Badge>
          )}
        </div>

        <span className="text-muted-foreground">|</span>

        <span className={`text-xs sm:text-sm ${isConnected ? 'text-active' : 'text-destructive'}`}>
          {isConnected ? '● WS' : '○ WS'}
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
          onClick={e => {
            e.stopPropagation()
            setShowSettings(true)
          }}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Settings"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>

      {showSettings && <SettingsPage onClose={() => setShowSettings(false)} />}
    </header>
  )
}
