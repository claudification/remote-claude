import { memo, type ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { resolveToolDisplay, type ToolDisplayKey } from '@/lib/control-panel-prefs'
import { ensureCanonical } from '@/lib/legacy-to-canonical'
import { projectPath, type TranscriptContentBlock } from '@/lib/types'
import { cn } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'
import { Collapsible, getToolStyle } from './shared'
import type { ToolCaseInput } from './tool-case-types'
import { dispatchToolCase, renderErrorFallback, renderPersistedOutput } from './tool-dispatch'

export { dispatchToolCase, renderErrorFallback, renderPersistedOutput } from './tool-dispatch'

export function ToolLine({
  tool,
  result,
  toolUseResult,
  isError,
  expandAll: expandAllProp,
  subagents,
  renderAgentInline,
  planContent,
  planPath,
}: {
  tool: TranscriptContentBlock
  result?: string
  toolUseResult?: Record<string, unknown>
  isError?: boolean
  expandAll?: boolean
  planContent?: string
  planPath?: string
  subagents?: Array<{
    agentId: string
    agentType: string
    description?: string
    status: 'running' | 'stopped'
    startedAt: number
    stoppedAt?: number
    eventCount: number
    tokenUsage?: { totalInput: number; totalOutput: number; cacheCreation: number; cacheRead: number }
  }>
  renderAgentInline?: (agentId: string, toolId?: string) => ReactNode
}) {
  // Synthesize canonical fields (kind / canonicalInput) for legacy entries
  // that pre-date Phase 2 translators. Idempotent for already-translated blocks.
  ensureCanonical(tool)
  const name = tool.name || 'Tool'
  const input = tool.input || {}
  const style = getToolStyle(name)
  const expandAllStore = useConversationsStore(state => state.expandAll)
  const expandAll = expandAllProp ?? expandAllStore
  const displayKey = name.startsWith('mcp__') ? 'MCP' : name
  const toolDefaultOpen = useConversationsStore(
    state => resolveToolDisplay(state.controlPanelPrefs, displayKey as ToolDisplayKey).defaultOpen,
  )
  const sessionPath = useConversationsStore(s => {
    if (s.controlPanelPrefs.sanitizePaths === false) return undefined
    const sid = s.selectedConversationId
    const session = sid ? s.sessionsById[sid] : undefined
    return session ? projectPath(session.project) : undefined
  })

  const ctx: ToolCaseInput = {
    input,
    result,
    toolUseResult,
    isError,
    sessionPath,
    expandAll,
    subagents,
    planContent,
    planPath,
  }

  const caseResult = dispatchToolCase(name, ctx, tool.kind)
  let { summary, details } = caseResult
  const { inlineContent, agentBadge, matchedAgentId } = caseResult

  if (isError && !details && result) {
    details = renderErrorFallback(result)
  }

  if (!isError && !details && result) {
    details = renderPersistedOutput(result)
  }

  const { Icon } = style
  const displayName = name.startsWith('mcp__')
    ? name.split('__').slice(2).join('/') || name.split('__')[1] || name
    : name

  return (
    <div className={cn('font-mono text-xs', isError && 'border-l-2 border-red-500/60 pl-1.5')}>
      <div className="flex items-center gap-2">
        <span className={cn('shrink-0 flex items-center gap-1', isError ? 'text-red-400' : style.color)} title={name}>
          <Icon className="w-3 h-3 shrink-0" />
          <span className="truncate max-w-[120px]">{displayName}</span>
        </span>
        <span className={cn('truncate flex-1', isError ? 'text-red-400/80' : 'text-foreground/80')}>
          {isError && <span className="text-red-500 font-bold mr-1">ERROR</span>}
          {summary}
        </span>
        {agentBadge}
        <JsonInspector
          title={name}
          data={tool.canonicalInput ?? input}
          result={result}
          extra={toolUseResult}
          raw={tool.raw ?? tool}
        />
      </div>
      {inlineContent}
      {details && (
        <Collapsible
          id={tool.id ? `tool-${tool.id}` : undefined}
          label="output"
          defaultOpen={isError || toolDefaultOpen}
        >
          {details}
        </Collapsible>
      )}
      {matchedAgentId && renderAgentInline?.(matchedAgentId, tool.id)}
    </div>
  )
}

export const MemoizedToolLine = memo(ToolLine)
