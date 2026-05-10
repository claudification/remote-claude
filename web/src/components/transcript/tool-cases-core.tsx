import { structuredPatch } from 'diff'
import { cleanCdPrefix, shortPath } from './shared'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'
import { BashOutput, DiffView, ReplResult, ReplView, ShellCommand, WritePreview } from './tool-renderers'

export function renderBash({ input, result, toolUseResult, sessionPath, expandAll }: ToolCaseInput): ToolCaseResult {
  const cmd = input.command as string
  const bashDesc = input.description as string | undefined
  const displayCmd = sessionPath && cmd ? cleanCdPrefix(cmd, sessionPath) : cmd
  const summary = bashDesc || (displayCmd?.length > 80 && !expandAll ? `${displayCmd.slice(0, 80)}...` : displayCmd)
  let details = null
  if (result || toolUseResult?.stdout) {
    details = <BashOutput result={result || ''} command={cmd} extra={toolUseResult} />
  } else if (cmd) {
    details = <ShellCommand command={cmd} />
  }
  return { summary, details }
}

export function renderRepl({ input, result, toolUseResult, isError }: ToolCaseInput): ToolCaseResult {
  const replDesc = input.description as string | undefined
  const replCode = input.code as string
  const summary = replDesc || (replCode?.length > 80 ? `${replCode.slice(0, 80)}...` : replCode)
  let inlineContent = null
  let details = null
  if (replCode) {
    inlineContent = <ReplView code={replCode} isError={isError} />
    const hasResult = result || toolUseResult?.result
    const hasStdout = toolUseResult?.stdout && (toolUseResult.stdout as string).trim()
    const hasStderr = toolUseResult?.stderr && (toolUseResult.stderr as string).trim()
    if (hasResult || hasStdout || hasStderr) {
      details = <ReplResult result={result} extra={toolUseResult} />
    }
  }
  return { summary, details, inlineContent }
}

export function renderRead({ input, result, toolUseResult }: ToolCaseInput): ToolCaseResult {
  const path = input.path as string
  const readPath = shortPath(path) || path

  if (toolUseResult?.type && toolUseResult.type !== 'text') {
    return renderBinaryRead(path, readPath, toolUseResult)
  }

  return renderTextRead(path, readPath, input, result, toolUseResult)
}

function renderBinaryRead(path: string, readPath: string, toolUseResult: Record<string, unknown>): ToolCaseResult {
  const binFile = toolUseResult.file as
    | {
        url?: string
        type?: string
        originalSize?: number
        dimensions?: {
          originalWidth: number
          originalHeight: number
          displayWidth: number
          displayHeight: number
        }
      }
    | undefined
  const binType = toolUseResult.type as string
  const isImage = binType === 'image'
  const dims = binFile?.dimensions
  const dimStr = dims ? `${dims.originalWidth}x${dims.originalHeight}` : ''
  const sizeKB = binFile?.originalSize ? `${(binFile.originalSize / 1024).toFixed(0)}KB` : ''
  const summary = (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="truncate text-foreground/90">{readPath}</span>
      {!isImage && <span className="text-violet-400/70 shrink-0">{binType}</span>}
      {dimStr && <span className="text-cyan-400/70 shrink-0">{dimStr}</span>}
      {sizeKB && <span className="text-muted-foreground/50 shrink-0">({sizeKB})</span>}
    </span>
  )
  let details = null
  if (binFile?.url) {
    if (isImage) {
      details = (
        <div className="space-y-1.5 py-1">
          <img
            src={binFile.url}
            alt={path?.split('/').pop() || 'image'}
            className="max-w-sm max-h-64 rounded border border-border/50 hover:border-primary/50 transition-colors"
            loading="lazy"
          />
        </div>
      )
    } else {
      details = (
        <div className="text-[10px] font-mono flex items-center gap-2 py-1">
          {binFile.type && <span className="text-muted-foreground">{binFile.type}</span>}
          {sizeKB && <span className="text-muted-foreground">{sizeKB}</span>}
          <a
            href={binFile.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:text-accent/80 underline"
          >
            view file
          </a>
        </div>
      )
    }
  } else {
    details = (
      <div className="text-[10px] text-muted-foreground font-mono flex items-center gap-2 py-1">
        {binFile?.type && <span>{binFile.type}</span>}
        {dimStr && <span>{dimStr}</span>}
        {sizeKB && <span>{sizeKB}</span>}
        <span className="text-amber-400/70">(file not available)</span>
      </div>
    )
  }
  return { summary, details }
}

function renderTextRead(
  path: string,
  readPath: string,
  input: Record<string, unknown>,
  result?: string,
  toolUseResult?: Record<string, unknown>,
): ToolCaseResult {
  const readFile = toolUseResult?.file as
    | { content?: string; filePath?: string; numLines?: number; startLine?: number; totalLines?: number }
    | undefined
  const readContent = result || readFile?.content
  const startLine = readFile?.startLine ?? (input.offset as number | undefined)
  const numLines = readFile?.numLines
  const totalLines = readFile?.totalLines
  const endLine = startLine && numLines ? startLine + numLines - 1 : undefined
  const isPartial = Boolean(startLine && totalLines && (startLine > 1 || (numLines && numLines < totalLines)))
  const summary = (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="truncate text-foreground/90">{readPath}</span>
      {isPartial && startLine && endLine && totalLines ? (
        <span className="text-muted-foreground/70 shrink-0">
          lines <span className="text-sky-400">{startLine}</span>
          <span className="text-muted-foreground/50">-</span>
          <span className="text-sky-400">{endLine}</span>
          <span className="text-muted-foreground/50"> of </span>
          <span className="text-foreground/70">{totalLines.toLocaleString()}</span>
        </span>
      ) : totalLines ? (
        <span className="text-muted-foreground/70 shrink-0">
          <span className="text-foreground/70">{totalLines.toLocaleString()}</span>{' '}
          <span className="text-muted-foreground/50">lines</span>
        </span>
      ) : null}
    </span>
  )
  let details = null
  if (readContent) {
    details = <WritePreview content={readContent} filePath={path} />
  }
  return { summary, details }
}

export function renderEdit({ input, toolUseResult, isError }: ToolCaseInput): ToolCaseResult {
  const path = input.path as string
  const oldText = input.oldText as string | undefined
  const newText = input.newText as string | undefined
  const summary = shortPath(path) || path
  let details = null
  if (!isError) {
    const patches = (toolUseResult as { structuredPatch?: Array<{ oldStart: number; lines: string[] }> })
      ?.structuredPatch
    if (patches?.length) {
      details = <DiffView patches={patches} filePath={path} />
    } else if (oldText && newText) {
      const oldStr = oldText
      const newStr = newText
      const originalFile = (toolUseResult as { originalFile?: string })?.originalFile
      let patch: ReturnType<typeof structuredPatch>
      if (originalFile) {
        const modifiedFile = originalFile.replace(oldStr, newStr)
        patch = structuredPatch('file', 'file', originalFile, modifiedFile, '', '', { context: 3 })
      } else {
        patch = structuredPatch('file', 'file', oldStr, newStr, '', '', { context: 3 })
      }
      if (patch.hunks.length > 0) {
        details = <DiffView patches={patch.hunks} filePath={path} />
      }
    }
  }
  return { summary, details }
}

export function renderWrite({ input }: ToolCaseInput): ToolCaseResult {
  const path = input.path as string
  const content = input.content as string
  const summary = `${shortPath(path)} (${content?.length || 0} chars)`
  let details = null
  if (content) {
    details = <WritePreview content={content} filePath={path} />
  }
  return { summary, details }
}
