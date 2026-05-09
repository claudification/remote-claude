import type { ReactNode } from 'react'
import { truncate } from '@/lib/utils'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'

function parseTriggerResult(result?: string): { id: string; nextRun?: string } | null {
  if (!result) return null
  const jsonStart = result.indexOf('{')
  if (jsonStart < 0) return null
  try {
    const parsed = JSON.parse(result.slice(jsonStart))
    const trigger = parsed?.trigger || parsed
    const id = trigger?.id as string
    if (!id) return null
    const nextRunRaw = trigger?.next_run_at as string
    let nextRun: string | undefined
    if (nextRunRaw) {
      try {
        const d = new Date(nextRunRaw)
        if (!Number.isNaN(d.getTime())) {
          nextRun = d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        }
      } catch {}
    }
    return { id, nextRun }
  } catch {
    return null
  }
}

export function renderSkill({ input }: ToolCaseInput): ToolCaseResult {
  const skill = input.skill as string
  const args = input.args as string
  return { summary: args ? `${skill} ${args}` : skill, details: null }
}

export function renderNotebookEdit({ input }: ToolCaseInput): ToolCaseResult {
  const cellId = input.cell_id as string
  return { summary: cellId ? `cell ${cellId}` : 'edit', details: null }
}

export function renderSendMessage({ input }: ToolCaseInput): ToolCaseResult {
  const msg = input.message as string
  return { summary: msg?.length > 60 ? `${msg.slice(0, 60)}...` : msg, details: null }
}

export function renderTeam({ input }: ToolCaseInput): ToolCaseResult {
  return { summary: (input.name as string) || '', details: null }
}

export function renderCronCreate({ input, result }: ToolCaseInput): ToolCaseResult {
  const body = input.body as Record<string, unknown> | undefined
  if (body?.name && body?.cron_expression) {
    return renderCronCreateRich(body, result)
  }
  const cronExpr = input.cron as string
  const prompt = input.prompt as string
  const recurring = input.recurring as boolean
  const summary = `${cronExpr}${recurring ? ' (recurring)' : ''}`
  let details: ReactNode = null
  if (prompt) {
    details = (
      <pre className="text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap">
        {truncate(prompt, 500)}
      </pre>
    )
  }
  return { summary, details }
}

function renderCronCreateRich(body: Record<string, unknown>, result?: string): ToolCaseResult {
  const triggerResult = parseTriggerResult(result)
  const summary = (
    <span className="flex items-center gap-1.5">
      <span className="text-sky-400 font-bold">{body.name as string}</span>
      <span className="text-muted-foreground/60 text-[10px]">{body.cron_expression as string}</span>
      {body.enabled === false && <span className="text-red-400/60 text-[9px] font-bold uppercase">disabled</span>}
    </span>
  )
  const jobConfig = body.job_config as Record<string, unknown> | undefined
  const ccr = jobConfig?.ccr as Record<string, unknown> | undefined
  const sessionCtx = ccr?.session_context as Record<string, unknown> | undefined
  const events = ccr?.events as Array<{ data?: { message?: { content?: string } } }> | undefined
  const prompt = events?.[0]?.data?.message?.content || ''
  const mcpConns = body.mcp_connections as Array<{ name: string; url?: string }> | undefined
  const model = sessionCtx?.model as string | undefined
  const allowedTools = sessionCtx?.allowed_tools as string[] | undefined

  const details = (
    <div className="text-[10px] font-mono space-y-1.5">
      <div className="px-2 py-1.5 rounded bg-muted/20 border border-border/20 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          {model && (
            <span className="bg-sky-400/10 text-sky-400/80 border border-sky-400/20 rounded px-1 py-0.5 text-[9px]">
              {model}
            </span>
          )}
          {mcpConns?.map(c => (
            <span
              key={c.name}
              className="bg-teal-400/10 text-teal-400/80 border border-teal-400/20 rounded px-1 py-0.5 text-[9px]"
            >
              {c.name}
            </span>
          ))}
          {allowedTools && allowedTools.length > 0 && (
            <span className="text-muted-foreground/40 text-[9px]">+{allowedTools.length} tools</span>
          )}
        </div>
        {prompt && (
          <div className="text-foreground/70 whitespace-pre-wrap break-words border-t border-border/20 pt-1 mt-1 max-h-48 overflow-y-auto">
            {prompt.length > 800 ? `${prompt.slice(0, 800)}...` : prompt}
          </div>
        )}
      </div>
      {triggerResult && (
        <div className="text-green-400/80 bg-green-400/5 border border-green-400/20 rounded px-2.5 py-1.5 flex items-center gap-2">
          <span className="font-bold">{triggerResult.id}</span>
          {triggerResult.nextRun && <span className="text-muted-foreground/50">next: {triggerResult.nextRun}</span>}
        </div>
      )}
    </div>
  )
  return { summary, details }
}

