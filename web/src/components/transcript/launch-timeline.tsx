/**
 * LaunchTimeline - renders a CC launch lifecycle (initial spawn or /clear
 * reboot) as a compact transcript card. Each step has a status dot, elapsed
 * time, detail, and an (i) button that opens the full raw payload in the
 * global JsonInspector dialog.
 *
 * One card per launchId. Initial spawn and every /clear reboot get their
 * own card so the user always sees how the CC they're talking to was
 * launched + what changed on each reboot.
 */

import type { TranscriptLaunchEntry, WrapperLaunchStep } from '@shared/protocol'
import { cn } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'
import type { DisplayGroup } from './grouping'

const STEP_LABEL: Record<WrapperLaunchStep, string> = {
  launch_started: 'launching claude',
  clear_requested: '/clear requested',
  process_killed: 'process killed',
  mcp_reset: 'mcp reset',
  settings_regenerated: 'settings regenerated',
  init_received: 'init received',
  rekeyed: 'rekeyed',
  ready: 'ready',
  model_changed: 'model changed',
  permission_mode_changed: 'permission mode changed',
  fast_mode_changed: 'fast mode changed',
  mcp_servers_changed: 'mcp servers changed',
  tools_changed: 'tools changed',
  slash_commands_changed: 'slash commands changed',
  skills_changed: 'skills changed',
  agents_changed: 'agents changed',
  plugins_changed: 'plugins changed',
  conversation_exit: 'session exit',
}

const LIVE_STEPS = new Set<WrapperLaunchStep>([
  'model_changed',
  'permission_mode_changed',
  'fast_mode_changed',
  'mcp_servers_changed',
  'tools_changed',
  'slash_commands_changed',
  'skills_changed',
  'agents_changed',
  'plugins_changed',
])

function stepColor(step: WrapperLaunchStep): string {
  if (step === 'clear_requested') return 'text-amber-400'
  if (step === 'process_killed' || step === 'conversation_exit') return 'text-red-400'
  if (step === 'init_received' || step === 'ready') return 'text-emerald-400'
  if (step === 'rekeyed') return 'text-violet-400'
  if (LIVE_STEPS.has(step)) return 'text-cyan-400'
  return 'text-sky-400'
}

function LaunchLine({ entry, startTs }: { entry: TranscriptLaunchEntry; startTs: number }) {
  const step = entry.step
  const hasRaw = entry.raw !== undefined && entry.raw !== null && Object.keys(entry.raw).length > 0
  const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
  const elapsedSec = ts && startTs ? ((ts - startTs) / 1000).toFixed(1) : ''

  return (
    <div className="flex items-center gap-2 text-[10px] font-mono leading-snug">
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', stepColor(step).replace('text-', 'bg-'))} />
      <span className="text-muted-foreground/60 tabular-nums w-10 shrink-0">{elapsedSec && `+${elapsedSec}s`}</span>
      <span className={cn('font-bold uppercase tracking-wider shrink-0', stepColor(step))}>{STEP_LABEL[step]}</span>
      {entry.detail && <span className="text-foreground/70 truncate">{entry.detail}</span>}
      {hasRaw && (
        <span className="ml-auto shrink-0">
          <JsonInspector title={`launch: ${STEP_LABEL[step]}`} data={entry.raw as Record<string, unknown>} />
        </span>
      )}
    </div>
  )
}

export function LaunchTimeline({ group }: { group: DisplayGroup }) {
  if (group.type !== 'launch') return null
  const entries = group.entries as TranscriptLaunchEntry[]
  if (entries.length === 0) return null
  const phase = entries[0].phase
  const startTs = entries[0].timestamp ? new Date(entries[0].timestamp).getTime() : 0
  const borderClass =
    phase === 'reboot'
      ? 'border-amber-500/30 bg-amber-950/10'
      : phase === 'live'
        ? 'border-cyan-500/30 bg-cyan-950/10'
        : 'border-sky-500/30 bg-sky-950/10'
  const labelClass =
    phase === 'reboot' ? 'text-amber-400/80' : phase === 'live' ? 'text-cyan-400/80' : 'text-sky-400/70'
  const label = phase === 'reboot' ? 'relaunch (/clear)' : phase === 'live' ? 'session changed' : 'launch'

  return (
    <div className={cn('mb-3 border-l-2 pl-3 py-1.5 rounded-r', borderClass)}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={cn('text-[9px] uppercase tracking-wider font-bold', labelClass)}>{label}</span>
        <span className="text-[9px] text-muted-foreground/50">
          {entries.length} step{entries.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="space-y-0.5">
        {entries.map((entry, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: launch entries are a fixed ordered timeline
          <LaunchLine key={i} entry={entry} startTs={startTs} />
        ))}
      </div>
    </div>
  )
}
