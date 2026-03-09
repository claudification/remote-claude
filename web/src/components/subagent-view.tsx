import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fetchSubagents, useSessionsStore } from '@/hooks/use-sessions'
import type { HookEvent, SubagentInfo } from '@/lib/types'
import { cn } from '@/lib/utils'

function formatDuration(startMs: number, endMs?: number): string {
  const diff = (endMs || Date.now()) - startMs
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainSec = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainSec}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function agentTypeIcon(agentType: string): string {
  switch (agentType.toLowerCase()) {
    case 'bash':
      return '$'
    case 'explore':
      return '?'
    case 'plan':
      return '#'
    case 'general-purpose':
      return '*'
    case 'code-reviewer':
      return '!'
    case 'code-refactorer':
      return '~'
    case 'unit-test-runner':
      return 'T'
    case 'git-commit-master':
      return 'G'
    default:
      return '>'
  }
}

export function SubagentView({ sessionId }: { sessionId: string }) {
  const [subagents, setSubagents] = useState<SubagentInfo[]>([])
  const [loaded, setLoaded] = useState(false)

  const allEvents = useSessionsStore(state => state.events)
  const events = allEvents[sessionId] || []

  // Fetch subagents on mount
  useEffect(() => {
    fetchSubagents(sessionId).then(data => {
      setSubagents(data)
      setLoaded(true)
    })
  }, [sessionId])

  // Update from real-time events
  useEffect(() => {
    if (!loaded) return

    const agentEvents = events.filter(
      (e: HookEvent) => e.hookEvent === 'SubagentStart' || e.hookEvent === 'SubagentStop',
    )
    if (agentEvents.length === 0) return

    setSubagents(prev => {
      const updated = [...prev]
      for (const evt of agentEvents) {
        const data = evt.data as Record<string, unknown>
        const agentId = String(data.agent_id || '')
        if (!agentId) continue

        if (evt.hookEvent === 'SubagentStart') {
          if (!updated.find(a => a.agentId === agentId)) {
            updated.push({
              agentId,
              agentType: String(data.agent_type || 'unknown'),
              startedAt: evt.timestamp,
              status: 'running',
              events: [],
            })
          }
        } else if (evt.hookEvent === 'SubagentStop') {
          const agent = updated.find(a => a.agentId === agentId)
          if (agent) {
            agent.stoppedAt = evt.timestamp
            agent.status = 'stopped'
          }
        }
      }
      return updated
    })
  }, [events, loaded])

  const running = subagents.filter(a => a.status === 'running').length
  const stopped = subagents.filter(a => a.status === 'stopped').length
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)
  const selectSubagent = useSessionsStore(state => state.selectSubagent)

  if (subagents.length === 0 && loaded) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <pre className="text-xs" style={{ lineHeight: 0.95 }}>
          {`
┌───────────────────────────┐
│                           │
│   No sub-agents spawned   │
│                           │
└───────────────────────────┘
`.trim()}
        </pre>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto font-mono text-xs leading-tight">
      <div className="text-muted-foreground mb-0.5">{'┌── AGENTS ─────────────────────────'}</div>

      {subagents.map((agent, i) => {
        const isLast = i === subagents.length - 1
        const prefix = isLast ? '└─' : '├─'
        const isRunning = agent.status === 'running'
        const isExpanded = expandedAgent === agent.agentId
        const hasEvents = agent.events && agent.events.length > 0

        return (
          <div key={agent.agentId}>
            <div className="flex items-center gap-1.5 hover:bg-muted/20 rounded px-1 -mx-1 py-px">
              <button
                type="button"
                onClick={() => hasEvents && setExpandedAgent(isExpanded ? null : agent.agentId)}
                className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
              >
                <span className="text-muted-foreground">{prefix}</span>
                {hasEvents ? (
                  isExpanded ? (
                    <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
                  )
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span
                  className={cn(
                    'px-1.5 text-[10px] font-bold uppercase shrink-0',
                    isRunning
                      ? 'bg-active/20 text-active border border-active/50'
                      : 'bg-muted/30 text-muted-foreground border border-border',
                  )}
                >
                  {agent.status}
                </span>
                <span className="text-accent shrink-0">{agentTypeIcon(agent.agentType)}</span>
                <span className={cn('font-bold truncate', isRunning ? 'text-foreground' : 'text-muted-foreground')}>
                  {agent.description || agent.agentType}
                </span>
                <span className="text-muted-foreground text-[10px] shrink-0">{agent.agentId.slice(0, 7)}</span>
                <span className="text-muted-foreground text-[10px] shrink-0">
                  ({formatDuration(agent.startedAt, agent.stoppedAt)})
                </span>
              </button>
              <button
                type="button"
                onClick={() => selectSubagent(agent.agentId)}
                className="shrink-0 p-1 text-pink-400/50 hover:text-pink-400 transition-colors"
                title="View transcript"
              >
                <ExternalLink className="w-3 h-3" />
              </button>
            </div>

            {/* Expanded event list */}
            {isExpanded && hasEvents && (
              <div className="ml-8 mt-0.5 mb-1 border-l border-border pl-3 space-y-0">
                {agent.events.map((evt, j) => (
                  <SubagentEventLine key={j} event={evt} />
                ))}
              </div>
            )}
          </div>
        )
      })}

      <div className="text-muted-foreground mt-1 border-t border-border pt-1">
        {subagents.length} total | {running} running | {stopped} stopped
      </div>
    </div>
  )
}

function getEventLabel(evt: HookEvent): { label: string; color: string } {
  const data = evt.data as Record<string, unknown>
  switch (evt.hookEvent) {
    case 'PreToolUse':
    case 'PostToolUse': {
      const tool = String(data.tool_name || 'Tool')
      const input = (data.tool_input || {}) as Record<string, unknown>
      let detail = ''
      if (tool === 'Bash') detail = String(input.command || '').slice(0, 50)
      else if (tool === 'Read' || tool === 'Write' || tool === 'Edit') {
        const p = String(input.file_path || '')
        detail = p.split('/').pop() || p
      } else if (tool === 'Grep') detail = String(input.pattern || '').slice(0, 30)
      const prefix = evt.hookEvent === 'PreToolUse' ? '>' : '<'
      return {
        label: `${prefix} ${tool}${detail ? ` ${detail}` : ''}`,
        color: evt.hookEvent === 'PreToolUse' ? 'text-cyan-400' : 'text-blue-400',
      }
    }
    case 'PostToolUseFailure':
      return { label: `! ${String(data.tool_name || 'Tool')} FAILED`, color: 'text-red-400' }
    default:
      return { label: evt.hookEvent, color: 'text-muted-foreground' }
  }
}

function SubagentEventLine({ event }: { event: HookEvent }) {
  const { label, color } = getEventLabel(event)
  const time = new Date(event.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  return (
    <div className="flex items-baseline gap-2 text-[10px]">
      <span className="text-muted-foreground shrink-0">{time}</span>
      <span className={cn('truncate', color)}>{label}</span>
    </div>
  )
}
