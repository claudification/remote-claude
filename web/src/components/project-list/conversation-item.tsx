import { memo, type ReactNode, useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import {
  formatCost,
  getCacheTimerInfo,
  getCostBgColor,
  getCostColor,
  getCostLevel,
  getSessionCost,
} from '@/lib/cost-utils'
import { useKeyLayer } from '@/lib/key-layers'
import type { Session } from '@/lib/types'
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
import { SessionContextMenu } from './conversation-context-menu'

// ─── Shared visual components ──────────────────────────────────────

function StatusIndicator({ status, adHoc }: { status: Session['status']; adHoc?: boolean }) {
  // Ad-hoc sessions get a lightning bolt instead of status dots
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
          style={{ border: '2px solid rgb(56 189 248)', borderTopColor: 'transparent' }}
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

function LaunchParamsSection({ session }: { session: Session }) {
  const lc = session.launchConfig
  const [revealEnv, setRevealEnv] = useState(false)
  const envEntries = lc?.env ? Object.entries(lc.env) : []

  // Fallbacks so legacy sessions (no launchConfig captured) still show something
  const headless: boolean | undefined = lc?.headless ?? (session.capabilities?.includes('headless') || undefined)
  const autocompactPct = lc?.autocompactPct ?? session.autocompactPct
  const permissionMode = lc?.permissionMode
  const bare = lc?.bare
  const repl = lc?.repl
  const maxBudgetUsd = lc?.maxBudgetUsd

  const hasAnyCore =
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

// ─── Session info dialog (replaces hover tooltip) ────────────────

function SessionInfoDialog({
  session,
  open,
  onOpenChange,
}: {
  session: Session
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const resolvedModel = session.model
  const effort = formatEffort(session.effortLevel)
  const cost = session.stats ? getSessionCost(session.stats, resolvedModel) : null
  const duration = session.lastActivity - session.startedAt
  const isAdHoc = session.capabilities?.includes('ad-hoc')

  useKeyLayer({ Escape: () => onOpenChange(false) }, { id: 'session-info-dialog', enabled: open })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="font-mono max-w-sm p-4">
        <DialogTitle className="pr-8 pb-2 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-accent">{'\u24D8'}</span>
            <span>Session Info</span>
            <span className="text-[10px] text-muted-foreground/50 font-normal">{session.id.slice(0, 12)}</span>
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
          {session.stats && session.stats.turnCount > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Turns</span>
              <span className="ml-auto text-foreground/80">{session.stats.turnCount}</span>
            </div>
          )}

          {/* Token usage */}
          {session.stats && (session.stats.totalInputTokens > 0 || session.stats.totalOutputTokens > 0) && (
            <>
              <div className="border-t border-border" />
              <div className="space-y-1">
                <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Tokens</span>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                  <span className="text-muted-foreground">input</span>
                  <span className="text-right tabular-nums text-foreground/80">
                    {formatTokenCount(session.stats.totalInputTokens)}
                  </span>
                  <span className="text-muted-foreground">output</span>
                  <span className="text-right tabular-nums text-foreground/80">
                    {formatTokenCount(session.stats.totalOutputTokens)}
                  </span>
                  {session.stats.totalCacheRead > 0 && (
                    <>
                      <span className="text-muted-foreground">cache read</span>
                      <span className="text-right tabular-nums text-emerald-400">
                        {formatTokenCount(session.stats.totalCacheRead)}
                      </span>
                    </>
                  )}
                  {session.stats.totalCacheCreation > 0 && (
                    <>
                      <span className="text-muted-foreground">cache write</span>
                      <span className="text-right tabular-nums text-amber-400">
                        {formatTokenCount(session.stats.totalCacheCreation)}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Context window */}
          {session.stats && session.stats.totalInputTokens > 0 && (
            <>
              <div className="border-t border-border" />
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Context</span>
                <span className="ml-auto text-foreground/80">
                  {formatTokenCount(session.stats.totalInputTokens)} /{' '}
                  {formatTokenCount(session.contextWindow ?? contextWindowSize(resolvedModel))}
                </span>
              </div>
            </>
          )}

          {/* Git branch */}
          {session.gitBranch && (
            <>
              <div className="border-t border-border" />
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Branch</span>
                <span className="ml-auto text-sky-400 truncate max-w-[200px]">{session.gitBranch}</span>
              </div>
            </>
          )}

          {/* Identity */}
          {session.claudeAuth?.email && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Auth</span>
              <span className="ml-auto text-foreground/80 truncate max-w-[200px]">
                {session.claudeAuth.email}
                {session.claudeAuth.orgName && (
                  <span className="text-muted-foreground"> ({session.claudeAuth.orgName})</span>
                )}
              </span>
            </div>
          )}

          {/* Launch parameters */}
          <LaunchParamsSection session={session} />

          {/* Ad-hoc result preview */}
          {isAdHoc && session.resultText && (
            <>
              <div className="border-t border-border" />
              <div className="space-y-1">
                <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Result</span>
                <div className="text-[10px] text-foreground/70 line-clamp-6 break-words">
                  {truncate(session.resultText, 400)}
                </div>
              </div>
            </>
          )}

          {/* Session ID */}
          <div className="border-t border-border/50" />
          <div className="text-[9px] text-muted-foreground/50 select-all">{session.id}</div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SessionInfoButton({ session, visible }: { session: Session; visible: boolean }) {
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
        title="Session info"
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
      <SessionInfoDialog session={session} open={open} onOpenChange={setOpen} />
    </>
  )
}

// ─── Ad-hoc result text modal ─────────────────────────────────────

function ResultTextModal({ session }: { session: Session }) {
  const [open, setOpen] = useState(false)

  if (!session.resultText) return null

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
              <span className="text-[10px] text-muted-foreground/50 font-normal">{session.id.slice(0, 12)}</span>
              <button
                type="button"
                className="ml-auto mr-6 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer px-2 py-1 border border-border hover:border-primary"
                onClick={() => {
                  navigator.clipboard.writeText(session.resultText || '')
                  haptic('success')
                }}
              >
                copy
              </button>
            </div>
          </DialogTitle>
          <div className="overflow-y-auto max-h-[70vh] p-4">
            <Markdown>{session.resultText}</Markdown>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function DismissButton({ sessionId }: { sessionId: string }) {
  const dismissSession = useConversationsStore(s => s.dismissSession)
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <div
        className="flex items-center gap-1 text-[9px]"
        role="group"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            haptic('tap')
            dismissSession(sessionId)
            setConfirming(false)
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              haptic('tap')
              dismissSession(sessionId)
              setConfirming(false)
            }
          }}
          className="text-destructive hover:text-destructive/80 cursor-pointer font-bold"
        >
          yes
        </div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setConfirming(false)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') setConfirming(false)
          }}
          className="text-muted-foreground hover:text-foreground cursor-pointer"
        >
          no
        </div>
      </div>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={e => {
        e.stopPropagation()
        haptic('tap')
        setConfirming(true)
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation()
          haptic('tap')
          setConfirming(true)
        }
      }}
      className="opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 text-muted-foreground/40 hover:text-destructive transition-opacity cursor-pointer px-0.5"
      title="Dismiss session"
    >
      {'\u2715'}
    </div>
  )
}