export function renderCronList({ toolUseResult }: ToolCaseInput): ToolCaseResult {
  const extra = toolUseResult as Record<string, unknown> | undefined
  const jobs = extra?.jobs as
    | Array<{ id: string; humanSchedule: string; prompt: string; recurring: boolean }>
    | undefined
  if (jobs?.length) {
    const summary = `${jobs.length} job${jobs.length !== 1 ? 's' : ''}`
    const details = (
      <div className="text-[10px] font-mono text-muted-foreground space-y-0.5">
        {jobs.map(j => (
          <div key={j.id}>
            <span className="text-sky-400">{j.id.slice(0, 8)}</span>{' '}
            <span className="text-foreground/70">{j.humanSchedule}</span>
            {j.recurring && <span className="text-muted-foreground"> (recurring)</span>}
            {' - '}
            <span>{truncate(j.prompt, 80)}</span>
          </div>
        ))}
      </div>
    )
    return { summary, details }
  }
  return { summary: 'no jobs', details: null }
}

export function renderCronDelete({ input }: ToolCaseInput): ToolCaseResult {
  const jobId = input.id as string
  return { summary: jobId ? `delete ${jobId.slice(0, 8)}` : 'delete', details: null }
}

export function renderScheduleWakeup({ input }: ToolCaseInput): ToolCaseResult {
  const reason = input.reason as string
  const delay = input.delaySeconds as number
  const prompt = input.prompt as string
  const mins = delay ? Math.round(delay / 60) : 0
  const summary = (
    <span className="flex items-center gap-1.5">
      <span className="text-amber-400">{mins}m</span>
      <span className="truncate">{reason}</span>
    </span>
  )
  let details: ReactNode = null
  if (prompt && prompt !== '<<autonomous-loop-dynamic>>') {
    details = (
      <pre className="text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap">
        {truncate(prompt, 500)}
      </pre>
    )
  }
  return { summary, details }
}

export function renderMonitor({ input, toolUseResult }: ToolCaseInput): ToolCaseResult {
  const monDesc = (input.description as string) || ''
  const monCmd = (input.command as string) || ''
  const monTimeout = input.timeout_ms as number | undefined
  const monPersistent = input.persistent as boolean | undefined
  const monExtra = toolUseResult as Record<string, unknown> | undefined
  const monTaskId = (monExtra?.taskId as string) || ''
  const timeoutLabel = monTimeout ? `${Math.round(monTimeout / 1000)}s` : ''
  const summary = (
    <span className="flex items-center gap-1.5">
      <span className="truncate">{monDesc || 'monitor'}</span>
      {timeoutLabel && <span className="text-violet-400/60">{timeoutLabel}</span>}
      {monPersistent && <span className="text-violet-400/50 text-[9px]">persistent</span>}
      {monTaskId && <span className="text-muted-foreground font-mono text-[9px]">{monTaskId.slice(0, 8)}</span>}
    </span>
  )
  let details: ReactNode = null
  if (monCmd) {
    details = (
      <pre className="text-[10px] font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap">
        <span className="text-violet-400/70">$</span> {truncate(monCmd, 500)}
      </pre>
    )
  }
  return { summary, details }
}
