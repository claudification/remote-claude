/**
 * Syntax-highlighted tool output renderers:
 * DiffView (Edit), WritePreview (Write), ShellCommand (Bash), BashOutput (structured)
 */

import { useEffect, useState } from 'react'
import JsonHighlight from '@/components/json-highlight'
import { useConversationsStore } from '@/hooks/use-conversations'
import { resolveToolDisplay, type ToolDisplayKey } from '@/lib/control-panel-prefs'
import { projectPath } from '@/lib/types'
import { cn } from '@/lib/utils'
import { AnsiText, cleanCdPrefix, cleanReplShCalls, escapeHtml, TruncatedPre } from './shared'
import { ensureLang, getHighlighter, langFromPath } from './syntax'

// Single selector: returns project path if sanitizePaths is enabled, undefined otherwise.
// Returns a primitive (string|undefined) so Zustand skips re-renders when the value is stable.
function useSessionPath(): string | undefined {
  return useConversationsStore(s => {
    if (s.controlPanelPrefs.sanitizePaths === false) return undefined
    const sid = s.selectedConversationId
    const session = sid ? s.sessionsById[sid] : undefined
    return session ? projectPath(session.project) : undefined
  })
}

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
  const prefs = useConversationsStore(s => s.controlPanelPrefs)
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
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional, no stable IDs
              <div key={j} className="text-muted-foreground">
                {line.hunkHeader}
              </div>
            )
          }
          const syntaxHtml = highlighted?.get(line.content)
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional, no stable IDs
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