// ─── Inline rename input ─────────────────────────────────────────────

function InlineRename({ session }: { session: Session }) {
  const renameSession = useConversationsStore(s => s.renameSession)
  const setRenamingSessionId = useConversationsStore(s => s.setRenamingSessionId)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(session.title || '')

  useEffect(() => {
    // Delay to let Radix context menu fully close and release focus
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 50)
    return () => clearTimeout(t)
  }, [])

  function submit() {
    renameSession(session.id, value.trim())
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
        if (e.key === 'Escape') setRenamingSessionId(null)
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
      placeholder="session name"
    />
  )
}

// ─── Inline description input ───────────────────────────────────────

function InlineDescription({ session }: { session: Session }) {
  const updateDescription = useConversationsStore(s => s.updateDescription)
  const setEditingDescriptionSessionId = useConversationsStore(s => s.setEditingDescriptionSessionId)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(session.description || '')

  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 50)
    return () => clearTimeout(t)
  }, [])

  function submit() {
    updateDescription(session.id, value.trim())
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
        if (e.key === 'Escape') setEditingDescriptionSessionId(null)
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
      placeholder="session description"
    />
  )
}

// ─── Session card outer wrapper (shared by Full + Compact) ────────

function SessionItemShell({
  session,
  isSelected,
  displayColor,
  variant,
  onClick,
  children,
}: {
  session: Session
  isSelected: boolean
  displayColor: string | undefined
  variant: 'full' | 'compact'
  onClick: () => void
  children: ReactNode
}) {
  return (
    <div
      data-session-id={session.id}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') onClick()
      }}
      className={cn(
        'w-full text-left border transition-colors group cursor-pointer',
        variant === 'compact' ? 'p-2 pl-4 text-[11px]' : 'p-3',
        isSelected
          ? 'border-accent bg-accent/15 ring-1 ring-accent/50 shadow-[0_0_8px_rgba(122,162,247,0.15)]'
          : displayColor
            ? 'border-border hover:border-primary'
            : 'border-border hover:border-primary hover:bg-card',
      )}
      style={
        displayColor && !isSelected
          ? { borderLeftColor: displayColor, borderLeftWidth: '3px', backgroundColor: `${displayColor}15` }
          : undefined
      }
    >
      {children}
    </div>
  )
}

