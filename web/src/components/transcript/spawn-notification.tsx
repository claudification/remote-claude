/**
 * SpawnNotification -- inline transcript receipt for a resolved spawn approval.
 * One card per TranscriptSpawnNotificationEntry (one per approval decision).
 *
 * Outcomes:
 *  - spawned   -> green card with the new conversation id (clickable -> select)
 *  - denied    -> red card
 *  - failed    -> amber card with error message
 *  - timed_out -> muted card
 *
 * The (i) button opens the original SpawnRequest payload in JsonInspector so a
 * future engineer can audit what was requested.
 */

import type { TranscriptSpawnNotificationEntry } from '@shared/protocol'
import { useConversationsStore } from '@/hooks/use-conversations'
import { cn } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'
import type { DisplayGroup } from './grouping'

const OUTCOME_LABEL: Record<TranscriptSpawnNotificationEntry['outcome'], string> = {
  spawned: 'SPAWNED',
  denied: 'DENIED',
  failed: 'FAILED',
  timed_out: 'TIMED OUT',
}

const OUTCOME_STYLE: Record<TranscriptSpawnNotificationEntry['outcome'], { card: string; chip: string; dot: string }> =
  {
    spawned: {
      card: 'border-emerald-500/40 bg-emerald-500/5',
      chip: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40',
      dot: 'bg-emerald-400',
    },
    denied: {
      card: 'border-red-500/40 bg-red-500/5',
      chip: 'bg-red-500/20 text-red-200 border-red-500/40',
      dot: 'bg-red-400',
    },
    failed: {
      card: 'border-amber-500/40 bg-amber-500/5',
      chip: 'bg-amber-500/20 text-amber-200 border-amber-500/40',
      dot: 'bg-amber-400',
    },
    timed_out: {
      card: 'border-muted/40 bg-muted/5',
      chip: 'bg-muted/20 text-muted-foreground border-muted/40',
      dot: 'bg-muted-foreground',
    },
  }

function relCwd(cwd: unknown): string {
  if (typeof cwd !== 'string') return '(no cwd)'
  return cwd
}

export function SpawnNotification({ group }: { group: DisplayGroup }) {
  const entry = group.entries[0] as TranscriptSpawnNotificationEntry
  const selectConversation = useConversationsStore(s => s.selectConversation)

  const style = OUTCOME_STYLE[entry.outcome]
  const cwd = relCwd(entry.request.cwd)
  const prompt = typeof entry.request.prompt === 'string' ? entry.request.prompt : ''
  const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false }) : ''

  return (
    <div className={cn('mb-2 px-3 py-2 rounded-md border font-mono text-[11px]', style.card)}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={cn('inline-block w-1.5 h-1.5 rounded-full', style.dot)} />
        <span className={cn('px-1.5 py-0.5 text-[10px] font-bold uppercase rounded border', style.chip)}>
          {OUTCOME_LABEL[entry.outcome]}
        </span>
        <span className="text-foreground/70 text-[10px]">spawn</span>
        <span className="text-amber-300/90 truncate flex-1">{cwd}</span>
        {ts && <span className="text-muted-foreground text-[10px] tabular-nums">{ts}</span>}
        <JsonInspector data={entry.request} title={`spawn request ${entry.requestId.slice(0, 8)}`} />
      </div>
      {prompt && (
        <pre className="text-muted-foreground text-[10px] bg-background/30 px-2 py-1 rounded max-h-16 overflow-hidden whitespace-pre-wrap mb-1">
          {prompt.length > 240 ? `${prompt.slice(0, 240)}...` : prompt}
        </pre>
      )}
      {entry.outcome === 'spawned' && entry.spawnedConversationId && (
        <div className="text-emerald-300/90 text-[10px]">
          new conversation:{' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-emerald-200 cursor-pointer"
            onClick={() => selectConversation(entry.spawnedConversationId!, 'spawn-notification-link')}
          >
            {entry.spawnedConversationId.slice(0, 12)}
          </button>
        </div>
      )}
      {entry.outcome === 'failed' && entry.error && (
        <div className="text-amber-300/90 text-[10px]">error: {entry.error}</div>
      )}
      {entry.persistChosen && entry.outcome === 'spawned' && (
        <div className="text-emerald-300/70 text-[9px] mt-1">
          future spawn calls from this conversation auto-allowed
        </div>
      )}
    </div>
  )
}