/** Strip leading `# comment` line from shell commands -- redundant with the description field */
function stripLeadingComment(cmd: string): string {
  const m = cmd.match(/^#[^\n]*\\?\s*\n/)
  return m ? cmd.slice(m[0].length) : cmd
}

// Syntax-highlighted shell command block (max 10 lines by default)
export function ShellCommand({ command, maxLines = 10 }: { command: string; maxLines?: number }) {
  const [html, setHtml] = useState<string | null>(null)
  const root = useSessionPath()
  const stripped = stripLeadingComment(command)
  const cleaned = root ? cleanCdPrefix(stripped, root) : stripped
  const lines = cleaned.split('\n')
  const truncated = lines.length > maxLines
  const display = truncated ? lines.slice(0, maxLines).join('\n') : cleaned

  useEffect(() => {
    getHighlighter()
      .then(highlighter => {
        try {
          const tokens = highlighter.codeToTokens(display, { lang: 'shellscript', theme: 'tokyo-night' })
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
  }, [display])

  return (
    <pre className="text-[10px] bg-black/30 p-2 overflow-auto whitespace-pre-wrap font-mono border-l-2 border-green-500/40">
      <span className="text-green-500/60 select-none">$ </span>
      {html ? (
        <code dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <span className="text-foreground/80">{display}</span>
      )}
      {truncated && <span className="text-muted-foreground/40">{`\n... ${lines.length - maxLines} more lines`}</span>}
    </pre>
  )
}

// Syntax-highlighted preview for Write operations
export function WritePreview({ content, filePath }: { content: string; filePath?: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const writePrefs = useConversationsStore(s => s.controlPanelPrefs)
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
              // biome-ignore lint/suspicious/noArrayIndexKey: file lines are positional, no stable IDs
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
              // biome-ignore lint/suspicious/noArrayIndexKey: file lines are positional, no stable IDs
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
// Checks XML tags in result string first, falls back to extra.stdout/stderr
export function BashOutput({
  result,
  command,
  extra,
}: {
  result: string
  command?: string
  extra?: Record<string, unknown>
}) {
  const parts = parseBashTags(result)

  // Fallback: CC may put stdout/stderr in toolUseResult instead of XML tags
  const extraStdout = extra?.stdout as string | undefined
  const extraStderr = extra?.stderr as string | undefined

  if (!parts) {
    const hasExtra = (extraStdout && extraStdout.trim()) || (extraStderr && extraStderr.trim())
    if (hasExtra) {
      return (
        <div className="space-y-1">
          {command && <ShellCommand command={command.trim()} />}
          {extraStdout && extraStdout.trim() && <TruncatedPre text={extraStdout.trim()} tool="Bash" />}
          {extraStderr && extraStderr.trim() && (
            <div className="border-l-2 border-red-500/40">
              <TruncatedPre text={extraStderr.trim()} tool="Bash" />
            </div>
          )}
        </div>
      )
    }
    return (
      <div className="space-y-1">
        {command && <ShellCommand command={command.trim()} />}
        {result && <TruncatedPre text={result} tool="Bash" />}
      </div>
    )
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

// REPL code block - always visible, JS syntax highlighted
export function ReplView({ code, isError }: { code: string; isError?: boolean }) {
  const [codeHtml, setCodeHtml] = useState<string | null>(null)
  const replPrefs = useConversationsStore(s => s.controlPanelPrefs)
  const replDisplay = resolveToolDisplay(replPrefs, 'REPL' as ToolDisplayKey)
  const lineLimit = replDisplay.lineLimit
  const [revealed, setRevealed] = useState(false)
  const root = useSessionPath()
  const displayCode = root ? cleanReplShCalls(code, root) : code

  useEffect(() => {
    getHighlighter()
      .then(highlighter => {
        const tokens = highlighter.codeToTokens(displayCode, { lang: 'javascript', theme: 'tokyo-night' })
        const highlighted = tokens.tokens
          .map((lineTokens: Array<{ color?: string; content: string }>) =>
            lineTokens.map(t => `<span style="color:${t.color}">${escapeHtml(t.content)}</span>`).join(''),
          )
          .join('\n')
        setCodeHtml(highlighted)
      })
      .catch(() => {})
  }, [displayCode])

  const codeLines = displayCode.split('\n')
  const codeTruncate = lineLimit > 0 && codeLines.length > lineLimit && !revealed
  const visibleCodeLines = codeTruncate ? lineLimit : codeLines.length
  const htmlLines = codeHtml ? codeHtml.split('\n') : null

  return (
    <div className="mt-1">
      <pre
        className={cn(
          'text-[10px] font-mono overflow-x-auto rounded px-2.5 py-1.5',
          isError ? 'bg-red-500/5' : 'bg-indigo-500/5',
        )}
      >
        {htmlLines ? (
          <code>
            {htmlLines.slice(0, visibleCodeLines).map((lineHtml, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: code lines are positional
              <div key={i} className="hover:bg-muted/20" dangerouslySetInnerHTML={{ __html: lineHtml }} />
            ))}
          </code>
        ) : (
          <code className="text-foreground/70">
            {codeLines.slice(0, visibleCodeLines).map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: code lines are positional
              <div key={i} className="hover:bg-muted/20">
                {line}
              </div>
            ))}
          </code>
        )}
      </pre>
      {codeTruncate && (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="text-[10px] text-accent hover:text-accent/80 font-mono mt-0.5 px-2"
        >
          +{codeLines.length - lineLimit} more lines
        </button>
      )}
    </div>
  )
}

// REPL result/stdout/stderr - shown inside Collapsible (hidden by default)
export function ReplResult({
  result,
  extra,
  isError,
}: {
  result?: string
  extra?: Record<string, unknown>
  isError?: boolean
}) {
  const structuredResult = extra?.result
  const stdout = extra?.stdout as string | undefined
  const stderr = extra?.stderr as string | undefined
  const hasStdout = stdout && stdout.trim().length > 0
  const hasStderr = stderr && stderr.trim().length > 0

  let resultContent: React.ReactNode = null
  if (structuredResult && typeof structuredResult === 'object') {
    resultContent = (
      <div className="text-[10px] font-mono bg-black/30 rounded px-2.5 py-2 overflow-x-auto">
        <pre className="whitespace-pre-wrap">
          <JsonHighlight data={structuredResult} />
        </pre>
      </div>
    )
  } else if (result) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(result)
    } catch {}
    if (parsed && typeof parsed === 'object') {
      resultContent = (
        <div className="text-[10px] font-mono bg-black/30 rounded px-2.5 py-2 overflow-x-auto">
          <pre className="whitespace-pre-wrap">
            <JsonHighlight data={parsed} />
          </pre>
        </div>
      )
    } else {
      resultContent = <TruncatedPre text={result} tool={'REPL' as ToolDisplayKey} />
    }
  }

  return (
    <div className="space-y-1.5">
      {resultContent}
      {hasStdout && (
        <div>
          <div className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-wider mb-0.5">stdout</div>
          <pre className="text-[10px] font-mono bg-black/20 rounded px-2.5 py-1.5 overflow-x-auto whitespace-pre-wrap text-foreground/70">
            <AnsiText text={stdout} />
          </pre>
        </div>
      )}
      {hasStderr && (
        <div>
          <div className="text-[9px] font-mono text-red-400/50 uppercase tracking-wider mb-0.5">stderr</div>
          <pre className="text-[10px] font-mono bg-red-500/5 border-l-2 border-red-500/40 rounded px-2.5 py-1.5 overflow-x-auto whitespace-pre-wrap text-red-400/80">
            <AnsiText text={stderr} />
          </pre>
        </div>
      )}
    </div>
  )
}
