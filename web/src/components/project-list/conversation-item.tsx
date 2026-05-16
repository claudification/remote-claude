import { Clock } from 'lucide-react'
import { memo, type ReactNode, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'
import {
  formatCost,
  getCacheTimerInfo,
  getConversationCost,
  getCostBgColor,
  getCostColor,
  getCostLevel,
} from '@/lib/cost-utils'
import { useKeyLayer } from '@/lib/key-layers'
import type { Conversation } from '@/lib/types'
import { projectPath } from '@/lib/types'
import {
  cn,
  contextWindowSize,
  formatAge,
  formatDurationMs,
  formatEffort,
  formatModel,
  formatPermissionMode,
  haptic,
  projectDisplayName,
  truncate,
} from '@/lib/utils'
import { Markdown } from '../markdown'
import { ProjectSettingsButton, ProjectSettingsEditor, renderProjectIcon } from '../project-settings-editor'
import { ShareIndicator } from '../share-panel'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { BackendIcon } from './backend-icon'
import { ConversationContextMenu } from './conversation-context-menu'
import { InlineConfirmButton } from './inline-confirm-button'

// ─── Shared visual components ──────────────────────────────────────

function StatusIndicator({ status, adHoc }: { status: Conversation['status']; adHoc?: boolean }) {
  // Ad-hoc conversations get a lightning bolt instead of status dots
  if (adHoc) {
    if (status === 'ended') {
      return (
        <span className="text-[10px] shrink-0" title="ad-hoc completed">
          &#x2713;
        </span>
      )
    }
    return (
      <span
        className={cn('text-xs shrink-0', status === 'active' ? 'text-amber-400 animate-pulse' : 'text-amber-400/60')}
        title="ad-hoc task"
      >
        &#x26A1;
      </span>
    )
  }
  if (status === 'ended') {
    return <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-ended text-foreground">ended</span>
  }
  if (status === 'active') {
    return (
      <span className="w-3 h-3 shrink-0 flex items-center justify-center" title="working">
        <span
          className="w-2.5 h-2.5 rounded-full animate-spin"
          style={{ border: '2px solid var(--active)', borderTopColor: 'transparent' }}
        />
      </span>
    )
  }
  if (status === 'starting') {
    return (
      <span
        className="w-2 h-2 rounded-full shrink-0 animate-pulse"
        style={{ backgroundColor: 'var(--idle)' }}
        title="starting"
      />
    )
  }
  if (status === 'booting') {
    return (
      <span className="w-3 h-3 shrink-0 flex items-center justify-center" title="booting">
        <span
          className="w-2.5 h-2.5 rounded-full animate-spin"
          style={{ border: '2px solid var(--info)', borderTopColor: 'transparent' }}
        />
      </span>
    )
  }
  return <span className="w-2 h-2 rounded-full shrink-0 bg-idle" title={status} />
}

// ─── Token formatting ─────────────────────────────────────────────

function formatTokenCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

// ─── Launch parameters section ───────────────────────────────────

const SECRET_KEY_PATTERN = /TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE/i

function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length)
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(value.length - 8, 12))}${value.slice(-4)}`
}

function LaunchParamRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-[10px] uppercase tracking-wider">{label}</span>
      <span className="ml-auto text-foreground/80 truncate max-w-[220px]">{value}</span>
    </div>
  )
}

function LaunchParamsSection({ conversation }: { conversation: Conversation }) {
  const lc = conversation.launchConfig
  const [revealEnv, setRevealEnv] = useState(false)
  const envEntries = lc?.env ? Object.entries(lc.env) : []

  // Fallbacks so legacy conversations (no launchConfig captured) still show something
  const headless: boolean | undefined = lc?.headless ?? (conversation.capabilities?.includes('headless') || undefined)
  const autocompactPct = lc?.autocompactPct ?? conversation.autocompactPct
  const permissionMode = lc?.permissionMode
  const bare = lc?.bare
  const repl = lc?.repl
  const maxBudgetUsd = lc?.maxBudgetUsd

  const hasAnyCore =
    (conversation.backend && conversation.backend !== 'claude') ||
    headless !== undefined ||
    !!permissionMode ||
    bare ||
    repl ||
    autocompactPct !== undefined ||
    maxBudgetUsd !== undefined

  if (!hasAnyCore && envEntries.length === 0) return null

  return (
    <>
      <div className="border-t border-border" />
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Launch</span>
          {!lc && (
            <span className="text-[9px] text-muted-foreground/50" title="launch config not captured at spawn time">
              (partial)
            </span>
          )}
        </div>
        <div className="space-y-1 pl-1">
          {conversation.backend && conversation.backend !== 'claude' && (
            <LaunchParamRow
              label="backend"
              value={
                <span className="flex items-center gap-1">
                  <BackendIcon backend={conversation.backend} size={10} />
                  {conversation.backend}
                </span>
              }
            />
          )}
          {headless !== undefined && (
            <LaunchParamRow
              label="mode"
              value={
                <span className={headless ? 'text-sky-400' : 'text-amber-400'}>{headless ? 'headless' : 'PTY'}</span>
              }
            />
          )}
          {permissionMode && <LaunchParamRow label="perms" value={permissionMode} />}
          {bare && <LaunchParamRow label="bare" value="yes" />}
          {repl && <LaunchParamRow label="repl" value="yes" />}
          {autocompactPct !== undefined && <LaunchParamRow label="autocompact" value={`${autocompactPct}%`} />}
          {maxBudgetUsd !== undefined && <LaunchParamRow label="budget" value={`$${maxBudgetUsd.toFixed(2)}`} />}
        </div>

        {envEntries.length > 0 && (
          <div className="pt-1">
            <div className="flex items-center gap-2 pb-1">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
                Env ({envEntries.length})
              </span>
              <button
                type="button"
                className="ml-auto text-[9px] text-muted-foreground hover:text-foreground cursor-pointer px-1.5 py-0.5 border border-border hover:border-primary transition-colors"
                onClick={e => {
                  e.stopPropagation()
                  haptic('tap')
                  setRevealEnv(v => !v)
                }}
              >
                {revealEnv ? 'hide secrets' : 'reveal secrets'}
              </button>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px] pl-1">
              {envEntries.map(([k, v]) => {
                const isSecret = SECRET_KEY_PATTERN.test(k)
                const display = isSecret && !revealEnv ? maskSecret(v) : v
                return (
                  <div key={k} className="contents">
                    <span className="text-muted-foreground truncate max-w-[140px]" title={k}>
                      {k}
                    </span>
                    <span
                      className={cn(
                        'text-right tabular-nums truncate',
                        isSecret ? 'text-amber-400/80' : 'text-foreground/70',
                      )}
                      title={display}
                    >
                      {display}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

// ─── Conversation info dialog (replaces hover tooltip) ────────────────

function ConversationInfoDialog({
  conversation,
  open,
  onOpenChange,
}: {
  conversation: Conversation
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const resolvedModel = conversation.model
  const effort = formatEffort(conversation.effortLevel)
  const cost = conversation.stats ? getConversationCost(conversation.stats, resolvedModel) : null
  const duration = conversation.lastActivity - conversation.startedAt
  const isAdHoc = conversation.capabilities?.includes('ad-hoc')

  useKeyLayer({ Escape: () => onOpenChange(false) }, { id: 'conversation-info-dialog', enabled: open })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="font-mono max-w-sm p-4">
        <DialogTitle className="pr-8 pb-2 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-accent">{'\u24D8'}</span>
            <span>Conversation Info</span>
            <span className="text-[10px] text-muted-foreground/50 font-normal">{conversation.id.slice(0, 12)}</span>
          </div>
        </DialogTitle>
        <div className="space-y-2 text-[11px]">
          {/* Model + effort */}
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Model</span>
            <span className="ml-auto text-primary">{formatModel(resolvedModel)}</span>
            {effort && (
              <span className="text-foreground/60">
                {effort.symbol} {effort.label}
              </span>
            )}
          </div>

          <div className="border-t border-border" />

          {/* Cost */}
          {cost && cost.cost > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Cost</span>
              <span className={cn('ml-auto font-bold', getCostColor(cost.cost))}>
                {formatCost(cost.cost, cost.exact)}
              </span>
            </div>
          )}

          {/* Duration */}
          {duration > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Duration</span>
              <span className="ml-auto text-foreground/80">{formatDurationMs(duration)}</span>
            </div>
          )}

          {/* Turn count */}
          {conversation.stats && conversation.stats.turnCount > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Turns</span>
              <span className="ml-auto text-foreground/80">{conversation.stats.turnCount}</span>
            </div>
          )}

          {/* Token usage */}
          {conversation.stats &&
            (conversation.stats.totalInputTokens > 0 || conversation.stats.totalOutputTokens > 0) && (
              <>
                <div className="border-t border-border" />
                <div className="space-y-1">
                  <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Tokens</span>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                    <span className="text-muted-foreground">input</span>
                    <span className="text-right tabular-nums text-foreground/80">
                      {formatTokenCount(conversation.stats.totalInputTokens)}
                    </span>
                    <span className="text-muted-foreground">output</span>
                    <span className="text-right tabular-nums text-foreground/80">
                      {formatTokenCount(conversation.stats.totalOutputTokens)}
                    </span>
                    {conversation.stats.totalCacheRead > 0 && (
                      <>
                        <span className="text-muted-foreground">cache read</span>
                        <span className="text-right tabular-nums text-emerald-400">
                          {formatTokenCount(conversation.stats.totalCacheRead)}
                        </span>
                      </>
                    )}
                    {conversation.stats.totalCacheCreation > 0 && (
                      <>
                        <span className="text-muted-foreground">cache write</span>
                        <span className="text-right tabular-nums text-amber-400">
                          {formatTokenCount(conversation.stats.totalCacheCreation)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </>
            )}

          {/* Context window */}
          {conversation.stats && conversation.stats.totalInputTokens > 0 && (
            <>
              <div className="border-t border-border" />
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Context</span>
                <span className="ml-auto text-foreground/80">
                  {formatTokenCount(conversation.stats.totalInputTokens)} /{' '}
                  {formatTokenCount(conversation.contextWindow ?? contextWindowSize(resolvedModel))}
                </span>
              </div>
            </>
          )}

          {/* Git branch */}
          {conversation.gitBranch && (
            <>
              <div className="border-t border-border" />
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Branch</span>
                <span className="ml-auto text-sky-400 truncate max-w-[200px]">{conversation.gitBranch}</span>
              </div>
            </>
          )}

          {/* Identity */}
          {conversation.claudeAuth?.email && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Auth</span>
              <span className="ml-auto text-foreground/80 truncate max-w-[200px]">
                {conversation.claudeAuth.email}
                {conversation.claudeAuth.orgName && (
                  <span className="text-muted-foreground"> ({conversation.claudeAuth.orgName})</span>
                )}
              </span>
            </div>
          )}

          {/* Launch parameters */}
          <LaunchParamsSection conversation={conversation} />

          {/* Ad-hoc result preview */}
          {isAdHoc && conversation.resultText && (
            <>
              <div className="border-t border-border" />
              <div className="space-y-1">
                <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Result</span>
                <div className="text-[10px] text-foreground/70 line-clamp-6 break-words">
                  {truncate(conversation.resultText, 400)}
                </div>
              </div>
            </>
          )}

          {/* Conversation ID */}
          <div className="border-t border-border/50" />
          <div className="text-[9px] text-muted-foreground/50 select-all">{conversation.id}</div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ConversationInfoButton({ conversation, visible }: { conversation: Conversation; visible: boolean }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className={cn(
          'text-[10px] text-muted-foreground/50 hover:text-accent cursor-pointer transition-all shrink-0',
          visible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
        title="Conversation info"
        onClick={e => {
          e.stopPropagation()
          haptic('tap')
          setOpen(true)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation()
            haptic('tap')
            setOpen(true)
          }
        }}
      >
        {'\u24D8'}
      </span>
      <ConversationInfoDialog conversation={conversation} open={open} onOpenChange={setOpen} />
    </>
  )
}

// ─── Ad-hoc result text modal ─────────────────────────────────────

function ResultTextModal({ conversation }: { conversation: Conversation }) {
  const [open, setOpen] = useState(false)

  if (!conversation.resultText) return null

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className="text-[10px] text-teal-400/60 hover:text-teal-400 cursor-pointer transition-colors shrink-0"
        title="View result"
        onClick={e => {
          e.stopPropagation()
          haptic('tap')
          setOpen(true)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation()
            haptic('tap')
            setOpen(true)
          }
        }}
      >
        {'\u2398'}
      </span>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="font-mono">
          <DialogTitle className="pr-8 pb-2 border-b border-border">
            <div className="flex items-center gap-2">
              <span className="text-teal-400">{'\u26A1'}</span>
              <span>Ad-hoc Result</span>
              <span className="text-[10px] text-muted-foreground/50 font-normal">{conversation.id.slice(0, 12)}</span>
              <button
                type="button"
                className="ml-auto mr-6 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer px-2 py-1 border border-border hover:border-primary"
                onClick={() => {
                  navigator.clipboard.writeText(conversation.resultText || '')
                  haptic('success')
                }}
              >
                copy
              </button>
            </div>
          </DialogTitle>
          <div className="overflow-y-auto max-h-[70vh] p-4">
            <Markdown>{conversation.resultText}</Markdown>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function DismissButton({ conversationId }: { conversationId: string }) {
  const dismissConversation = useConversationsStore(s => s.dismissConversation)

  return (
    <InlineConfirmButton
      onConfirm={() => dismissConversation(conversationId)}
      trigger={requestConfirm => (
        <div
          role="button"
          tabIndex={0}
          onClick={requestConfirm}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') requestConfirm(e)
          }}
          className="opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 text-muted-foreground/40 hover:text-destructive transition-opacity cursor-pointer px-0.5"
          title="Dismiss conversation"
        >
          {'\u2715'}
        </div>
      )}
    />
  )
}

// ─── Inline rename input ─────────────────────────────────────────────

function InlineRename({ conversation }: { conversation: Conversation }) {
  const renameConversation = useConversationsStore(s => s.renameConversation)
  const setRenamingConversationId = useConversationsStore(s => s.setRenamingConversationId)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(conversation.title || '')

  useEffect(() => {
    // Delay to let Radix context menu fully close and release focus
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 50)
    return () => clearTimeout(t)
  }, [])

  function submit() {
    renameConversation(conversation.id, value.trim())
    haptic('success')
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={e => setValue(e.target.value)}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') setRenamingConversationId(null)
      }}
      onClick={e => e.stopPropagation()}
      onBlur={submit}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      data-form-type="other"
      className="w-full bg-background/80 border border-accent text-[10px] font-mono px-1 py-0.5 outline-none text-foreground"
      placeholder="conversation name"
    />
  )
}

// ─── Inline description input ───────────────────────────────────────

function InlineDescription({ conversation }: { conversation: Conversation }) {
  const updateDescription = useConversationsStore(s => s.updateDescription)
  const setEditingDescriptionConversationId = useConversationsStore(s => s.setEditingDescriptionConversationId)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(conversation.description || '')

  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 50)
    return () => clearTimeout(t)
  }, [])

  function submit() {
    updateDescription(conversation.id, value.trim())
    haptic('success')
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={e => setValue(e.target.value)}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') setEditingDescriptionConversationId(null)
      }}
      onClick={e => e.stopPropagation()}
      onBlur={submit}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      data-form-type="other"
      className="w-full bg-background/80 border border-accent/50 text-[10px] font-mono px-1 py-0.5 outline-none text-muted-foreground italic"
      placeholder="conversation description"
    />
  )
}

// ─── Conversation card outer agent host (shared by Full + Compact) ────────

function ConversationItemShell({
  conversation,
  isSelected,
  displayColor,
  variant,
  onClick,
  children,
}: {
  conversation: Conversation
  isSelected: boolean
  displayColor: string | undefined
  variant: 'full' | 'compact'
  onClick: () => void
  children: ReactNode
}) {
  return (
    <div
      data-conversation-id={conversation.id}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') onClick()
      }}
      className={cn(
        'w-full text-left border transition-colors group cursor-pointer',
        variant === 'compact' ? 'p-2 pl-4 text-[11px]' : 'p-3',
        isSelected && conversation.planMode
          ? 'border-blue-500 bg-blue-500/15 ring-1 ring-blue-500/50 shadow-[0_0_8px_rgba(59,130,246,0.2)]'
          : isSelected
            ? 'border-accent bg-accent/15 ring-1 ring-accent/50 shadow-[0_0_8px_rgba(122,162,247,0.15)]'
            : conversation.planMode
              ? 'border-blue-500/40 hover:border-blue-400/60'
              : displayColor
                ? 'border-border hover:border-primary'
                : 'border-border hover:border-primary hover:bg-card',
      )}
      style={
        isSelected && conversation.planMode
          ? {
              borderLeftColor: 'rgb(59 130 246)',
              borderLeftWidth: '3px',
            }
          : !isSelected && conversation.planMode
            ? {
                borderLeftColor: 'rgb(59 130 246)',
                borderLeftWidth: '3px',
                backgroundColor: 'color-mix(in oklch, rgb(59 130 246) 8%, transparent)',
              }
            : displayColor && !isSelected
              ? { borderLeftColor: displayColor, borderLeftWidth: '3px', backgroundColor: `${displayColor}15` }
              : undefined
      }
    >
      {children}
    </div>
  )
}

// ─── Running tasks / subagents / teammates block (shared) ─────────

function ConversationItemTasksBlock({
  conversation,
  selectedSubagentId,
}: {
  conversation: Conversation
  selectedSubagentId: string | null
}) {
  const hasContent =
    conversation.activeTasks.length > 0 ||
    conversation.pendingTasks.length > 0 ||
    conversation.subagents.length > 0 ||
    conversation.teammates.some(t => t.status === 'working')
  if (!hasContent) return null

  const overflow = conversation.activeTasks.length + conversation.pendingTasks.length - 5
  const now = Date.now()

  return (
    <div className="mt-1 space-y-0.5">
      {conversation.activeTasks.slice(0, 5).map(task => (
        <div key={task.id} className="text-[11px] text-active/80 font-mono truncate pl-1">
          <span className="text-active mr-1">{'\u25B8'}</span>
          {task.subject}
        </div>
      ))}
      {conversation.pendingTasks.slice(0, Math.max(0, 5 - conversation.activeTasks.length)).map(task => (
        <div key={task.id} className="text-[11px] text-amber-400/50 font-mono truncate pl-1">
          <span className="text-amber-400/40 mr-1">{'\u25CB'}</span>
          {task.subject}
        </div>
      ))}
      {overflow > 0 && <div className="text-[10px] text-muted-foreground pl-1 font-mono">..{overflow} more</div>}
      {conversation.subagents
        .filter(a => a.status === 'running')
        .map(a => (
          <div
            key={a.agentId}
            className={cn(
              'text-[11px] text-pink-400/80 font-mono truncate pl-1',
              selectedSubagentId === a.agentId && 'text-pink-300 font-bold',
            )}
          >
            <span className="text-pink-400 mr-1">{'\u25CF'}</span>
            {a.description || a.agentType} <span className="text-pink-400/50">{a.agentId.slice(0, 6)}</span>
          </div>
        ))}
      {conversation.subagents
        .filter(a => a.status === 'stopped' && a.stoppedAt && now - a.stoppedAt < 30 * 60 * 1000)
        .map(a => (
          <div
            key={a.agentId}
            className={cn(
              'text-[11px] text-pink-400/40 font-mono truncate pl-1',
              selectedSubagentId === a.agentId && 'text-pink-400/80 font-bold',
            )}
          >
            <span className="mr-1">{'\u25CB'}</span>
            {a.description || a.agentType} <span className="text-pink-400/30">{a.agentId.slice(0, 6)}</span>
          </div>
        ))}
      {conversation.teammates
        .filter(t => t.status === 'working')
        .map(t => (
          <div key={t.name} className="text-[11px] text-purple-400/80 font-mono truncate pl-1">
            <span className="text-purple-400 mr-1">{'\u2691'}</span>
            {t.name}
            {t.currentTaskSubject ? `: ${t.currentTaskSubject}` : ''}
          </div>
        ))}
    </div>
  )
}

// ─── Full-size conversation card ───────────────────────────────────────

const ConversationItemFull = memo(function ConversationItemFull({ conversation }: { conversation: Conversation }) {
  const isSelected = useConversationsStore(s => s.selectedConversationId === conversation.id)
  const selectedSubagentId = useConversationsStore(s =>
    s.selectedConversationId === conversation.id ? s.selectedSubagentId : null,
  )
  const selectConversation = useConversationsStore(s => s.selectConversation)

  const openTab = useConversationsStore(s => s.openTab)
  const ps = useConversationsStore(s => s.projectSettings[conversation.project])
  const showContextBar = useConversationsStore(s => s.controlPanelPrefs.showContextInList)
  const showCost = useConversationsStore(s => s.controlPanelPrefs.showCostInList)
  const showRecapDesc = useConversationsStore(s => s.controlPanelPrefs.showRecapDescInList)
  const isRenaming = useConversationsStore(s => s.renamingConversationId === conversation.id)
  const isEditingDescription = useConversationsStore(s => s.editingDescriptionConversationId === conversation.id)
  const hasPendingPermission = useConversationsStore(s =>
    s.pendingPermissions.some(p => p.conversationId === conversation.id),
  )
  const hasPendingLink = useConversationsStore(s =>
    s.pendingProjectLinks.some(r => r.fromConversation === conversation.id || r.toConversation === conversation.id),
  )

  const projectName = projectDisplayName(projectPath(conversation.project), ps?.label)
  const conversationName = conversation.title || conversation.agentName
  const displayColor = ps?.color

  function handleClick() {
    haptic('tap')
    selectConversation(conversation.id)
  }

  return (
    <ConversationItemShell
      conversation={conversation}
      isSelected={isSelected}
      displayColor={displayColor}
      variant="full"
      onClick={handleClick}
    >
      <div className="flex items-center gap-1.5">
        <StatusIndicator status={conversation.status} adHoc={conversation.capabilities?.includes('ad-hoc')} />
        <BackendIcon backend={conversation.backend} />
        {ps?.icon && (
          <span style={displayColor && !isSelected ? { color: displayColor } : undefined}>
            {renderProjectIcon(ps.icon)}
          </span>
        )}
        <span
          className={cn('font-bold text-sm flex-1 truncate', isSelected ? 'text-accent' : 'text-primary')}
          style={displayColor && !isSelected ? { color: displayColor } : undefined}
        >
          {projectName}
        </span>
        {conversation.planMode && (
          <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-blue-500/20 text-blue-400 border border-blue-500/50">
            plan
          </span>
        )}
        {conversation.compacting && (
          <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-amber-400/20 text-amber-400 border border-amber-400/50 animate-pulse">
            compacting
          </span>
        )}
        {conversation.lastError && (
          <span
            className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-destructive/20 text-destructive border border-destructive/50"
            title={conversation.lastError.errorMessage || conversation.lastError.errorType || 'API error'}
          >
            error
          </span>
        )}
        {conversation.rateLimit && !conversation.lastError && (
          <span
            className="px-1 py-0.5 text-amber-400 border border-amber-500/40 bg-amber-500/20"
            title={`${conversation.rateLimit.message}${conversation.rateLimit.retryAfterMs ? ` (retry in ${Math.ceil(conversation.rateLimit.retryAfterMs / 1000)}s)` : ''}`}
          >
            <Clock size={12} />
          </span>
        )}
        {hasPendingLink && <span className="text-[9px] text-teal-400 font-bold animate-pulse">LINK</span>}
        {hasPendingPermission && <span className="text-[9px] text-amber-400 font-bold animate-pulse">PERM</span>}
        {conversation.pendingAttention && (
          <span className="text-[9px] text-amber-400 font-bold animate-pulse">WAITING</span>
        )}
        {conversation.hasNotification && <span className="text-[9px] text-teal-400 font-bold">NOTIFY</span>}
        {conversation.hostSentinelAlias && conversation.hostSentinelAlias !== 'default' && (
          <span className="px-1 py-0.5 text-[8px] rounded bg-muted text-muted-foreground font-medium">
            {conversation.hostSentinelAlias}
          </span>
        )}
        <ConversationInfoButton conversation={conversation} visible={isSelected} />
        <ShareIndicator conversationProject={conversation.project} conversationId={conversation.id} />
        {conversation.resultText && conversation.capabilities?.includes('ad-hoc') && (
          <ResultTextModal conversation={conversation} />
        )}
        {conversation.status === 'ended' && <DismissButton conversationId={conversation.id} />}
        {showCost &&
          conversation.stats &&
          (() => {
            const { cost, exact } = getConversationCost(conversation.stats, conversation.model)
            if (cost < 0.01) return null
            const level = getCostLevel(cost)
            return (
              <span
                className={cn(
                  'text-[9px] font-mono ml-auto shrink-0',
                  level === 'low' ? 'text-emerald-400/40' : cn('px-1 py-0.5 font-bold border', getCostBgColor(cost)),
                )}
                title={`Cost: ${formatCost(cost, exact)}`}
              >
                {formatCost(cost, exact)}
              </span>
            )
          })()}
      </div>
      {(isRenaming || conversationName) && (
        <div className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate pl-1">
          {isRenaming ? <InlineRename conversation={conversation} /> : conversationName}
        </div>
      )}
      {isEditingDescription ? (
        <div className="mt-0.5 pl-1">
          <InlineDescription conversation={conversation} />
        </div>
      ) : conversation.description ? (
        <div
          className="mt-0.5 text-[10px] text-muted-foreground/60 truncate pl-1 italic"
          title={conversation.description}
        >
          {conversation.description}
        </div>
      ) : null}
      {!isRenaming && conversation.recap?.title && (
        <div className="mt-0.5 text-[10px] text-zinc-400/80 truncate pl-1">{conversation.recap.title}</div>
      )}
      {conversation.gitBranch && conversation.gitBranch !== 'main' && conversation.gitBranch !== 'master' && (
        <div className="mt-0.5 pl-1 flex items-center gap-1">
          <span
            className={cn(
              'text-[9px] font-mono truncate',
              conversation.adHocWorktree ? 'text-orange-400/70' : 'text-purple-400/60',
            )}
          >
            {conversation.adHocWorktree ? '\u2387 ' : '\u2325 '}
            {conversation.gitBranch}
          </span>
        </div>
      )}
      <ConversationItemTasksBlock conversation={conversation} selectedSubagentId={selectedSubagentId} />
      {(conversation.runningBgTaskCount > 0 || conversation.team) && (
        <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
          {conversation.runningBgTaskCount > 0 && (
            <span
              role="button"
              tabIndex={0}
              className="px-1.5 py-0.5 bg-emerald-400/20 text-emerald-400 border border-emerald-400/50 text-[10px] font-bold cursor-pointer hover:bg-emerald-400/30"
              onClick={e => {
                e.stopPropagation()
                openTab(conversation.id, 'agents')
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  openTab(conversation.id, 'agents')
                }
              }}
            >
              [{conversation.runningBgTaskCount}] bg
            </span>
          )}
          {conversation.team && (
            <span className="px-1.5 py-0.5 bg-purple-400/20 text-purple-400 border border-purple-400/50 text-[10px] font-bold uppercase">
              {conversation.team.role === 'lead' ? 'LEAD' : 'TEAM'} {conversation.team.teamName}
              {conversation.teammates.length > 0 &&
                ` (${conversation.teammates.filter(t => t.status !== 'stopped').length}/${conversation.teammates.length})`}
            </span>
          )}
        </div>
      )}
      {conversation.summary && (
        <div className="mt-1 text-[10px] text-muted-foreground truncate" title={conversation.summary}>
          {conversation.summary}
        </div>
      )}
      {showRecapDesc && !conversation.summary && conversation.recap && (
        <div
          className={cn(
            'mt-1.5 text-[10px] whitespace-pre-wrap overflow-hidden transition-all duration-700',
            conversation.recapFresh
              ? 'text-zinc-300/80 border-l-2 border-zinc-500/50 pl-2 py-0.5 bg-zinc-800/20 rounded-r'
              : 'text-muted-foreground/50 italic pl-1',
          )}
          title={conversation.recap.content}
        >
          {conversation.recap.content}
        </div>
      )}
      {conversation.prLinks && conversation.prLinks.length > 0 && (
        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
          {conversation.prLinks.map(pr => (
            <a
              key={pr.prUrl}
              href={pr.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="text-[10px] font-mono text-sky-400 hover:text-sky-300 transition-colors"
              title={`${pr.prRepository}#${pr.prNumber}`}
            >
              PR#{pr.prNumber}
            </a>
          ))}
        </div>
      )}
      {conversation.linkedProjects && conversation.linkedProjects.length > 0 && (
        <div className="mt-1 text-[10px] text-teal-400/50 font-mono truncate">
          {'\u2194'} {conversation.linkedProjects.map(p => p.name).join(', ')}
        </div>
      )}
      {showContextBar &&
        conversation.tokenUsage &&
        (() => {
          const { input, cacheCreation, cacheRead } = conversation.tokenUsage
          const total = input + cacheCreation + cacheRead
          if (total === 0) return null
          const maxTokens = conversation.contextWindow ?? contextWindowSize(conversation.model)
          const pct = Math.min(100, Math.round((total / maxTokens) * 100))
          const threshold = conversation.autocompactPct || 83
          const warnAt = threshold - 5
          return (
            <div className="mt-1.5 flex items-center gap-1.5">
              <div className="flex-1 h-1 bg-muted/50 rounded-full overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    pct < warnAt ? 'bg-emerald-400/60' : pct < threshold ? 'bg-amber-400/60' : 'bg-red-400/70',
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span
                className={cn(
                  'text-[9px] font-mono tabular-nums shrink-0',
                  pct < warnAt ? 'text-emerald-400/50' : pct < threshold ? 'text-amber-400/50' : 'text-red-400/60',
                )}
              >
                {pct}%
              </span>
            </div>
          )
        })()}
      {conversation.status === 'idle' &&
        (() => {
          const ci = getCacheTimerInfo(
            conversation.lastTurnEndedAt,
            conversation.tokenUsage,
            conversation.model,
            conversation.cacheTtl,
          )
          if (!ci || ci.state === 'hot') return null
          if (ci.state === 'expired') {
            const idleMin = Math.floor((Date.now() - (conversation.lastTurnEndedAt || 0)) / 60_000)
            return (
              <div className="mt-1 text-[9px] font-mono text-amber-400/60 truncate">
                cache expired ({idleMin}m idle) -- ~${ci.reCacheCost.toFixed(2)} re-cache
              </div>
            )
          }
          return null
        })()}
    </ConversationItemShell>
  )
})

