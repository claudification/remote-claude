import type { ReactNode } from 'react'
import { Markdown } from '@/components/markdown'
import { cn } from '@/lib/utils'
import { ConversationTag } from './conversation-tag'
import { extractMcpText, shortPath, TruncatedPre } from './shared'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'
import { WritePreview } from './tool-renderers'

export function renderMcpSendMessage({ input, result }: ToolCaseInput): ToolCaseResult {
  const to = (input.to as string) || ''
  const intent = (input.intent as string) || ''
  const msg = (input.message as string) || ''
  const targetIdMatch = result?.match(/target_session_id:\s*([0-9a-f-]{36})/)
  const targetSessionId = targetIdMatch?.[1]
  const intentStyles: Record<string, string> = {
    request: 'bg-yellow-400/15 text-yellow-400 border-yellow-400/30',
    response: 'bg-green-400/15 text-green-400 border-green-400/30',
    notify: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
    progress: 'bg-zinc-400/15 text-zinc-400 border-zinc-400/30',
  }
  const summary = (
    <span className="flex items-center gap-1.5">
      <span className="text-teal-400/60">to</span>
      <ConversationTag idOrSlug={to} resolvedId={targetSessionId} />
      {intent && (
        <span
          className={cn(
            'px-1 py-0.5 text-[8px] font-bold uppercase border rounded',
            intentStyles[intent] || intentStyles.notify,
          )}
        >
          {intent}
        </span>
      )}
    </span>
  )
  let details: ReactNode = null
  if (msg) {
    details = (
      <div className="rounded-lg border border-teal-500/20 bg-teal-500/5 px-3 py-2 my-1">
        <div className="text-sm prose-sm">
          <Markdown copyable>{msg}</Markdown>
        </div>
      </div>
    )
  }
  return { summary, details }
}

export function renderMcpSessionLifecycle(name: string, { input, result }: ToolCaseInput): ToolCaseResult {
  const conversationId = (input.session_id as string) || ''
  const action = name.includes('revive') ? 'revive' : 'terminate'
  const actionColor = action === 'revive' ? 'text-green-400' : 'text-red-400'
  const summary = (
    <span className="flex items-center gap-1.5">
      <span className={actionColor}>{action}</span>
      <ConversationTag idOrSlug={conversationId} />
    </span>
  )
  const details = result ? <TruncatedPre text={result} tool="MCP" /> : null
  return { summary, details }
}

export function renderMcpListConversations({ input, result }: ToolCaseInput): ToolCaseResult {
  const parts: string[] = []
  if (input.filter) parts.push(`glob=${input.filter}`)
  if (input.status) parts.push(`status=${input.status}`)
  let summary: ReactNode = parts.length ? parts.join(' ') : 'all'
  let details: ReactNode = null
  if (result) {
    try {
      let parsed = JSON.parse(result)
      if (Array.isArray(parsed) && parsed[0]?.type === 'text' && typeof parsed[0].text === 'string') {
        parsed = JSON.parse(parsed[0].text)
      }
      const sessions: Array<{ id: string; status: string }> = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.sessions)
          ? parsed.sessions
          : []
      summary = `${sessions.length} conversations${parts.length ? ` (${parts.join(', ')})` : ''}`
      details = (
        <div className="text-[10px] font-mono space-y-0.5 mt-1">
          {sessions.map(s => (
            <div key={s.id} className="flex items-center gap-2">
              <span
                className={cn(
                  'w-1.5 h-1.5 rounded-full shrink-0',
                  s.status === 'live' ? 'bg-green-400' : 'bg-zinc-600',
                )}
              />
              <ConversationTag idOrSlug={s.id} />
            </div>
          ))}
        </div>
      )
    } catch {
      details = <TruncatedPre text={result} tool="MCP" />
    }
  }
  return { summary, details }
}

