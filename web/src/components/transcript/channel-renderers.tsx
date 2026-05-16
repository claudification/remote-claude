import { cn } from '@/lib/utils'
import { Markdown } from '../markdown'
import { ConversationTag } from './conversation-tag'
import type { RenderItem } from './group-view-types'

type ChannelRenderItem = Extract<RenderItem, { kind: 'channel' }>

export function ChannelItem({ item }: { item: ChannelRenderItem }) {
  if (item.isInterConversation) {
    return <InterConversationChannel item={item} />
  }
  if (item.isDialog) {
    return <DialogChannel item={item} />
  }
  if (item.isSystem) {
    return <SystemChannel item={item} />
  }
  return (
    <div className="text-sm border-l-2 border-teal-400/40 pl-3 py-1">
      <div className="text-[10px] text-teal-400/70 uppercase font-bold tracking-wider mb-1">channel: {item.source}</div>
      <Markdown>{item.text}</Markdown>
    </div>
  )
}

function InterConversationChannel({ item }: { item: ChannelRenderItem }) {
  const intentStyles: Record<string, string> = {
    request: 'bg-yellow-400/15 text-yellow-400 border-yellow-400/30',
    response: 'bg-green-400/15 text-green-400 border-green-400/30',
    notify: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
    progress: 'bg-zinc-400/15 text-zinc-400 border-zinc-400/30',
  }
  const iStyle = intentStyles[item.intent || ''] || intentStyles.notify

  return (
    <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 px-3 py-2.5 my-1">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-mono text-teal-400/60">from</span>
        <ConversationTag idOrSlug={item.conversationId || item.source || ''} className="text-xs" />
        {item.intent && (
          <span className={cn('px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider border rounded', iStyle)}>
            {item.intent}
          </span>
        )}
      </div>
      <div className="text-sm">
        <Markdown copyable>{item.text}</Markdown>
      </div>
    </div>
  )
}

function DialogChannel({ item }: { item: ChannelRenderItem }) {
  const statusStyles: Record<string, string> = {
    submitted: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
    cancelled: 'bg-zinc-500/15 text-muted-foreground border-zinc-500/20',
    timeout: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  }
  const sStyle = statusStyles[item.dialogStatus || 'submitted'] || statusStyles.submitted

  let userValues: Array<[string, unknown]> = []
  try {
    const parsed = JSON.parse(item.text)
    if (typeof parsed === 'object' && parsed !== null) {
      userValues = Object.entries(parsed)
    }
  } catch {
    /* not JSON, show as text */
  }

  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2.5 my-1">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-mono text-violet-400/60">dialog</span>
        <span className={cn('px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider border rounded', sStyle)}>
          {item.dialogStatus || 'submitted'}
        </span>
        {item.dialogAction && (
          <span className="px-1.5 py-0.5 bg-violet-500/20 text-violet-400 border border-violet-500/30 rounded text-[9px] font-bold">
            {item.dialogAction}
          </span>
        )}
      </div>
      {userValues.length > 0 ? (
        <DialogValues values={userValues} />
      ) : (
        <div className="text-sm">
          <Markdown>{item.text}</Markdown>
        </div>
      )}
    </div>
  )
}

function DialogValues({ values }: { values: Array<[string, unknown]> }) {
  return (
    <div className="text-[11px] font-mono space-y-1">
      {values.map(([key, val]) => (
        <div key={key} className="flex items-start gap-2">
          <span className="text-violet-400 font-bold shrink-0">{key}</span>
          <span className="text-foreground/80 break-all">
            {typeof val === 'boolean' ? (
              <span
                className={cn(
                  'px-1.5 py-0.5 rounded text-[9px] font-bold border',
                  val
                    ? 'bg-green-500/15 text-green-400 border-green-500/30'
                    : 'bg-zinc-500/15 text-muted-foreground/50 border-zinc-500/20',
                )}
              >
                {String(val)}
              </span>
            ) : Array.isArray(val) ? (
              <span className="flex flex-wrap gap-1">
                {val.map((v, j) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: display-only array values, no stable IDs
                    key={j}
                    className="px-1.5 py-0.5 bg-violet-500/15 text-violet-300 border border-violet-500/25 rounded text-[9px]"
                  >
                    {String(v)}
                  </span>
                ))}
              </span>
            ) : typeof val === 'string' && val.length > 0 ? (
              <span className="text-foreground/90">{val}</span>
            ) : (
              <span className="text-muted-foreground/50">{String(val)}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

function SystemChannel({ item }: { item: ChannelRenderItem }) {
  const isRecap = item.systemKind === 'recap-completed'
  const systemStyle =
    item.systemKind === 'timeout'
      ? 'border-amber-500/40 bg-amber-500/5 text-amber-300/90'
      : item.systemKind === 'error' || item.systemKind === 'failed'
        ? 'border-red-500/40 bg-red-500/5 text-red-300/90'
        : item.systemKind === 'ok' || item.systemKind === 'success'
          ? 'border-green-500/40 bg-green-500/5 text-green-300/90'
          : isRecap
            ? 'border-teal-500/40 bg-teal-500/5 text-teal-200/90'
            : 'border-zinc-500/40 bg-zinc-500/5 text-zinc-300/90'

  return (
    <div className={cn('text-sm rounded-md border-l-2 px-3 py-2 my-1', systemStyle)}>
      <div className="text-[10px] uppercase font-bold tracking-wider mb-1 opacity-70">
        {isRecap ? 'recap ready' : `system${item.systemKind ? ` · ${item.systemKind}` : ''}`}
      </div>
      <Markdown>{item.text}</Markdown>
      {isRecap && item.recapId && (
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new CustomEvent('rclaude-recap-open', { detail: { recapId: item.recapId } }))
          }
          className="mt-1.5 rounded border border-teal-500/40 bg-teal-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-teal-300 hover:bg-teal-500/25"
        >
          Open recap
        </button>
      )}
    </div>
  )
}