// ─── Compact conversation card (used inside CWD groups) ───────────────

export const ConversationItemCompact = memo(function ConversationItemCompact({
  conversation,
}: {
  conversation: Conversation
}) {
  const isSelected = useConversationsStore(s => s.selectedConversationId === conversation.id)
  const selectedSubagentId = useConversationsStore(s =>
    s.selectedConversationId === conversation.id ? s.selectedSubagentId : null,
  )
  const selectConversation = useConversationsStore(s => s.selectConversation)

  const ps = useConversationsStore(s => s.projectSettings[conversation.project])
  const showCost = useConversationsStore(s => s.controlPanelPrefs.showCostInList)
  const showContextBar = useConversationsStore(s => s.controlPanelPrefs.showContextInList)
  const isRenaming = useConversationsStore(s => s.renamingConversationId === conversation.id)
  const isEditingDescription = useConversationsStore(s => s.editingDescriptionConversationId === conversation.id)
  const hasPendingPermission = useConversationsStore(s =>
    s.pendingPermissions.some(p => p.conversationId === conversation.id),
  )
  const hasPendingLink = useConversationsStore(s =>
    s.pendingProjectLinks.some(r => r.fromConversation === conversation.id || r.toConversation === conversation.id),
  )

  const displayColor = ps?.color

  function handleClick() {
    haptic('tap')
    selectConversation(conversation.id)
  }

  return (
    <ConversationItemShell
      conversation={conversation}
      isSelected={isSelected}
      displayColor={displayColor}
      variant="compact"
      onClick={handleClick}
    >
      <div className="flex items-center gap-1.5">
        <StatusIndicator status={conversation.status} adHoc={conversation.capabilities?.includes('ad-hoc')} />
        <BackendIcon backend={conversation.backend} size={11} />
        {isRenaming ? (
          <div className="flex-1 min-w-0">
            <InlineRename conversation={conversation} />
          </div>
        ) : (
          <span
            className={cn(
              'font-mono text-[11px] flex-1 truncate',
              isSelected ? 'text-accent' : 'text-muted-foreground',
            )}
          >
            {(conversation.title || conversation.agentName || '').slice(0, 24) || conversation.id.slice(0, 8)}
          </span>
        )}
        {conversation.compacting && <span className="text-[9px] text-amber-400 font-bold animate-pulse">COMPACT</span>}
        {conversation.lastError && <span className="text-[9px] text-destructive font-bold">ERROR</span>}
        {conversation.rateLimit && !conversation.lastError && (
          <span
            title={`Rate limited: ${conversation.rateLimit.message}${conversation.rateLimit.retryAfterMs ? ` (retry in ${Math.ceil(conversation.rateLimit.retryAfterMs / 1000)}s)` : ''}`}
          >
            <Clock size={11} className="text-amber-400" />
          </span>
        )}
        {(() => {
          const pm = formatPermissionMode(conversation.permissionMode)
          if (!pm && conversation.planMode)
            return (
              <span className="text-[9px] text-blue-400 font-bold" title="Plan mode -- requires plan approval">
                P
              </span>
            )
          if (!pm) return null
          return (
            <span className={cn('text-[9px] font-bold', pm.color)} title={pm.title}>
              {pm.label}
            </span>
          )
        })()}
        {conversation.status === 'idle' &&
          (() => {
            const ci = getCacheTimerInfo(
              conversation.lastTurnEndedAt,
              conversation.tokenUsage,
              conversation.model,
              conversation.cacheTtl,
            )
            if (!ci) return null
            return ci.state === 'expired' ? (
              <span className="text-[9px] text-red-400/70 font-bold">EXPIRED</span>
            ) : ci.state === 'critical' ? (
              <span className="text-[9px] text-red-400 font-bold animate-pulse">CACHE</span>
            ) : ci.state === 'warning' ? (
              <span className="text-[9px] text-amber-400 font-bold">CACHE</span>
            ) : null
          })()}
        {showCost &&
          conversation.stats &&
          (() => {
            const { cost, exact } = getConversationCost(conversation.stats, conversation.model)
            if (cost < 0.5) return null
            return (
              <span className={cn('text-[9px] font-bold font-mono', getCostBgColor(cost).split(' ')[1])}>
                {formatCost(cost, exact)}
              </span>
            )
          })()}
        {conversation.adHocWorktree && <span className="text-[9px] text-orange-400 font-bold">WT</span>}
        {hasPendingLink && <span className="text-[9px] text-teal-400 font-bold animate-pulse">LINK</span>}
        {hasPendingPermission && <span className="text-[9px] text-amber-400 font-bold animate-pulse">PERM</span>}
        {conversation.pendingAttention && (
          <span className="text-[9px] text-amber-400 font-bold animate-pulse">WAITING</span>
        )}
        {conversation.hasNotification && <span className="text-[9px] text-teal-400 font-bold">NOTIFY</span>}
        {conversation.hostSentinelAlias && conversation.hostSentinelAlias !== 'default' && (
          <span className="px-1 py-0.5 text-[8px] rounded bg-muted text-muted-foreground font-medium">
            {conversation.hostSentinelAlias}
          </span>
        )}
        <ConversationInfoButton conversation={conversation} visible={isSelected} />
        {conversation.status === 'ended' && <DismissButton conversationId={conversation.id} />}
      </div>
      {conversation.gitBranch && conversation.gitBranch !== 'main' && conversation.gitBranch !== 'master' && (
        <div className="pl-4 flex items-center gap-1">
          <span
            className={cn(
              'text-[9px] font-mono truncate',
              conversation.adHocWorktree ? 'text-orange-400/70' : 'text-purple-400/60',
            )}
          >
            {conversation.adHocWorktree ? '⎇ ' : '⌥ '}
            {conversation.gitBranch}
          </span>
        </div>
      )}
      {isEditingDescription ? (
        <div className="mt-0.5 pl-4">
          <InlineDescription conversation={conversation} />
        </div>
      ) : conversation.description ? (
        <div className="mt-0.5 pl-4 text-[9px] text-muted-foreground/70 truncate" title={conversation.description}>
          {conversation.description}
        </div>
      ) : null}
      {conversation.summary && (
        <div className="mt-0.5 pl-4 text-[9px] text-muted-foreground/50 truncate" title={conversation.summary}>
          {conversation.summary}
        </div>
      )}
      {conversation.recap?.title && (
        <div className="mt-0.5 pl-4 text-[9px] text-zinc-400/80 truncate">{conversation.recap.title}</div>
      )}
      {showContextBar &&
        conversation.tokenUsage &&
        (() => {
          const { input, cacheCreation, cacheRead } = conversation.tokenUsage
          const total = input + cacheCreation + cacheRead
          if (total === 0) return null
          const maxTokens = conversation.contextWindow ?? contextWindowSize(conversation.model)
          const pct = Math.min(100, Math.round((total / maxTokens) * 100))
          const threshold = conversation.autocompactPct || 83
          const warnAt = threshold - 5
          return (
            <div className="mt-0.5 pl-4 flex items-center gap-1.5">
              <div className="flex-1 h-1 bg-muted/50 rounded-full overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    pct < warnAt ? 'bg-emerald-400/60' : pct < threshold ? 'bg-amber-400/60' : 'bg-red-400/70',
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span
                className={cn(
                  'text-[9px] font-mono tabular-nums shrink-0',
                  pct < warnAt ? 'text-emerald-400/50' : pct < threshold ? 'text-amber-400/50' : 'text-red-400/60',
                )}
              >
                {pct}%
              </span>
            </div>
          )
        })()}
      <ConversationItemTasksBlock conversation={conversation} selectedSubagentId={selectedSubagentId} />
    </ConversationItemShell>
  )
})

