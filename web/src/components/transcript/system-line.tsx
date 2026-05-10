import { parseRecapContent } from '@shared/recap'
import { JsonInspector } from '../json-inspector'
import { formatDuration } from './group-view-types'
import type { DisplayGroup } from './grouping'

export function SystemLine({ group, time }: { group: DisplayGroup; time: string }) {
  const entry = group.entries[0] as Record<string, unknown>
  const sub = group.systemSubtype || ''
  const content = (entry.content as string) || ''

  let text = ''
  let color = 'text-muted-foreground'

  switch (sub) {
    case 'local_command': {
      const stripped = content
        .replace(/<\/?(?:local-command-stdout|command-name|command-message|command-args|local-command-caveat)>/g, '')
        .trim()
      text = stripped
      if (stripped.startsWith('Unknown skill') || stripped.startsWith('Error') || stripped.startsWith('Failed'))
        color = 'text-red-400'
      if (stripped.startsWith('Session renamed to:')) color = 'text-cyan-400/70'
      break
    }
    case 'api_retry':
      text = `API retry ${entry.attempt}/${entry.max_retries} (${entry.error_status || 'timeout'}) - retrying in ${Math.ceil((entry.retry_delay_ms as number) / 1000)}s`
      color = 'text-amber-400'
      break
    case 'rate_limit': {
      const retryMs = entry.retryAfterMs as number
      const info = (entry.raw as Record<string, unknown>)?.rate_limit_info as Record<string, unknown> | undefined
      const limitType = info?.rateLimitType as string | undefined
      text = `Rate limited${limitType ? ` (${limitType})` : ''}${retryMs ? ` - retry in ${Math.ceil(retryMs / 1000)}s` : ''}`
      color = 'text-amber-400/70'
      break
    }
    case 'informational':
      text = content
      color = 'text-cyan-400/70'
      break
    case 'compact_boundary':
      text = 'Context compacted'
      color = 'text-purple-400/70'
      break
    case 'session_state_changed':
      text = `Conversation: ${entry.state}`
      color = 'text-muted-foreground/70'
      break
    case 'task_notification': {
      const status = entry.status as string
      const summary = entry.summary as string
      text = `Task ${status}${summary ? `: ${summary}` : ''}`
      color = status === 'completed' ? 'text-emerald-400' : status === 'failed' ? 'text-red-400' : 'text-amber-400'
      break
    }
    case 'task_progress': {
      const desc = (entry.description as string) || ''
      const tokens = (entry.usage as Record<string, unknown>)?.total_tokens
      text = `${desc}${tokens ? ` (${tokens} tokens)` : ''}`
      color = 'text-muted-foreground/70'
      break
    }
    case 'turn_duration': {
      const dMs = (entry.durationMs as number) || (entry.duration_ms as number) || 0
      const dApiMs = (entry.durationApiMs as number) || (entry.duration_api_ms as number)
      const msgCount = entry.messageCount as number
      text = dMs
        ? `Turn: ${formatDuration(dMs / 1000)}${dApiMs ? ` (API: ${formatDuration(dApiMs / 1000)})` : ''}${msgCount ? ` -- ${msgCount} messages` : ''}`
        : 'Turn ended'
      color = 'text-muted-foreground/50'
      break
    }
    case 'memory_saved':
      text = 'Memory saved'
      color = 'text-cyan-400/70'
      break
    case 'agents_killed':
      text = 'Background agents stopped'
      color = 'text-red-400/70'
      break
    case 'chat_api_error':
      text = content
      color = 'text-red-400'
      break
    case 'permission_retry':
      text = `Allowed: ${(entry.commands as string[])?.join(', ') || content}`
      color = 'text-green-400/70'
      break
    case 'stop_hook_summary': {
      const reason = (entry.stopReason as string) || (entry.stop_reason as string) || 'end_turn'
      const numTurns = (entry.numTurns as number) || (entry.num_turns as number)
      const parts = [`Stop: ${reason}`]
      if (numTurns) parts.push(`${numTurns} turns`)
      text = parts.join(' -- ')
      color = 'text-muted-foreground/50'
      break
    }
    case 'scheduled_task_fire':
      text = content
        ? `Scheduled: ${content.length > 80 ? `${content.slice(0, 80)}...` : content}`
        : 'Scheduled task fired'
      color = 'text-amber-400/70'
      break
    case 'away_summary': {
      const parsed = parseRecapContent(content)
      return (
        <div className="my-3 mx-auto max-w-[95%]">
          <div className="border border-zinc-600/40 bg-zinc-800/30 rounded px-4 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[9px] font-bold font-mono uppercase tracking-widest text-zinc-400/70">recap</span>
              <span className="flex-1 h-px bg-zinc-600/30" />
              <span className="text-muted-foreground/40 text-[10px]">{time}</span>
              <JsonInspector title="away_summary" data={entry as Record<string, unknown>} raw={entry} />
            </div>
            <div className="text-[11px] text-zinc-300/80 leading-relaxed">
              {parsed.title && <span className="font-medium text-zinc-200/90">{parsed.title}: </span>}
              {parsed.recap}
            </div>
          </div>
        </div>
      )
    }
    default:
      text = content || `[${sub}]`
      break
  }

  if (!text) return null

  return (
    <div className="mb-1 flex items-center justify-center gap-2 text-[10px]">
      <span className={color}>{text}</span>
      <span className="text-muted-foreground/40">{time}</span>
      <JsonInspector title={sub || 'system'} data={entry as Record<string, unknown>} raw={entry} />
    </div>
  )
}
