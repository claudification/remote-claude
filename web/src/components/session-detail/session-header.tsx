import type { ProjectSettings } from '@shared/protocol'
import { ChevronDown, ChevronRight, Copy, Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CacheExpiredBanner, CacheTimer } from '@/components/cache-timer'
import { CostSparkline } from '@/components/cost-sparkline'
import { renderProjectIcon } from '@/components/project-settings-editor'
import { useConversationsStore, wsSend } from '@/hooks/use-sessions'
import { formatCost, getBurnRate, getCacheEfficiency, getCostColor, getSessionCost } from '@/lib/cost-utils'
import type { Session } from '@/lib/types'
import { projectPath } from '@/lib/types'
import {
  cn,
  contextWindowSize,
  formatAge,
  formatEffort,
  formatModel,
  formatPermissionMode,
  formatTime,
  haptic,
} from '@/lib/utils'

// ─── Inline description editor (session header, expanded view) ──────

function HeaderDescription({ session }: { session: Session }) {
  const isEditing = useConversationsStore(s => s.editingDescriptionSessionId === session.id)
  const setEditing = useConversationsStore(s => s.setEditingDescriptionSessionId)
  const updateDescription = useConversationsStore(s => s.updateDescription)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(session.description || '')

  useEffect(() => {
    if (isEditing) {
      setValue(session.description || '')
      const t = setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
      return () => clearTimeout(t)
    }
  }, [isEditing, session.description])

  function submit() {
    updateDescription(session.id, value.trim())
    haptic('success')
  }

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') setEditing(null)
        }}
        onBlur={submit}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        className="w-full bg-background/80 border border-accent/50 text-[10px] font-mono px-1.5 py-0.5 outline-none text-muted-foreground italic"
        placeholder="session description"
      />
    )
  }

  return (
    <div className="group/desc flex items-center gap-1 cursor-pointer" onClick={() => setEditing(session.id)}>
      <span
        className={cn(
          'text-[10px] truncate',
          session.description ? 'text-muted-foreground/70 italic' : 'text-muted-foreground/30 italic',
        )}
      >
        {session.description || 'add description...'}
      </span>
      <Pencil className="w-2.5 h-2.5 text-muted-foreground/20 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/desc:opacity-100 transition-opacity" />
    </div>
  )
}

interface ConversationTarget {
  projectA: string
  projectB: string
  nameA: string
  nameB: string
}

interface SessionHeaderProps {
  session: Session
  projectSettings: ProjectSettings | undefined
  model: string | undefined
  inPlanMode: boolean
  infoExpanded: boolean
  onToggleExpanded: () => void
  onSetConversationTarget: (target: ConversationTarget | null) => void
}