// ─── Conversation card with settings button ─────────────────────────────

export const ConversationCard = memo(function ConversationCard({ conversation }: { conversation: Conversation }) {
  const [showSettings, setShowSettings] = useState(false)
  const isSelected = useConversationsStore(s => s.selectedConversationId === conversation.id)
  return (
    <ConversationContextMenu conversation={conversation} onOpenSettings={() => setShowSettings(true)}>
      <div>
        <div className="relative group/card">
          <ConversationItemFull conversation={conversation} />
          <div
            className={cn(
              'absolute top-2 right-2 transition-opacity',
              isSelected ? 'opacity-100' : 'opacity-0 [@media(hover:hover)]:group-hover/card:opacity-100',
            )}
          >
            <ProjectSettingsButton
              onClick={e => {
                e.stopPropagation()
                setShowSettings(!showSettings)
              }}
            />
          </div>
        </div>
        {showSettings && (
          <ProjectSettingsEditor project={conversation.project} onClose={() => setShowSettings(false)} />
        )}
      </div>
    </ConversationContextMenu>
  )
})

// ─── Compact peek (used for the "selected conversation" preview inside a
// collapsed group). Subscribes to a single conversation by id so the peek
// re-renders independently of ProjectList. ──────────────────────────

export const ConversationCompactPeek = memo(function ConversationCompactPeek({
  conversationId,
}: {
  conversationId: string
}) {
  const conversation = useConversationsStore(s => s.conversationsById[conversationId])
  if (!conversation) return null
  return <ConversationItemCompact conversation={conversation} />
})