// ─── Running tasks / subagents / teammates block (shared) ─────────

function SessionItemTasksBlock({
  session,
  selectedSubagentId,
}: {
  session: Session
  selectedSubagentId: string | null
}) {
  const hasContent =
    session.activeTasks.length > 0 ||
    session.pendingTasks.length > 0 ||
    session.subagents.length > 0 ||
    session.teammates.some(t => t.status === 'working')
  if (!hasContent) return null

  const overflow = session.activeTasks.length + session.pendingTasks.length - 5
  const now = Date.now()

  return (
    <div className="mt-1 space-y-0.5">
      {session.activeTasks.slice(0, 5).map(task => (
        <div key={task.id} className="text-[11px] text-active/80 font-mono truncate pl-1">
          <span className="text-active mr-1">{'\u25B8'}</span>
          {task.subject}
        </div>
      ))}
      {session.pendingTasks.slice(0, Math.max(0, 5 - session.activeTasks.length)).map(task => (
        <div key={task.id} className="text-[11px] text-amber-400/50 font-mono truncate pl-1">
          <span className="text-amber-400/40 mr-1">{'\u25CB'}</span>
          {task.subject}
        </div>
      ))}
      {overflow > 0 && <div className="text-[10px] text-muted-foreground pl-1 font-mono">..{overflow} more</div>}
      {session.subagents
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
      {session.subagents
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
      {session.teammates
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

// ─── Full-size session card ───────────────────────────────────────

const SessionItemFull = memo(function SessionItemFull({ session }: { session: Session }) {
  const isSelected = useConversationsStore(s => s.selectedConversationId === session.id)
  const selectedSubagentId = useConversationsStore(s =>
    s.selectedConversationId === session.id ? s.selectedSubagentId : null,
  )
  const selectConversation = useConversationsStore(s => s.selectConversation)

  const openTab = useConversationsStore(s => s.openTab)
  const ps = useConversationsStore(s => s.projectSettings[session.project])
  const showContextBar = useConversationsStore(s => s.controlPanelPrefs.showContextInList)
  const showCost = useConversationsStore(s => s.controlPanelPrefs.showCostInList)
  const isRenaming = useConversationsStore(s => s.renamingSessionId === session.id)
  const isEditingDescription = useConversationsStore(s => s.editingDescriptionSessionId === session.id)
  const hasPendingPermission = useConversationsStore(s => s.pendingPermissions.some(p => p.sessionId === session.id))

  const projectName = projectDisplayName(projectPath(session.project), ps?.label)
  const sessionName = session.title || session.agentName
  const displayColor = ps?.color

  function handleClick() {
    haptic('tap')
    selectConversation(session.id)
  }

  return (
    <SessionItemShell
      session={session}
      isSelected={isSelected}
      displayColor={displayColor}
      variant="full"
      onClick={handleClick}
    >
      <div className="flex items-center gap-1.5">
        <StatusIndicator status={session.status} adHoc={session.capabilities?.includes('ad-hoc')} />
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
        {session.compacting && (
          <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-amber-400/20 text-amber-400 border border-amber-400/50 animate-pulse">
            compacting
          </span>
        )}
        {session.lastError && (
          <span
            className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-destructive/20 text-destructive border border-destructive/50"
            title={session.lastError.errorMessage || session.lastError.errorType || 'API error'}
          >
            error
          </span>
        )}
        {session.rateLimit && !session.lastError && (
          <span
            className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-amber-500/20 text-amber-400 border border-amber-500/40"
            title={session.rateLimit.message}
          >
            throttled
          </span>
        )}
        {hasPendingPermission && <span className="text-[9px] text-amber-400 font-bold animate-pulse">PERM</span>}
        {session.pendingAttention && <span className="text-[9px] text-amber-400 font-bold animate-pulse">WAITING</span>}
        {session.hasNotification && <span className="text-[9px] text-teal-400 font-bold">NOTIFY</span>}
        {session.hostSentinelAlias && session.hostSentinelAlias !== 'default' && (
          <span className="px-1 py-0.5 text-[8px] rounded bg-muted text-muted-foreground font-medium">
            {session.hostSentinelAlias}
          </span>
        )}
        <SessionInfoButton session={session} visible={isSelected} />
        <ShareIndicator sessionProject={projectPath(session.project)} />
        {session.resultText && session.capabilities?.includes('ad-hoc') && <ResultTextModal session={session} />}
        {session.status === 'ended' && <DismissButton sessionId={session.id} />}
        {showCost &&
          session.stats &&
          (() => {
            const { cost, exact } = getSessionCost(session.stats, session.model)
            if (cost < 0.01) return null
            const level = getCostLevel(cost)
            return (
              <span
                className={cn(
                  'text-[9px] font-mono ml-auto shrink-0',
                  level === 'low' ? 'text-emerald-400/40' : cn('px-1 py-0.5 font-bold border', getCostBgColor(cost)),
                )}
                title={`Session cost: ${formatCost(cost, exact)}`}
              >
                {formatCost(cost, exact)}
              </span>
            )
          })()}
      </div>
      {(isRenaming || sessionName) && (
        <div className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate pl-1">
          {isRenaming ? <InlineRename session={session} /> : sessionName}
        </div>
      )}
      {isEditingDescription ? (
        <div className="mt-0.5 pl-1">
          <InlineDescription session={session} />
        </div>
      ) : session.description ? (
        <div
          className="mt-0.5 text-[10px] text-muted-foreground/60 truncate pl-1 italic cursor-pointer hover:text-muted-foreground/80 transition-colors"
          title={`${session.description}\n(click to edit)`}
          onClick={e => {
            e.stopPropagation()
            useConversationsStore.getState().setEditingDescriptionSessionId(session.id)
          }}
        >
          {session.description}
        </div>
      ) : null}
      {session.gitBranch && session.gitBranch !== 'main' && session.gitBranch !== 'master' && (
        <div className="mt-0.5 pl-1 flex items-center gap-1">
          <span
            className={cn(
              'text-[9px] font-mono truncate',
              session.adHocWorktree ? 'text-orange-400/70' : 'text-purple-400/60',
            )}
          >
            {session.adHocWorktree ? '\u2387 ' : '\u2325 '}
            {session.gitBranch}
          </span>
        </div>
      )}
      <SessionItemTasksBlock session={session} selectedSubagentId={selectedSubagentId} />
      {(session.runningBgTaskCount > 0 || session.team) && (
        <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
          {session.runningBgTaskCount > 0 && (
            <span
              role="button"
              tabIndex={0}
              className="px-1.5 py-0.5 bg-emerald-400/20 text-emerald-400 border border-emerald-400/50 text-[10px] font-bold cursor-pointer hover:bg-emerald-400/30"
              onClick={e => {
                e.stopPropagation()
                openTab(session.id, 'agents')
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  openTab(session.id, 'agents')
                }
              }}
            >
              [{session.runningBgTaskCount}] bg
            </span>
          )}
          {session.team && (
            <span className="px-1.5 py-0.5 bg-purple-400/20 text-purple-400 border border-purple-400/50 text-[10px] font-bold uppercase">
              {session.team.role === 'lead' ? 'LEAD' : 'TEAM'} {session.team.teamName}
              {session.teammates.length > 0 &&
                ` (${session.teammates.filter(t => t.status !== 'stopped').length}/${session.teammates.length})`}
            </span>
          )}
        </div>
      )}
      {session.summary && (
        <div className="mt-1 text-[10px] text-muted-foreground truncate" title={session.summary}>
          {session.summary}
        </div>
      )}
      {!session.summary && session.recap && (
        <div
          className={cn(
            'mt-1.5 text-[10px] truncate transition-all duration-700 group/recap relative',
            session.recapFresh
              ? 'text-zinc-300/80 border-l-2 border-zinc-500/50 pl-2 py-0.5 bg-zinc-800/20 rounded-r'
              : 'text-muted-foreground/50 italic pl-1',
          )}
        >
          <span className="block truncate">{session.recap.content}</span>
          <div className="hidden [@media(hover:hover)]:group-hover/recap:block absolute left-0 top-full z-50 mt-1 max-w-[320px] p-2.5 bg-zinc-900 border border-zinc-700 rounded shadow-lg text-[10px] text-zinc-300 leading-relaxed whitespace-normal">
            {session.recap.content}
          </div>
        </div>
      )}
      {session.prLinks && session.prLinks.length > 0 && (
        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
          {session.prLinks.map(pr => (
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
      {session.linkedProjects && session.linkedProjects.length > 0 && (
        <div className="mt-1 text-[10px] text-teal-400/50 font-mono truncate">
          {'\u2194'} {session.linkedProjects.map(p => p.name).join(', ')}
        </div>
      )}
      {showContextBar &&
        session.tokenUsage &&
        (() => {
          const { input, cacheCreation, cacheRead } = session.tokenUsage
          const total = input + cacheCreation + cacheRead
          if (total === 0) return null
          const maxTokens = session.contextWindow ?? contextWindowSize(session.model)
          const pct = Math.min(100, Math.round((total / maxTokens) * 100))
          const threshold = session.autocompactPct || 83
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
      {session.status === 'idle' &&
        (() => {
          const ci = getCacheTimerInfo(session.lastTurnEndedAt, session.tokenUsage, session.model, session.cacheTtl)
          if (!ci || ci.state === 'hot') return null
          if (ci.state === 'expired') {
            const idleMin = Math.floor((Date.now() - (session.lastTurnEndedAt || 0)) / 60_000)
            return (
              <div className="mt-1 text-[9px] font-mono text-amber-400/60 truncate">
                cache expired ({idleMin}m idle) -- ~${ci.reCacheCost.toFixed(2)} re-cache
              </div>
            )
          }
          return null
        })()}
    </SessionItemShell>
  )
})

// ─── Compact session card (used inside CWD groups) ───────────────

export const SessionItemCompact = memo(function SessionItemCompact({ session }: { session: Session }) {
  const isSelected = useConversationsStore(s => s.selectedConversationId === session.id)
  const selectedSubagentId = useConversationsStore(s =>
    s.selectedConversationId === session.id ? s.selectedSubagentId : null,
  )
  const selectConversation = useConversationsStore(s => s.selectConversation)

  const ps = useConversationsStore(s => s.projectSettings[session.project])
  const showCost = useConversationsStore(s => s.controlPanelPrefs.showCostInList)
  const showContextBar = useConversationsStore(s => s.controlPanelPrefs.showContextInList)
  const isRenaming = useConversationsStore(s => s.renamingSessionId === session.id)
  const isEditingDescription = useConversationsStore(s => s.editingDescriptionSessionId === session.id)
  const hasPendingPermission = useConversationsStore(s => s.pendingPermissions.some(p => p.sessionId === session.id))

  const displayColor = ps?.color

  function handleClick() {
    haptic('tap')
    selectConversation(session.id)
  }

  return (
    <SessionItemShell
      session={session}
      isSelected={isSelected}
      displayColor={displayColor}
      variant="compact"
      onClick={handleClick}
    >
      <div className="flex items-center gap-1.5">
        <StatusIndicator status={session.status} adHoc={session.capabilities?.includes('ad-hoc')} />
        {isRenaming ? (
          <div className="flex-1 min-w-0">
            <InlineRename session={session} />
          </div>
        ) : (
          <span
            className={cn(
              'font-mono text-[11px] flex-1 truncate',
              isSelected ? 'text-accent' : 'text-muted-foreground',
            )}
          >
            {(session.title || session.agentName || '').slice(0, 24) || session.id.slice(0, 8)}
          </span>
        )}
        {session.compacting && <span className="text-[9px] text-amber-400 font-bold animate-pulse">COMPACT</span>}
        {session.lastError && <span className="text-[9px] text-destructive font-bold">ERROR</span>}
        {session.rateLimit && !session.lastError && (
          <span className="text-[9px] text-amber-400 font-bold">THROTTLED</span>
        )}
        {(() => {
          const pm = formatPermissionMode(session.permissionMode)
          if (!pm && session.planMode) return <span className="text-[9px] text-blue-400 font-bold">PLAN</span>
          if (!pm) return null
          return <span className={cn('text-[9px] font-bold', pm.color)}>{pm.label}</span>
        })()}
        {session.status === 'idle' &&
          (() => {
            const ci = getCacheTimerInfo(session.lastTurnEndedAt, session.tokenUsage, session.model, session.cacheTtl)
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
          session.stats &&
          (() => {
            const { cost, exact } = getSessionCost(session.stats, session.model)
            if (cost < 0.5) return null
            return (
              <span className={cn('text-[9px] font-bold font-mono', getCostBgColor(cost).split(' ')[1])}>
                {formatCost(cost, exact)}
              </span>
            )
          })()}
        {session.adHocWorktree && <span className="text-[9px] text-orange-400 font-bold">WT</span>}
        {hasPendingPermission && <span className="text-[9px] text-amber-400 font-bold animate-pulse">PERM</span>}
        {session.pendingAttention && <span className="text-[9px] text-amber-400 font-bold animate-pulse">WAITING</span>}
        {session.hasNotification && <span className="text-[9px] text-teal-400 font-bold">NOTIFY</span>}
        {session.hostSentinelAlias && session.hostSentinelAlias !== 'default' && (
          <span className="px-1 py-0.5 text-[8px] rounded bg-muted text-muted-foreground font-medium">
            {session.hostSentinelAlias}
          </span>
        )}
        <SessionInfoButton session={session} visible={isSelected} />
        {session.status === 'ended' && <DismissButton sessionId={session.id} />}
      </div>
      {session.gitBranch && session.gitBranch !== 'main' && session.gitBranch !== 'master' && (
        <div className="pl-4 flex items-center gap-1">
          <span
            className={cn(
              'text-[9px] font-mono truncate',
              session.adHocWorktree ? 'text-orange-400/70' : 'text-purple-400/60',
            )}
          >
            {session.adHocWorktree ? '⎇ ' : '⌥ '}
            {session.gitBranch}
          </span>
        </div>
      )}
      {isEditingDescription ? (
        <div className="mt-0.5 pl-4">
          <InlineDescription session={session} />
        </div>
      ) : session.description ? (
        <div
          className="mt-0.5 pl-4 text-[9px] text-muted-foreground/70 truncate cursor-pointer hover:text-muted-foreground/90 transition-colors"
          title={`${session.description}\n(click to edit)`}
          onClick={e => {
            e.stopPropagation()
            useSessionsStore.getState().setEditingDescriptionSessionId(session.id)
          }}
        >
          {session.description}
        </div>
      ) : null}
      {session.summary && (
        <div className="mt-0.5 pl-4 text-[9px] text-muted-foreground/50 truncate" title={session.summary}>
          {session.summary}
        </div>
      )}
      {session.recap && (
        <div
          className={cn(
            'mt-0.5 pl-4 text-[9px] truncate group/recap relative',
            session.recapFresh ? 'text-zinc-400/70' : 'text-muted-foreground/40 italic',
          )}
          title={session.recap.content}
        >
          {session.recap.content}
          <div className="hidden [@media(hover:hover)]:group-hover/recap:block absolute left-0 top-full z-50 mt-1 max-w-[280px] p-2 bg-zinc-900 border border-zinc-700 rounded shadow-lg text-[10px] text-zinc-300 leading-relaxed whitespace-normal">
            {session.recap.content}
          </div>
        </div>
      )}
      {showContextBar &&
        session.tokenUsage &&
        (() => {
          const { input, cacheCreation, cacheRead } = session.tokenUsage
          const total = input + cacheCreation + cacheRead
          if (total === 0) return null
          const maxTokens = session.contextWindow ?? contextWindowSize(session.model)
          const pct = Math.min(100, Math.round((total / maxTokens) * 100))
          const threshold = session.autocompactPct || 83
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
      <SessionItemTasksBlock session={session} selectedSubagentId={selectedSubagentId} />
    </SessionItemShell>
  )
})

// ─── Session card with settings button ─────────────────────────────

export const SessionCard = memo(function SessionCard({ session }: { session: Session }) {
  const [showSettings, setShowSettings] = useState(false)
  const isSelected = useConversationsStore(s => s.selectedConversationId === session.id)
  return (
    <SessionContextMenu session={session} onOpenSettings={() => setShowSettings(true)}>
      <div>
        <div className="relative group/card">
          <SessionItemFull session={session} />
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
        {showSettings && <ProjectSettingsEditor project={session.project} onClose={() => setShowSettings(false)} />}
      </div>
    </SessionContextMenu>
  )
})

// ─── Inactive project item ────────────────────────────────────────

export const InactiveProjectItem = memo(
  function InactiveProjectItem({ sessions }: { sessions: Session[] }) {
    const [showSettings, setShowSettings] = useState(false)
    const selectConversation = useConversationsStore(s => s.selectConversation)
    const latest = sessions.reduce((a, b) => (a.lastActivity > b.lastActivity ? a : b))
    const ps = useConversationsStore(s => s.projectSettings[latest.project])
    const displayName = projectDisplayName(projectPath(latest.project), ps?.label)
    const displayColor = ps?.color

    return (
      <SessionContextMenu session={latest} onOpenSettings={() => setShowSettings(true)}>
        <div>
          <div
            data-session-id={latest.id}
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
            title={`${sessions.length} session${sessions.length > 1 ? 's' : ''}\n${projectPath(latest.project)}`}
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
      </SessionContextMenu>
    )
  },
  (prev, next) => {
    if (prev.sessions.length !== next.sessions.length) return false
    for (let i = 0; i < prev.sessions.length; i++) {
      if (prev.sessions[i] !== next.sessions[i]) return false
    }
    return true
  },
)
