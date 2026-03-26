/**
 * Syntax-highlighted tool output renderers:
 * DiffView (Edit), WritePreview (Write), ShellCommand (Bash), BashOutput (structured)
 */

import { useEffect, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { resolveToolDisplay } from '@/lib/dashboard-prefs'
import { cn } from '@/lib/utils'
import { escapeHtml, TruncatedPre } from './shared'
import { ensureLang, getHighlighter, langFromPath } from './syntax'

// Syntax-highlighted diff view for Edit operations
export function DiffView({
  patches,
  filePath,
}: {
  patches: Array<{ oldStart: number; lines: string[] }>
  filePath?: string
}) {
  const [highlighted, setHighlighted] = useState<Map<string, string> | null>(null)
  const [revealed, setRevealed] = useState(false)
  const prefs = useSessionsStore(s => s.dashboardPrefs)
  const limit = resolveToolDisplay(prefs, 'Edit').lineLimit

  useEffect(() => {
    const lang = filePath ? langFromPath(filePath) : undefined
    if (!lang) return

    const codeLines: string[] = []
    for (const patch of patches) {
      for (const line of patch.lines) {
        codeLines.push(line.slice(1))
      }
    }
    if (codeLines.length === 0) return

    ensureLang(lang)
      .then(async ok => {
        if (!ok) return
        const highlighter = await getHighlighter()
        const lineMap = new Map<string, string>()
        try {
          const code = codeLines.join('\n')
          const tokens = highlighter.codeToTokens(code, { lang, theme: 'tokyo-night' })
          for (let idx = 0; idx < tokens.tokens.length; idx++) {
            const lineTokens = tokens.tokens[idx] as Array<{ color?: string; content: string }>
            const html = lineTokens.map(t => `<span style="color:${t.color}">${escapeHtml(t.content)}</span>`).join('')
            lineMap.set(codeLines[idx], html)
          }
        } catch {
          // Highlighting failed - fall back to plain
        }
        setHighlighted(lineMap)
      })
      .catch(() => {})
  }, [patches, filePath])

  // Flatten all diff lines for truncation
  const allLines: Array<{ patchIdx: number; prefix: string; content: string; hunkHeader?: string }> = []
  for (let i = 0; i < patches.length; i++) {
    allLines.push({ patchIdx: i, prefix: '', content: '', hunkHeader: `@@ ${patches[i].oldStart} @@` })
    for (const line of patches[i].lines) {
      allLines.push({ patchIdx: i, prefix: line[0] || ' ', content: line.slice(1) })
    }
  }
  const totalLines = allLines.length
  const needsTruncation = limit > 0 && totalLines > limit && !revealed
  const visibleLines = needsTruncation ? allLines.slice(0, limit) : allLines

  return (
    <div>
      <pre className="text-[10px] font-mono overflow-x-auto">
        {visibleLines.map((line, j) => {
          if (line.hunkHeader) {
            return (
              <div key={j} className="text-muted-foreground">
                {line.hunkHeader}
              </div>
            )
          }
          const syntaxHtml = highlighted?.get(line.content)
          return (
            <div
              key={j}
              className={cn(line.prefix === '+' && 'bg-green-500/10', line.prefix === '-' && 'bg-red-500/10')}
            >
              <span
                className={cn(
                  line.prefix === '+' && 'text-green-400',
                  line.prefix === '-' && 'text-red-400',
                  line.prefix !== '+' && line.prefix !== '-' && 'text-muted-foreground',
                )}
              >
                {line.prefix}
              </span>
              {syntaxHtml ? (
                <span dangerouslySetInnerHTML={{ __html: syntaxHtml }} />
              ) : (
                <span
                  className={cn(
                    line.prefix === '+' && 'text-green-400',
                    line.prefix === '-' && 'text-red-400',
                    line.prefix !== '+' && line.prefix !== '-' && 'text-muted-foreground',
                  )}
                >
                  {line.content}
                </span>
              )}
            </div>
          )
        })}
      </pre>
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="text-[10px] text-accent hover:text-accent/80 font-mono mt-0.5 px-2"
        >
          +{totalLines - limit} more lines
        </button>
      )}
    </div>
  )
}

// Syntax-highlighted shell command block
export function ShellCommand({ command }: { command: string }) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    getHighlighter()
      .then(highlighter => {
        try {
          const tokens = highlighter.codeToTokens(command, { lang: 'shellscript', theme: 'tokyo-night' })
          const highlighted = tokens.tokens
            .map((lineTokens: Array<{ color?: string; content: string }>) =>
              lineTokens.map(t => `<span style="color:${t.color}">${escapeHtml(t.content)}</span>`).join(''),
            )
            .join('\n')
          setHtml(highlighted)
        } catch {
          // Fall back to plain
        }
      })
      .catch(() => {})
  }, [command])

  return (
    <pre className="text-[10px] bg-black/30 p-2 overflow-auto whitespace-pre-wrap font-mono border-l-2 border-green-500/40">
      <span className="text-green-500/60 select-none">$ </span>
      {html ? (
        <code dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <span className="text-foreground/80">{command}</span>
      )}
    </pre>
  )
}