// ─── Inactive project item ────────────────────────────────────────

export const InactiveProjectItem = memo(
  function InactiveProjectItem({ conversationIds }: { conversationIds: string[] }) {
    const [showSettings, setShowSettings] = useState(false)
    const selectConversation = useConversationsStore(s => s.selectConversation)
    const conversations = useConversationsStore(
      useShallow(s => conversationIds.map(id => s.conversationsById[id]).filter(Boolean) as Conversation[]),
    )
    const latest =
      conversations.length > 0 ? conversations.reduce((a, b) => (a.lastActivity > b.lastActivity ? a : b)) : null
    const ps = useConversationsStore(s => (latest ? s.projectSettings[latest.project] : undefined))
    if (!latest) return null
    const displayName = projectDisplayName(projectPath(latest.project), ps?.label)
    const displayColor = ps?.color

    return (
      <ConversationContextMenu conversation={latest} onOpenSettings={() => setShowSettings(true)}>
        <div>
          <div
            data-conversation-id={latest.id}
            role="button"
            tabIndex={0}
            onClick={() => {
              haptic('tap')
              selectConversation(latest.id)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                haptic('tap')
                selectConversation(latest.id)
              }
            }}
            className="w-full text-left border border-border hover:border-primary p-2 pl-3 transition-colors cursor-pointer"
            style={displayColor ? { borderLeftColor: displayColor, borderLeftWidth: '3px' } : undefined}
            title={`${conversations.length} conversation${conversations.length > 1 ? 's' : ''}\n${projectPath(latest.project)}`}
          >
            <div className="flex items-center gap-1.5">
              {ps?.icon && (
                <span className="text-muted-foreground" style={displayColor ? { color: displayColor } : undefined}>
                  {renderProjectIcon(ps.icon)}
                </span>
              )}
              <span
                className="font-mono text-xs text-muted-foreground truncate flex-1"
                style={displayColor ? { color: `${displayColor}99` } : undefined}
              >
                {displayName}
              </span>
              <span className="text-[10px] text-muted-foreground/60 font-mono shrink-0">
                {formatAge(latest.lastActivity)}
              </span>
            </div>
          </div>
          {showSettings && <ProjectSettingsEditor project={latest.project} onClose={() => setShowSettings(false)} />}
        </div>
      </ConversationContextMenu>
    )
  },
  (prev, next) => {
    if (prev.conversationIds.length !== next.conversationIds.length) return false
    for (let i = 0; i < prev.conversationIds.length; i++) {
      if (prev.conversationIds[i] !== next.conversationIds[i]) return false
    }
    return true
  },
)
