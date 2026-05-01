/**
 * Grep + Glob result renderers. Three Grep modes (files_with_matches, content,
 * count) each get a tailored layout. Glob shares the file-list layout.
 *
 * Result shape (from CC's toolUseResult):
 *   Glob:   { filenames: string[], numFiles: number, truncated?: boolean, durationMs?: number }
 *   Grep files_with_matches: { mode, filenames, numFiles }
 *   Grep content:            { mode, filenames, numFiles, content: "file:line:text\n...", numLines }
 *   Grep count:              { mode, filenames, numFiles, content: "file:N\n...", numMatches }
 */

import { useMemo, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-sessions'
import { resolveToolDisplay } from '@/lib/control-panel-prefs'
import { projectPath } from '@/lib/types'
import { cn } from '@/lib/utils'
import { escapeHtml } from './shared'

const FILE_LIST_DEFAULT_LIMIT = 30
const CONTENT_LINE_DEFAULT_LIMIT = 40
const COUNT_BAR_DEFAULT_LIMIT = 25

function useSessionPath(): string | undefined {
  return useConversationsStore(s => {
    if (s.controlPanelPrefs.sanitizePaths === false) return undefined
    const sid = s.selectedSessionId
    const session = sid ? s.sessionsById[sid] : undefined
    return session ? projectPath(session.project) : undefined
  })
}

function useToolLineLimit(tool: 'Grep' | 'Glob', fallback: number): number {
  return useConversationsStore(s => {
    const v = resolveToolDisplay(s.controlPanelPrefs, tool).lineLimit
    return v > 0 ? v : fallback
  })
}

/** Make a path relative to root when it lives under root, else keep absolute. */
function relToRoot(path: string, root?: string): string {
  if (!root) return path
  const normRoot = root.replace(/\/$/, '')
  if (path === normRoot) return '.'
  if (path.startsWith(`${normRoot}/`)) return path.slice(normRoot.length + 1)
  return path
}

function splitDirAndName(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf('/')
  if (idx < 0) return { dir: '', name: path }
  return { dir: path.slice(0, idx), name: path.slice(idx + 1) }
}

function groupByDir(filenames: string[], root?: string): Array<{ dir: string; files: string[] }> {
  const groups = new Map<string, string[]>()
  for (const raw of filenames) {
    const rel = relToRoot(raw, root)
    const { dir, name } = splitDirAndName(rel)
    const list = groups.get(dir) ?? []
    list.push(name)
    groups.set(dir, list)
  }
  const result: Array<{ dir: string; files: string[] }> = []
  for (const [dir, files] of groups) {
    files.sort((a, b) => a.localeCompare(b))
    result.push({ dir, files })
  }
  result.sort((a, b) => a.dir.localeCompare(b.dir))
  return result
}

/**
 * Render the matched substring with a colored highlight while keeping
 * surrounding text. Pattern may be invalid regex -- caller passes undefined
 * in that case.
 */
function highlightLine(line: string, highlight?: RegExp): string {
  const safe = escapeHtml(line)
  if (!highlight) return safe
  try {
    return safe.replace(highlight, m => `<mark class="bg-amber-400/40 text-inherit rounded-sm px-0.5">${m}</mark>`)
  } catch {
    return safe
  }
}

// ─── File list (Glob + Grep files_with_matches) ──────────────────

export function FileListResults({
  filenames,
  numFiles,
  truncated,
  emptyLabel = 'No matches',
}: {
  filenames: string[]
  numFiles?: number
  truncated?: boolean
  emptyLabel?: string
}) {
  const root = useSessionPath()
  const limit = useToolLineLimit('Grep', FILE_LIST_DEFAULT_LIMIT)
  const [revealed, setRevealed] = useState(false)

  const groups = useMemo(() => groupByDir(filenames, root), [filenames, root])
  const total = numFiles ?? filenames.length

  if (total === 0) {
    return <div className="text-[10px] font-mono text-muted-foreground/60 px-2 py-1">{emptyLabel}</div>
  }

  // Flatten with group dividers, then truncate at file count
  let shown = 0
  const visibleGroups: Array<{ dir: string; files: string[] }> = []
  for (const g of groups) {
    if (revealed || shown < limit) {
      const remaining = revealed ? g.files.length : Math.max(0, limit - shown)
      const slice = revealed ? g.files : g.files.slice(0, remaining)
      if (slice.length === 0) break
      visibleGroups.push({ dir: g.dir, files: slice })
      shown += slice.length
      if (!revealed && shown >= limit) break
    }
  }
  const hidden = total - shown

  return (
    <div className="text-[10px] font-mono">
      <div className="space-y-1.5">
        {visibleGroups.map(g => (
          <div key={g.dir || '_root'}>
            {g.dir && (
              <div className="text-purple-400/70 truncate">
                {g.dir}
                <span className="text-muted-foreground/40">/</span>
                <span className="ml-1.5 text-muted-foreground/40">({g.files.length})</span>
              </div>
            )}
            <ul className={g.dir ? 'pl-3 border-l border-border/30' : ''}>
              {g.files.map(name => {
                const dotIdx = name.lastIndexOf('.')
                const stem = dotIdx > 0 ? name.slice(0, dotIdx) : name
                const ext = dotIdx > 0 ? name.slice(dotIdx) : ''
                return (
                  <li key={name} className="hover:bg-muted/20 px-1.5 leading-tight">
                    <span className="text-foreground/85">{stem}</span>
                    {ext && <span className="text-muted-foreground/50">{ext}</span>}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
      {(hidden > 0 || truncated) && (
        <div className="mt-1 px-2 flex items-center gap-2">
          {hidden > 0 && !revealed && (
            <button
              type="button"
              onClick={() => setRevealed(true)}
              className="text-[10px] text-accent hover:text-accent/80"
            >
              +{hidden} more {hidden === 1 ? 'file' : 'files'}
            </button>
          )}
          {truncated && <span className="text-[10px] text-amber-400/70">(result truncated by Grep)</span>}
        </div>
      )}
    </div>
  )
}

// ─── Grep content mode ───────────────────────────────────────────

interface ContentMatch {
  line?: number
  text: string
}

interface ContentFileGroup {
  file: string
  matches: ContentMatch[]
}

/**
 * Parse `file:line:text` (with -n) or `file:text` lines into per-file groups.
 * Heuristic: use leading filenames from extra.filenames as anchors. If a parsed
 * file segment doesn't appear in filenames, treat as "no -n / weird format" and
 * fall back to file:text.
 */
function parseContentLines(content: string, knownFiles: string[]): ContentFileGroup[] {
  const fileSet = new Set(knownFiles)
  const groups = new Map<string, ContentMatch[]>()
  const lines = content.split('\n')

  for (const raw of lines) {
    if (!raw) continue
    // Try `file:line:text` first when known files exist
    let file = ''
    let line: number | undefined
    let text = raw

    if (fileSet.size > 0) {
      // Find longest matching prefix that ends with `:`
      // (filenames may contain `:` themselves -- rare but possible)
      let matched: string | null = null
      for (const f of fileSet) {
        if (raw.startsWith(`${f}:`) && (!matched || f.length > matched.length)) {
          matched = f
        }
      }
      if (matched) {
        file = matched
        const rest = raw.slice(matched.length + 1)
        const colonIdx = rest.indexOf(':')
        if (colonIdx > 0) {
          const possibleLine = rest.slice(0, colonIdx)
          if (/^\d+$/.test(possibleLine)) {
            line = parseInt(possibleLine, 10)
            text = rest.slice(colonIdx + 1)
          } else {
            text = rest
          }
        } else {
          text = rest
        }
      }
    }

    if (!file) {
      // Generic fallback: split first two colons
      const first = raw.indexOf(':')
      if (first > 0) {
        file = raw.slice(0, first)
        const rest = raw.slice(first + 1)
        const second = rest.indexOf(':')
        if (second > 0 && /^\d+$/.test(rest.slice(0, second))) {
          line = parseInt(rest.slice(0, second), 10)
          text = rest.slice(second + 1)
        } else {
          text = rest
        }
      } else {
        // Can't parse - put in unnamed bucket
        file = ''
        text = raw
      }
    }

    const list = groups.get(file) ?? []
    list.push({ line, text })
    groups.set(file, list)
  }

  return Array.from(groups, ([file, matches]) => ({ file, matches }))
}

export function GrepContentResults({
  content,
  filenames,
  numLines,
  numFiles,
  highlight,
}: {
  content: string
  filenames: string[]
  numLines?: number
  numFiles?: number
  highlight?: RegExp
}) {
  const root = useSessionPath()
  const limit = useToolLineLimit('Grep', CONTENT_LINE_DEFAULT_LIMIT)
  const [revealed, setRevealed] = useState(false)

  const fileGroups = useMemo(() => parseContentLines(content, filenames), [content, filenames])
  const totalLines = numLines ?? content.split('\n').filter(Boolean).length

  if (totalLines === 0 || fileGroups.length === 0) {
    return <div className="text-[10px] font-mono text-muted-foreground/60 px-2 py-1">No matches</div>
  }

  // Truncate by displayed lines, not files
  let shown = 0
  const visibleGroups: ContentFileGroup[] = []
  for (const g of fileGroups) {
    if (revealed || shown < limit) {
      const slice = revealed ? g.matches : g.matches.slice(0, Math.max(0, limit - shown))
      if (slice.length === 0) break
      visibleGroups.push({ file: g.file, matches: slice })
      shown += slice.length
      if (!revealed && shown >= limit) break
    }
  }
  const hidden = totalLines - shown

  return (
    <div className="text-[10px] font-mono space-y-2">
      {visibleGroups.map(g => {
        const rel = relToRoot(g.file, root)
        const { dir, name } = splitDirAndName(rel)
        return (
          <div key={g.file || '_unnamed'}>
            {g.file && (
              <div className="flex items-baseline gap-1.5 px-2 py-0.5 bg-purple-500/5 border-l-2 border-purple-400/40">
                {dir && <span className="text-muted-foreground/60 truncate">{dir}/</span>}
                <span className="text-purple-300/90 font-semibold">{name}</span>
                <span className="text-muted-foreground/40 text-[9px]">
                  {g.matches.length} {g.matches.length === 1 ? 'match' : 'matches'}
                </span>
              </div>
            )}
            <div className="bg-black/20 px-2 py-1">
              {g.matches.map((m, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: ordered match list, no stable id
                  key={i}
                  className="flex gap-2 hover:bg-muted/20 leading-tight"
                >
                  {m.line !== undefined && (
                    <span className="text-sky-400/60 select-none shrink-0 text-right" style={{ width: '4ch' }}>
                      {m.line}
                    </span>
                  )}
                  <span
                    className="text-foreground/80 whitespace-pre-wrap break-all min-w-0"
                    dangerouslySetInnerHTML={{ __html: highlightLine(m.text, highlight) }}
                  />
                </div>
              ))}
            </div>
          </div>
        )
      })}
      {hidden > 0 && !revealed && (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="text-[10px] text-accent hover:text-accent/80 px-2"
        >
          +{hidden} more {hidden === 1 ? 'match' : 'matches'} across {numFiles ?? fileGroups.length} files
        </button>
      )}
    </div>
  )
}

// ─── Grep count mode ─────────────────────────────────────────────

interface CountRow {
  file: string
  count: number
}

function parseCountLines(content: string): CountRow[] {
  const rows: CountRow[] = []
  for (const raw of content.split('\n')) {
    if (!raw) continue
    const idx = raw.lastIndexOf(':')
    if (idx < 0) continue
    const n = parseInt(raw.slice(idx + 1), 10)
    if (!Number.isFinite(n)) continue
    rows.push({ file: raw.slice(0, idx), count: n })
  }
  rows.sort((a, b) => b.count - a.count)
  return rows
}

export function GrepCountResults({
  content,
  numMatches,
  numFiles,
}: {
  content: string
  numMatches?: number
  numFiles?: number
}) {
  const root = useSessionPath()
  const limit = useToolLineLimit('Grep', COUNT_BAR_DEFAULT_LIMIT)
  const [revealed, setRevealed] = useState(false)

  const rows = useMemo(() => parseCountLines(content), [content])
  if (rows.length === 0) {
    const total = numMatches ?? 0
    return (
      <div className="text-[10px] font-mono text-muted-foreground/60 px-2 py-1">
        {total === 0 ? 'No matches' : `${total} ${total === 1 ? 'match' : 'matches'}`}
      </div>
    )
  }

  const max = rows[0]?.count || 1
  const visible = revealed ? rows : rows.slice(0, limit)
  const hidden = rows.length - visible.length

  return (
    <div className="text-[10px] font-mono space-y-0.5">
      {visible.map(r => {
        const rel = relToRoot(r.file, root)
        const { dir, name } = splitDirAndName(rel)
        const pct = (r.count / max) * 100
        return (
          <div
            key={r.file}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 hover:bg-muted/20 px-2 py-0.5"
          >
            <div className="min-w-0 truncate">
              {dir && <span className="text-muted-foreground/50">{dir}/</span>}
              <span className="text-foreground/85">{name}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="relative h-1.5 w-32 bg-muted/30 rounded-sm overflow-hidden">
                <div className="absolute inset-y-0 left-0 bg-purple-400/70 rounded-sm" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-purple-300/90 tabular-nums" style={{ minWidth: '3ch', textAlign: 'right' }}>
                {r.count}
              </span>
            </div>
          </div>
        )
      })}
      {(hidden > 0 || numFiles !== undefined) && (
        <div className="flex items-center gap-3 px-2 mt-1">
          {hidden > 0 && !revealed && (
            <button
              type="button"
              onClick={() => setRevealed(true)}
              className="text-[10px] text-accent hover:text-accent/80"
            >
              +{hidden} more {hidden === 1 ? 'file' : 'files'}
            </button>
          )}
          {numMatches !== undefined && (
            <span className="text-[9px] text-muted-foreground/50 ml-auto">
              {numMatches.toLocaleString()} total across {(numFiles ?? rows.length).toLocaleString()} files
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Summary helpers ─────────────────────────────────────────────

export function GrepSummary({
  pattern,
  path,
  glob,
  numFiles,
  numMatches,
  numLines,
  mode,
  isError,
}: {
  pattern: string
  path?: string
  glob?: string
  numFiles?: number
  numMatches?: number
  numLines?: number
  mode?: string
  isError?: boolean
}) {
  const root = useSessionPath()
  const relPath = path ? relToRoot(path, root) : undefined
  const totalMatches = mode === 'count' ? numMatches : numLines
  return (
    <span className="flex items-center gap-1.5 min-w-0 flex-wrap">
      <code className="px-1 py-0 rounded bg-purple-500/10 text-purple-300/90 text-[10px] font-mono break-all">
        {pattern}
      </code>
      {relPath && (
        <span className="text-muted-foreground/60 truncate">
          in <span className="text-foreground/70">{relPath}</span>
        </span>
      )}
      {glob && <span className="text-cyan-400/70 shrink-0">{glob}</span>}
      {!isError && numFiles !== undefined && (
        <span
          className={cn('shrink-0 text-[10px]', numFiles === 0 ? 'text-muted-foreground/50' : 'text-foreground/70')}
        >
          <span className={numFiles === 0 ? 'text-muted-foreground/50' : 'text-emerald-400/80 font-semibold'}>
            {numFiles}
          </span>{' '}
          {numFiles === 1 ? 'file' : 'files'}
        </span>
      )}
      {!isError && totalMatches !== undefined && totalMatches > 0 && (
        <span className="text-muted-foreground/50 shrink-0 text-[10px]">
          <span className="text-amber-400/80">{totalMatches.toLocaleString()}</span>{' '}
          {totalMatches === 1 ? 'match' : 'matches'}
        </span>
      )}
    </span>
  )
}

export function GlobSummary({
  pattern,
  path,
  numFiles,
  truncated,
  isError,
}: {
  pattern: string
  path?: string
  numFiles?: number
  truncated?: boolean
  isError?: boolean
}) {
  const root = useSessionPath()
  const relPath = path ? relToRoot(path, root) : undefined
  return (
    <span className="flex items-center gap-1.5 min-w-0 flex-wrap">
      <code className="px-1 py-0 rounded bg-purple-500/10 text-purple-300/90 text-[10px] font-mono break-all">
        {pattern}
      </code>
      {relPath && (
        <span className="text-muted-foreground/60 truncate">
          in <span className="text-foreground/70">{relPath}</span>
        </span>
      )}
      {!isError && numFiles !== undefined && (
        <span
          className={cn('shrink-0 text-[10px]', numFiles === 0 ? 'text-muted-foreground/50' : 'text-foreground/70')}
        >
          <span className={numFiles === 0 ? 'text-muted-foreground/50' : 'text-emerald-400/80 font-semibold'}>
            {numFiles}
          </span>{' '}
          {numFiles === 1 ? 'file' : 'files'}
          {truncated && <span className="text-amber-400/70 ml-1">(truncated)</span>}
        </span>
      )}
    </span>
  )
}
