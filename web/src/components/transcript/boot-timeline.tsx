/**
 * BootTimeline - renders the pre-session boot phase as a compact timeline.
 * Each step has a status dot, timestamp, detail line, and an optional (i)
 * icon when a raw payload is available (click to expand full JSON).
 */

import type { BootStep, TranscriptBootEntry } from '@shared/protocol'
import { Info } from 'lucide-react'
import { useState } from 'react'
import { cn, haptic } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import type { DisplayGroup } from './grouping'

const STEP_LABEL: Record<BootStep, string> = {
  wrapper_started: 'wrapper started',
  settings_merged: 'settings merged',
  mcp_prepared: 'mcp config prepared',
  broker_connected: 'broker connected',
  claude_spawning: 'spawning claude',
  claude_started: 'claude started',
  awaiting_init: 'awaiting init',
  init_received: 'init received',
  session_ready: 'session ready',
  claude_exited: 'claude exited',
  boot_error: 'boot error',
}

function stepColor(step: BootStep): string {
  if (step === 'boot_error' || step === 'claude_exited') return 'text-red-400'
  if (step === 'session_ready' || step === 'init_received') return 'text-emerald-400'
  if (step === 'awaiting_init') return 'text-amber-400'
  return 'text-sky-400'
}

function BootLine({ entry, startTs }: { entry: TranscriptBootEntry; startTs: number }) {
  const [open, setOpen] = useState(false)
  const step = entry.step
  const hasRaw = entry.raw !== undefined && entry.raw !== null
  const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
  const elapsedSec = ts && startTs ? ((ts - startTs) / 1000).toFixed(1) : ''

  return (
    <div className="flex items-center gap-2 text-[10px] font-mono leading-snug">
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', stepColor(step).replace('text-', 'bg-'))} />
      <span className="text-muted-foreground/60 tabular-nums w-10 shrink-0">{elapsedSec && `+${elapsedSec}s`}</span>
      <span className={cn('font-bold uppercase tracking-wider shrink-0', stepColor(step))}>{STEP_LABEL[step]}</span>
      {entry.detail && <span className="text-foreground/70 truncate">{entry.detail}</span>}
      {hasRaw && (
        <button
          type="button"
          className="ml-auto text-muted-foreground/40 hover:text-accent transition-colors shrink-0"
          title="Show raw payload"
          onClick={() => {
            haptic('tap')
            setOpen(true)
          }}
        >
          <Info className="w-3 h-3" />
        </button>
      )}
      {open && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="font-mono max-w-xl">
            <DialogTitle className="pr-8 pb-2 border-b border-border">
              <div className="flex items-center gap-2 text-[11px]">
                <span className={stepColor(step)}>●</span>
                <span>{STEP_LABEL[step]}</span>
                {elapsedSec && <span className="text-muted-foreground/50">+{elapsedSec}s</span>}
              </div>
            </DialogTitle>
            <pre className="text-[10px] overflow-auto max-h-[60vh] p-3 bg-muted/30 rounded whitespace-pre-wrap break-all">
              {JSON.stringify(entry.raw, null, 2)}
            </pre>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

export function BootTimeline({ group }: { group: DisplayGroup }) {
  if (group.type !== 'boot') return null
  const entries = group.entries as TranscriptBootEntry[]
  const startTs = entries[0]?.timestamp ? new Date(entries[0].timestamp).getTime() : 0

  return (
    <div className="mb-3 border-l-2 border-sky-500/30 pl-3 py-1.5 bg-sky-950/10 rounded-r">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[9px] uppercase tracking-wider text-sky-400/70 font-bold">boot</span>
        <span className="text-[9px] text-muted-foreground/50">
          {entries.length} step{entries.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="space-y-0.5">
        {entries.map((entry, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: boot entries are a fixed timeline, no stable IDs
          <BootLine key={i} entry={entry} startTs={startTs} />
        ))}
      </div>
    </div>
  )
}