export function SessionHeader({
  session,
  projectSettings,
  model,
  inPlanMode,
  infoExpanded,
  onToggleExpanded,
  onSetConversationTarget,
}: SessionHeaderProps) {
  return (
    <div className="shrink-0 border-b border-border max-h-[30vh] overflow-y-auto">
      <button
        type="button"
        onClick={onToggleExpanded}
        className="w-full p-3 sm:p-4 flex items-center gap-2 hover:bg-muted/30 transition-colors"
      >
        {infoExpanded ? (
          <>
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
            <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Session Info</span>
          </>
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground" />
        )}
        {!infoExpanded &&
          (() => {
            const ps = projectSettings
            return (
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  {ps?.icon && (
                    <span className="shrink-0" style={ps?.color ? { color: ps.color } : undefined}>
                      {renderProjectIcon(ps.icon, 'w-3.5 h-3.5')}
                    </span>
                  )}
                  <span className="text-sm font-bold truncate" style={ps?.color ? { color: ps.color } : undefined}>
                    {ps?.label || projectPath(session.project).split('/').slice(-2).join('/')}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 shrink-0 flex-wrap">
                  <span className="whitespace-nowrap">
                    {formatModel(model || session.model)}
                    {session.effortLevel &&
                      (() => {
                        const effort = formatEffort(session.effortLevel)
                        return effort ? (
                          <span className="text-muted-foreground ml-1" title={`effort: ${effort.label}`}>
                            {effort.symbol}
                          </span>
                        ) : null
                      })()}
                  </span>
                  {(() => {
                    const pm = formatPermissionMode(session.permissionMode)
                    if (!pm && inPlanMode)
                      return (
                        <span className="text-[10px] text-blue-400 font-bold px-1 py-0.5 bg-blue-500/10 rounded">
                          PLAN
                        </span>
                      )
                    if (!pm) return null
                    return (
                      <span
                        className={cn('text-[10px] font-bold px-1 py-0.5 rounded', pm.color, pm.bgColor)}
                        title={`Permission mode: ${session.permissionMode}`}
                      >
                        {pm.label}
                      </span>
                    )
                  })()}
                  {session.capabilities?.includes('ad-hoc') && (
                    <span
                      role="button"
                      tabIndex={0}
                      className="text-[10px] text-amber-400 font-bold px-1 py-0.5 bg-amber-500/10 rounded cursor-pointer hover:bg-amber-500/20"
                      onClick={() => {
                        if (session.adHocTaskId) {
                          window.dispatchEvent(
                            new CustomEvent('open-project-task', { detail: { taskId: session.adHocTaskId } }),
                          )
                        }
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          if (session.adHocTaskId) {
                            window.dispatchEvent(
                              new CustomEvent('open-project-task', { detail: { taskId: session.adHocTaskId } }),
                            )
                          }
                        }
                      }}
                      title={session.adHocTaskId ? `Task: ${session.adHocTaskId}` : 'Ad-hoc session'}
                    >
                      &#x26A1; AD-HOC{session.adHocTaskId ? ` (${session.adHocTaskId})` : ''}
                    </span>
                  )}
                  {session.tokenUsage &&
                    (() => {
                      const { input, cacheCreation, cacheRead } = session.tokenUsage
                      const total = input + cacheCreation + cacheRead
                      const maxTokens = session.contextWindow ?? contextWindowSize(model || session.model)
                      const pct = Math.min(100, Math.round((total / maxTokens) * 100))
                      const totalK = Math.round(total / 1000)
                      const threshold = session.autocompactPct || 83
                      const warnAt = threshold - 5
                      return (
                        <span className="inline-flex items-center gap-1">
                          <span className="text-muted-foreground">·</span>
                          <span className="inline-block w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                            <span
                              className={cn(
                                'block h-full rounded-full',
                                pct < warnAt ? 'bg-emerald-400' : pct < threshold ? 'bg-amber-400' : 'bg-red-400',
                              )}
                              style={{ width: `${pct}%` }}
                            />
                          </span>
                          <span
                            className={cn(
                              'text-[10px] font-mono whitespace-nowrap',
                              pct < warnAt
                                ? 'text-emerald-400/70'
                                : pct < threshold
                                  ? 'text-amber-400/70'
                                  : 'text-red-400/70',
                            )}
                          >
                            {totalK.toLocaleString()}K ({pct}%)
                          </span>
                        </span>
                      )
                    })()}
                  {session.stats &&
                    (() => {
                      const { cost, exact } = getSessionCost(session.stats, model || session.model)
                      if (cost < 0.01) return null
                      return (
                        <span className="inline-flex items-center gap-1">
                          <span className="text-muted-foreground">·</span>
                          <span className={cn('text-[10px] font-mono whitespace-nowrap', getCostColor(cost))}>
                            {formatCost(cost, exact)}
                          </span>
                        </span>
                      )
                    })()}
                  <CacheTimer
                    lastTurnEndedAt={session.lastTurnEndedAt}
                    tokenUsage={session.tokenUsage}
                    model={model || session.model}
                    cacheTtl={session.cacheTtl}
                    isIdle={session.status === 'idle'}
                  />
                </span>
              </span>
            )
          })()}
      </button>
      {!infoExpanded && (session.recap || session.description) && (
        <div
          className={cn(
            'px-3 pb-1.5 -mt-0.5 text-[10px] truncate transition-all duration-700',
            session.recap && session.recapFresh
              ? 'text-zinc-300 border-l-2 border-zinc-500/60 ml-3 pl-2 bg-zinc-800/20 rounded-r'
              : 'text-muted-foreground/70 italic',
          )}
          title={session.recap?.content || session.description}
        >
          {session.recap?.content || session.description}
        </div>
      )}
      <CacheExpiredBanner
        lastTurnEndedAt={session.lastTurnEndedAt}
        tokenUsage={session.tokenUsage}
        model={model || session.model}
        cacheTtl={session.cacheTtl}
        isIdle={session.status === 'idle'}
      />
      {infoExpanded &&
        (() => {
          const s = session.stats
          const tu = session.tokenUsage
          const contextTotal = tu ? tu.input + tu.cacheCreation + tu.cacheRead : 0
          const ctxWindow = session.contextWindow ?? contextWindowSize(model || session.model)
          const contextPct = tu ? Math.min(100, Math.round((contextTotal / ctxWindow) * 100)) : 0
          const compactThreshold = session.autocompactPct || 83
          const compactWarnAt = compactThreshold - 5

          // Cost calculation
          const sessionCost = s ? getSessionCost(s, model || session.model) : { cost: 0, exact: false }
          const burnRate = s ? getBurnRate(sessionCost.cost, session.startedAt, session.lastActivity) : null
          const cacheEff = s ? getCacheEfficiency(s.totalCacheRead, s.totalCacheCreation) : null

          return (
            <div className="px-3 sm:px-4 pb-3 sm:pb-4 text-xs font-mono space-y-3">
              {/* Row 1: Status + Git + Model */}
              <div className="flex items-center gap-3 flex-wrap">
                <span
                  className={cn(
                    'px-2 py-0.5 text-[10px] uppercase font-bold',
                    session.status === 'active' && 'bg-active text-background',
                    session.status === 'idle' && 'bg-idle text-background',
                    session.status === 'starting' && 'bg-idle/50 text-background animate-pulse',
                    session.status === 'ended' && 'bg-ended text-foreground',
                  )}
                >
                  {session.status}
                </span>
                <span className="text-foreground">
                  {formatModel(model || session.model)}
                  {session.effortLevel &&
                    (() => {
                      const effort = formatEffort(session.effortLevel)
                      return effort ? (
                        <span className="text-muted-foreground ml-1">
                          {effort.symbol} {effort.label}
                        </span>
                      ) : null
                    })()}
                </span>
                {(() => {
                  const pm = formatPermissionMode(session.permissionMode)
                  if (!pm) return null
                  return (
                    <span
                      className={cn('px-1.5 py-0.5 text-[9px] font-bold uppercase', pm.color, pm.bgColor)}
                      title={`Permission mode: ${session.permissionMode}`}
                    >
                      {pm.label}
                    </span>
                  )
                })()}
                {session.claudeVersion && (
                  <span className="text-muted-foreground text-[10px]">cc/{session.claudeVersion}</span>
                )}
                {session.claudeAuth?.email && (
                  <span className="text-cyan-400/70 text-[10px]">
                    {session.claudeAuth.email.split('@')[0]}
                    {session.claudeAuth.orgName ? ` / ${session.claudeAuth.orgName}` : ''}
                    {session.claudeAuth.subscriptionType ? (
                      <span className="text-muted-foreground ml-1">[{session.claudeAuth.subscriptionType}]</span>
                    ) : null}
                  </span>
                )}
                {session.gitBranch && (
                  <span className="text-purple-400 text-[10px]">
                    <span className="text-muted-foreground">branch:</span> {session.gitBranch}
                  </span>
                )}
                {session.adHocWorktree && (
                  <span className="px-1.5 py-0.5 text-[9px] uppercase font-bold bg-orange-400/20 text-orange-400">
                    worktree
                  </span>
                )}
                {(session.title || session.agentName) && (
                  <span className="text-foreground text-[10px]">{session.title || session.agentName}</span>
                )}
                {session.description && (
                  <span className="text-muted-foreground/70 text-[10px] italic">{session.description}</span>
                )}
                <span
                  className="text-muted-foreground text-[10px]"
                  title={`session: ${session.id}\nconversations: ${session.conversationIds?.join(', ') || 'none'}`}
                >
                  {session.id.slice(0, 8)}
                  {session.conversationIds?.[0] && session.conversationIds[0] !== session.id && (
                    <span className="text-muted-foreground/50"> c:{session.conversationIds[0].slice(0, 6)}</span>
                  )}
                </span>
                {session.capabilities &&
                  session.capabilities.length > 0 &&
                  session.capabilities.map(cap => (
                    <span
                      key={cap}
                      className={cn(
                        'px-1.5 py-0.5 text-[9px] uppercase font-bold',
                        cap === 'channel'
                          ? 'bg-teal-400/20 text-teal-400'
                          : cap === 'repl'
                            ? 'bg-violet-400/20 text-violet-400'
                            : 'bg-sky-400/20 text-sky-400',
                      )}
                    >
                      {cap}
                    </span>
                  ))}
              </div>

              {/* Row 2: Context window bar */}
              {tu && (
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-[10px] w-16">context</span>
                    <div className="relative flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          contextPct < compactWarnAt
                            ? 'bg-emerald-400'
                            : contextPct < compactThreshold
                              ? 'bg-amber-400'
                              : 'bg-red-400',
                        )}
                        style={{ width: `${contextPct}%` }}
                      />
                      {/* Compaction threshold marker */}
                      <div
                        className="absolute top-0 h-full w-px bg-amber-400/50"
                        style={{ left: `${compactThreshold}%` }}
                        title={`Compaction at ${compactThreshold}%`}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-16" />
                    <span
                      className={cn(
                        'text-[10px] font-mono',
                        contextPct < compactWarnAt
                          ? 'text-emerald-400/70'
                          : contextPct < compactThreshold
                            ? 'text-amber-400/70'
                            : 'text-red-400/70',
                      )}
                    >
                      {Math.round(contextTotal / 1000).toLocaleString()}K /{' '}
                      {Math.round(ctxWindow / 1000).toLocaleString()}K ({contextPct}%)
                      {contextPct >= compactWarnAt && contextPct < compactThreshold && (
                        <span className="text-amber-400/50 ml-1">-- compaction at {compactThreshold}%</span>
                      )}
                    </span>
                  </div>
                </div>
              )}

              {/* Row 3: Token stats */}
              {s && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[10px]">
                  <div>
                    <span className="text-muted-foreground">in </span>
                    <span className="text-cyan-400">{Math.round(s.totalInputTokens / 1000).toLocaleString()}K</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">out </span>
                    <span className="text-orange-400">{Math.round(s.totalOutputTokens / 1000).toLocaleString()}K</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">cache r/w </span>
                    <span className="text-blue-400">{Math.round(s.totalCacheRead / 1000).toLocaleString()}K</span>
                    <span className="text-muted-foreground"> / </span>
                    <span className="text-purple-400">{Math.round(s.totalCacheCreation / 1000).toLocaleString()}K</span>
                    {cacheEff && (
                      <>
                        <br />
                        <span className={cacheEff.color}>
                          {cacheEff.ratio.toFixed(1)}x {cacheEff.label}
                        </span>
                      </>
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground">cost </span>
                    <span className={getCostColor(sessionCost.cost)}>
                      {formatCost(sessionCost.cost, sessionCost.exact)}
                    </span>
                    {burnRate != null && burnRate >= 0.1 && (
                      <span className="text-muted-foreground ml-1">({burnRate.toFixed(1)}/hr)</span>
                    )}
                  </div>
                </div>
              )}

              {/* Cost sparkline */}
              {session.costTimeline && session.costTimeline.length >= 2 && (
                <CostSparkline timeline={session.costTimeline} />
              )}

              {/* Row 4: Session stats */}
              <div className="flex items-center gap-4 text-[10px] flex-wrap">
                {s && s.turnCount > 0 && (
                  <span>
                    <span className="text-muted-foreground">turns </span>
                    <span className="text-foreground">{s.turnCount}</span>
                  </span>
                )}
                {s && s.toolCallCount > 0 && (
                  <span>
                    <span className="text-muted-foreground">tools </span>
                    <span className="text-foreground">{s.toolCallCount}</span>
                  </span>
                )}
                {session.totalSubagentCount > 0 && (
                  <span>
                    <span className="text-muted-foreground">agents </span>
                    <span className="text-foreground">{session.totalSubagentCount}</span>
                  </span>
                )}
                {s && (s.linesAdded > 0 || s.linesRemoved > 0) && (
                  <span>
                    <span className="text-emerald-400">+{s.linesAdded}</span>
                    <span className="text-muted-foreground">/</span>
                    <span className="text-red-400">-{s.linesRemoved}</span>
                  </span>
                )}
                {s && s.compactionCount > 0 && (
                  <span>
                    <span className="text-muted-foreground">compactions </span>
                    <span className="text-amber-400">{s.compactionCount}</span>
                  </span>
                )}
                {s && s.totalApiDurationMs > 0 && (
                  <span>
                    <span className="text-muted-foreground">API </span>
                    <span className="text-foreground">
                      {s.totalApiDurationMs < 60000
                        ? `${(s.totalApiDurationMs / 1000).toFixed(0)}s`
                        : `${Math.floor(s.totalApiDurationMs / 60000)}m${Math.round((s.totalApiDurationMs % 60000) / 1000)}s`}
                    </span>
                  </span>
                )}
                <span>
                  <span className="text-muted-foreground">started </span>
                  <span className="text-foreground">{formatTime(session.startedAt)}</span>
                </span>
                <span>
                  <span className="text-muted-foreground">last </span>
                  <span className="text-foreground">{formatAge(session.lastActivity)}</span>
                </span>
              </div>

              {/* Error banner */}
              {session.lastError && (
                <div className="px-2 py-1.5 bg-destructive/15 border border-destructive/40 text-[10px] font-mono space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-destructive font-bold uppercase">API Error</span>
                    {session.lastError.errorType && (
                      <span className="text-destructive/80">{session.lastError.errorType}</span>
                    )}
                    <span className="text-muted-foreground ml-auto">{formatTime(session.lastError.timestamp)}</span>
                  </div>
                  {session.lastError.errorMessage && (
                    <div className="text-destructive/70">{session.lastError.errorMessage}</div>
                  )}
                  {session.lastError.stopReason && (
                    <div className="text-muted-foreground">reason: {session.lastError.stopReason}</div>
                  )}
                </div>
              )}

              {/* Rate limit warning */}
              {session.rateLimit && (
                <div className="px-2 py-1 bg-amber-500/10 border border-amber-500/30 text-[10px] font-mono flex items-center gap-2">
                  <span className="text-amber-400 font-bold uppercase">Rate Limited</span>
                  <span className="text-amber-400/70">{session.rateLimit.message}</span>
                  <span className="text-muted-foreground ml-auto">{formatTime(session.rateLimit.timestamp)}</span>
                </div>
              )}

              {/* Project path */}
              <div className="flex items-center gap-1 group/project">
                <span className="text-[10px] text-muted-foreground truncate">{projectPath(session.project)}</span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(projectPath(session.project))
                    haptic('tap')
                  }}
                  className="shrink-0 text-muted-foreground/30 hover:text-muted-foreground [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/project:opacity-100 transition-opacity"
                  title="Copy path"
                >
                  <Copy className="w-3 h-3" />
                </button>
              </div>
              <HeaderDescription session={session} />
              {session.summary && (
                <div className="text-[10px] text-muted-foreground/70 truncate" title={session.summary}>
                  {session.summary}
                </div>
              )}
              {session.recap && (
                <div
                  className={cn(
                    'text-[10px] transition-all duration-700',
                    session.recapFresh
                      ? 'text-zinc-300/70 border-l-2 border-zinc-500/40 pl-2 py-1 bg-zinc-800/15 rounded-r leading-relaxed'
                      : 'text-muted-foreground/40 italic truncate',
                  )}
                  title={session.recap.content}
                >
                  {session.recapFresh ? session.recap.content : `Recap: ${session.recap.content}`}
                </div>
              )}
              {session.prLinks && session.prLinks.length > 0 && (
                <div className="flex items-center gap-2 mt-0.5">
                  {session.prLinks.map(pr => (
                    <a
                      key={pr.prUrl}
                      href={pr.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] font-mono text-sky-400 hover:text-sky-300 hover:underline transition-colors"
                    >
                      {pr.prRepository.split('/').pop()}#{pr.prNumber}
                    </a>
                  ))}
                </div>
              )}
              {projectSettings?.trustLevel && projectSettings.trustLevel !== 'default' && (
                <div className="mt-1">
                  <span
                    className={cn(
                      'px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border rounded',
                      projectSettings.trustLevel === 'open'
                        ? 'bg-green-400/15 text-green-400 border-green-400/30'
                        : 'bg-amber-400/15 text-amber-400 border-amber-400/30',
                    )}
                  >
                    {projectSettings.trustLevel === 'open' ? '🔓 Open' : '🤝 Benevolent'}
                  </span>
                </div>
              )}
              {session.linkedProjects && session.linkedProjects.length > 0 && (
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-[10px] text-teal-400/60">projects:</span>
                  {session.linkedProjects.map(lp => (
                    <span key={lp.project} className="inline-flex items-center gap-1 text-[10px] font-mono">
                      <button
                        type="button"
                        className="text-teal-400 hover:text-teal-300 hover:underline cursor-pointer"
                        onClick={() => {
                          haptic('tap')
                          const myName =
                            projectSettings?.label ||
                            projectPath(session.project).split('/').pop() ||
                            session.id.slice(0, 8)
                          onSetConversationTarget({
                            projectA: session.project,
                            projectB: lp.project,
                            nameA: myName,
                            nameB: lp.name,
                          })
                        }}
                        title={`View conversation with ${lp.name}`}
                      >
                        {lp.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          haptic('error')
                          wsSend('channel_unlink', { projectA: session.project, projectB: lp.project })
                        }}
                        className="text-red-400/40 hover:text-red-400 transition-colors"
                        title={`Sever link to ${lp.name}`}
                      >
                        x
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
    </div>
  )
}