export function renderMcpControlSession({ input, result, toolUseResult, isError }: ToolCaseInput): ToolCaseResult {
  const ctrlAction = input.action as string
  const ctrlTarget = input.session_id as string
  const ctrlModel = input.model as string | undefined
  const ctrlEffort = input.effort as string | undefined
  const ctrlPermMode = input.permissionMode as string | undefined
  const resultText = result ? extractMcpText(result, toolUseResult) || result : undefined

  const actionColors: Record<string, string> = {
    quit: 'text-red-400',
    clear: 'text-amber-400',
    interrupt: 'text-orange-400',
    set_model: 'text-violet-400',
    set_effort: 'text-cyan-400',
    set_permission_mode: 'text-blue-400',
  }
  const actionLabel =
    ctrlAction === 'set_model'
      ? `model -> ${ctrlModel}`
      : ctrlAction === 'set_effort'
        ? `effort -> ${ctrlEffort}`
        : ctrlAction === 'set_permission_mode'
          ? `perms -> ${ctrlPermMode}`
          : ctrlAction
  const summary = (
    <span className="flex items-center gap-1.5">
      <span className={actionColors[ctrlAction] || 'text-foreground'}>{actionLabel}</span>
      <span className="text-muted-foreground">{ctrlTarget}</span>
    </span>
  )
  let details: ReactNode = null
  if (isError) {
    details = <pre className="text-[10px] text-red-400 bg-red-400/10 p-2 rounded whitespace-pre-wrap">{result}</pre>
  } else if (resultText) {
    details = (
      <div className="text-[10px] font-mono text-muted-foreground bg-muted/30 rounded px-3 py-1.5">{resultText}</div>
    )
  }
  return { summary, details }
}

export function renderMcpConfigureSession({ input }: ToolCaseInput): ToolCaseResult {
  const cfgTarget = input.session_id as string
  const cfgFields = ['label', 'icon', 'color', 'description', 'keyterms'].filter(k => input[k] !== undefined).join(', ')
  const summary = (
    <span className="flex items-center gap-1.5">
      <span className="text-blue-400">configure</span>
      <span className="text-muted-foreground">{cfgTarget}</span>
      <span className="text-muted-foreground/50 text-[10px]">[{cfgFields || 'no fields'}]</span>
    </span>
  )
  return { summary, details: null }
}

export function renderMcpDialog({ input }: ToolCaseInput): ToolCaseResult {
  const title = (input.title as string) || 'Dialog'
  const pageCount = Array.isArray(input.pages) ? (input.pages as unknown[]).length : 0
  const bodyCount = Array.isArray(input.body) ? (input.body as unknown[]).length : 0
  const componentDesc = pageCount > 0 ? `${pageCount} pages` : `${bodyCount} components`
  const summary = (
    <span className="flex items-center gap-1.5">
      <span className="text-violet-400 font-bold">{title}</span>
      <span className="text-muted-foreground/50 text-[10px]">{componentDesc}</span>
    </span>
  )
  const details = (
    <div className="text-[10px] font-mono bg-violet-500/5 border border-violet-500/20 rounded px-3 py-2 text-violet-400/70">
      Waiting for user response...
    </div>
  )
  return { summary, details }
}

export function renderMcpDefault(name: string, { input, result, toolUseResult }: ToolCaseInput): ToolCaseResult {
  const parts = name.split('__')
  const server = parts[1] || ''
  const toolName = parts.slice(2).join('__') || ''
  const inputEntries = Object.entries(input).filter(([k]) => k !== 'type')
  const inputSummary = inputEntries
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v)
      return `${k}=${typeof val === 'string' && val.length > 40 ? `${val.slice(0, 40)}...` : val}`
    })
    .join(', ')
  const summary = inputSummary || `${server}/${toolName}`
  let details: ReactNode = null
  if (result && typeof result === 'string' && result.trim()) {
    const mcpText = extractMcpText(result, toolUseResult)
    if (mcpText) {
      details = (
        <div className="text-xs prose-sm max-h-96 overflow-y-auto">
          <Markdown>{mcpText}</Markdown>
        </div>
      )
    } else {
      details = <TruncatedPre text={result} tool="MCP" />
    }
  }
  return { summary, details }
}

export function renderMcpNotify({ input }: ToolCaseInput): ToolCaseResult {
  return { summary: (input.message as string)?.slice(0, 80) || 'notification', details: null }
}

export function renderPlanMode(name: string, { planContent, planPath }: ToolCaseInput): ToolCaseResult {
  if (name === 'EnterPlanMode') {
    return { summary: 'entering plan mode', details: null }
  }
  const summary = planPath ? `plan: ${shortPath(planPath)}` : 'exiting plan mode'
  let details: ReactNode = null
  if (planContent) {
    details = <WritePreview content={planContent} filePath={planPath || 'plan.md'} />
  }
  return { summary, details }
}