// Syntax-highlighted preview for Write operations
export function WritePreview({ content, filePath }: { content: string; filePath?: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const writePrefs = useSessionsStore(s => s.dashboardPrefs)
  const writeDisplay = resolveToolDisplay(writePrefs, 'Write')
  const limit = writeDisplay.lineLimit
  const truncated = content.length > 3000 ? content.slice(0, 3000) : content
  const lines = truncated.split('\n')
  const lineTruncate = limit > 0 && lines.length > limit && !revealed

  useEffect(() => {
    const lang = filePath ? langFromPath(filePath) : undefined
    if (!lang) return

    ensureLang(lang)
      .then(async ok => {
        if (!ok) return
        const highlighter = await getHighlighter()
        try {
          const tokens = highlighter.codeToTokens(truncated, { lang, theme: 'tokyo-night' })
          const highlighted = tokens.tokens
            .map((lineTokens: Array<{ color?: string; content: string }>) =>
              lineTokens.map(t => `<span style="color:${t.color}">${escapeHtml(t.content)}</span>`).join(''),
            )
            .join('\n')
          setHtml(highlighted)
        } catch {
          // Fall back to plain
        }
      })
      .catch(() => {})
  }, [truncated, filePath])

  const gutterWidth = String(lines.length).length
  const visibleLines = lineTruncate ? limit : lines.length
  const htmlLines = html ? html.split('\n') : null

  return (
    <div>
      <pre className="text-[10px] font-mono overflow-x-auto">
        {htmlLines ? (
          <code>
            {htmlLines.slice(0, visibleLines).map((lineHtml, i) => (
              <div key={i} className="hover:bg-muted/20">
                <span
                  className="text-muted-foreground/40 select-none inline-block text-right mr-3"
                  style={{ width: `${gutterWidth + 1}ch` }}
                >
                  {i + 1}
                </span>
                <span dangerouslySetInnerHTML={{ __html: lineHtml }} />
              </div>
            ))}
          </code>
        ) : (
          <code className="text-foreground/70">
            {lines.slice(0, visibleLines).map((line, i) => (
              <div key={i} className="hover:bg-muted/20">
                <span
                  className="text-muted-foreground/40 select-none inline-block text-right mr-3"
                  style={{ width: `${gutterWidth + 1}ch` }}
                >
                  {i + 1}
                </span>
                {line}
              </div>
            ))}
          </code>
        )}
        {!lineTruncate && content.length > 3000 && (
          <div className="text-muted-foreground mt-1">... +{content.length - 3000} chars truncated</div>
        )}
      </pre>
      {lineTruncate && (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="text-[10px] text-accent hover:text-accent/80 font-mono mt-0.5 px-2"
        >
          +{lines.length - limit} more lines
        </button>
      )}
    </div>
  )
}

// Parse structured bash output with <bash-input>, <bash-stdout>, <bash-stderr> tags
interface BashParts {
  input?: string
  stdout?: string
  stderr?: string
}

function parseBashTags(result: string): BashParts | null {
  const hasTag = /<bash-(input|stdout|stderr)>/.test(result)
  if (!hasTag) return null

  function extract(tag: string): string | undefined {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
    const m = result.match(re)
    return m ? m[1] : undefined
  }

  return {
    input: extract('bash-input'),
    stdout: extract('bash-stdout'),
    stderr: extract('bash-stderr'),
  }
}

// Structured bash output renderer - separates input/stdout/stderr
export function BashOutput({ result, command }: { result: string; command?: string }) {
  const parts = parseBashTags(result)

  if (!parts) {
    return <TruncatedPre text={result} tool="Bash" />
  }

  const hasStdout = parts.stdout && parts.stdout.trim().length > 0
  const hasStderr = parts.stderr && parts.stderr.trim().length > 0
  const displayCommand = parts.input || command

  return (
    <div className="space-y-1">
      {displayCommand && <ShellCommand command={displayCommand.trim()} />}
      {hasStdout && parts.stdout && <TruncatedPre text={parts.stdout.trim()} tool="Bash" />}
      {hasStderr && parts.stderr && (
        <div className="border-l-2 border-red-500/40">
          <TruncatedPre text={parts.stderr.trim()} tool="Bash" />
        </div>
      )}
      {!hasStdout && !hasStderr && !displayCommand && (
        <pre className="text-[10px] bg-black/30 p-2 font-mono text-muted-foreground">(no output)</pre>
      )}
    </div>
  )
}
