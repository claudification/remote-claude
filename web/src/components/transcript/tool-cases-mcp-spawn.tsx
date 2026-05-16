import type { ReactNode } from 'react'
import { Markdown } from '@/components/markdown'
import { cn } from '@/lib/utils'
import { Collapsible, extractMcpText, shortPath } from './shared'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'

export function renderMcpSpawnConversation({ input, result, toolUseResult, isError }: ToolCaseInput): ToolCaseResult {
  const inputCwd = input.cwd as string
  const mode = input.mode as string | undefined
  const shortCwd = shortPath(inputCwd) || inputCwd
  const modeLabel = mode === 'resume' ? 'resume' : 'fresh'
  const spawnName = input.name as string | undefined
  const spawnModel = input.model as string | undefined
  const spawnWorktree = input.worktree as string | undefined
  const spawnHeadless = input.headless as boolean | undefined
  const spawnPermMode = input.permissionMode as string | undefined
  const spawnPrompt = input.prompt as string | undefined
  const spawnEffort = input.effort as string | undefined
  const spawnAdHoc = input.adHoc as boolean | undefined
  const spawnDescription = input.description as string | undefined

  const resultText = result ? extractMcpText(result, toolUseResult) || result : undefined

  const summary = (
    <span className="flex items-center gap-1.5 flex-wrap">
      <span className="text-green-400">spawn</span>
      {spawnName ? (
        <>
          <span className="text-foreground font-bold">{spawnName}</span>
          <span className="text-muted-foreground">{shortCwd}</span>
        </>
      ) : (
        <span className="text-foreground font-bold">{shortCwd}</span>
      )}
      <span className="text-muted-foreground text-[10px]">[{modeLabel}]</span>
      {spawnModel && (
        <span className="px-1 py-0.5 bg-violet-500/20 text-violet-400 border border-violet-500/30 rounded text-[9px] font-bold">
          {spawnModel}
        </span>
      )}
      {spawnWorktree && (
        <span className="px-1 py-0.5 bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded text-[9px]">
          {spawnWorktree}
        </span>
      )}
      {spawnHeadless && <span className="text-muted-foreground text-[10px]">headless</span>}
    </span>
  )

  let details: ReactNode
  if (isError) {
    details = <pre className="text-[10px] text-red-400 bg-red-400/10 p-2 rounded whitespace-pre-wrap">{result}</pre>
  } else {
    details = renderSpawnDetails({ spawnPermMode, spawnEffort, spawnAdHoc, spawnDescription, spawnPrompt, resultText })
  }
  return { summary, details }
}

function renderSpawnDetails({
  spawnPermMode,
  spawnEffort,
  spawnAdHoc,
  spawnDescription,
  spawnPrompt,
  resultText,
}: {
  spawnPermMode?: string
  spawnEffort?: string
  spawnAdHoc?: boolean
  spawnDescription?: string
  spawnPrompt?: string
  resultText?: string
}): ReactNode {
  const badges: Array<{ label: string; value: string; cls: string }> = []
  if (spawnPermMode)
    badges.push({
      label: 'perms',
      value: spawnPermMode,
      cls:
        spawnPermMode === 'bypassPermissions'
          ? 'bg-red-500/20 text-red-400 border-red-500/30'
          : 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
    })
  if (spawnEffort)
    badges.push({
      label: 'effort',
      value: spawnEffort,
      cls: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    })
  if (spawnAdHoc)
    badges.push({ label: '', value: 'ad-hoc', cls: 'bg-orange-500/20 text-orange-400 border-orange-500/30' })

  const promptCharCount = spawnPrompt ? spawnPrompt.length : 0
  const promptLabel = `Prompt (${promptCharCount >= 1000 ? `${(promptCharCount / 1000).toFixed(1)}k` : promptCharCount} chars)`

  return (
    <div className="text-[10px] font-mono bg-green-400/5 border border-green-500/20 rounded p-2.5 space-y-2">
      {badges.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {badges.map(b => (
            <span key={b.value} className={cn('px-1.5 py-0.5 border rounded text-[9px] font-bold', b.cls)}>
              {b.label ? `${b.label}: ` : ''}
              {b.value}
            </span>
          ))}
        </div>
      )}
      {spawnDescription && <div className="text-foreground/70 text-[11px]">{spawnDescription}</div>}
      {spawnPrompt && (
        <Collapsible label={promptLabel} defaultOpen={false}>
          <div className="max-h-[400px] overflow-y-auto border-l-2 border-green-500/30 pl-2.5">
            <div className="text-[11px] font-sans prose-sm">
              <Markdown>{spawnPrompt}</Markdown>
            </div>
          </div>
        </Collapsible>
      )}
      {resultText && <div className="text-green-400/80 pt-1 border-t border-green-500/10">{resultText}</div>}
    </div>
  )
}
