/**
 * Shared "Recap" submenu used in project + pinned-project + conversation
 * context menus, and in the command palette via createRecap().
 *
 * createRecap() is the single entry point that all UI surfaces call into:
 *   - context menus pass projectUri = the project the user right-clicked
 *   - palette commands pass projectUri = '*' for cross-project, or
 *     resolveCurrentProject() for "this project (preset)"
 *   - the custom-range action opens RecapCustomRangeDialog
 *
 * The actual recap_create wire payload lives here so the WS message format
 * (timeZone, period spec) doesn't drift across surfaces.
 */

import type { RecapPeriodLabel } from '@shared/protocol'
import { ContextMenu } from 'radix-ui'
import { wsSend } from '@/hooks/use-conversations'
import { haptic } from '@/lib/utils'
import { openRecapCustomRangeDialog } from './recap-custom-range-dialog'

const menuItemClass =
  'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

const PRESET_LABELS: { label: RecapPeriodLabel; display: string }[] = [
  { label: 'today', display: 'Today' },
  { label: 'yesterday', display: 'Yesterday' },
  { label: 'last_7', display: 'Last 7 days' },
  { label: 'last_30', display: 'Last 30 days' },
  { label: 'this_week', display: 'This week' },
  { label: 'this_month', display: 'This month' },
]

function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof tz === 'string' && tz.length > 0) return tz
  } catch {
    /* fall through */
  }
  return 'UTC'
}

export interface CreateRecapOptions {
  projectUri: string
  label: RecapPeriodLabel
  start?: number
  end?: number
  signals?: string[]
  force?: boolean
}

/** Send recap_create over the dashboard WS. Returns whether the send was
 *  attempted (false only when the WS is not OPEN). */
export function createRecap(opts: CreateRecapOptions): boolean {
  const period: { label: RecapPeriodLabel; start?: number; end?: number } = { label: opts.label }
  if (opts.label === 'custom') {
    if (opts.start == null || opts.end == null) return false
    period.start = opts.start
    period.end = opts.end
  }
  return wsSend('recap_create', {
    projectUri: opts.projectUri,
    period,
    timeZone: browserTimeZone(),
    ...(opts.signals && opts.signals.length ? { signals: opts.signals } : {}),
    ...(opts.force ? { force: true } : {}),
  })
}

/** "View past recaps..." -- opens the recap-history modal (Phase 10). */
export function openRecapHistory(projectUri?: string) {
  window.dispatchEvent(new CustomEvent('rclaude-recap-history-open', { detail: { projectUri } }))
}

export interface RecapSubmenuProps {
  /** Project URI for per-project recaps, or '*' for cross-project. */
  projectUri: string
  /** Submenu label override -- defaults to "Recap". */
  label?: string
}

export function RecapSubmenu({ projectUri, label = 'Recap' }: RecapSubmenuProps) {
  function trigger(opts: CreateRecapOptions) {
    haptic('tap')
    createRecap(opts)
  }

  function customRange() {
    haptic('tap')
    openRecapCustomRangeDialog({ projectUri })
  }

  function viewHistory() {
    haptic('tap')
    openRecapHistory(projectUri === '*' ? undefined : projectUri)
  }

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={menuItemClass}>
        {label} <span className="ml-auto pl-2 opacity-60">▶</span>
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className="min-w-[170px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          {PRESET_LABELS.map(p => (
            <ContextMenu.Item
              key={p.label}
              className={menuItemClass}
              onSelect={() => trigger({ projectUri, label: p.label })}
            >
              {p.display}
            </ContextMenu.Item>
          ))}
          <ContextMenu.Item className={menuItemClass} onSelect={customRange}>
            Custom range...
          </ContextMenu.Item>
          <ContextMenu.Separator className="h-px bg-border my-1" />
          <ContextMenu.Item className={menuItemClass} onSelect={viewHistory}>
            View past recaps...
          </ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  )
}
