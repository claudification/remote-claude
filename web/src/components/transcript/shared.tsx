/**
 * Shared utilities for transcript rendering:
 * ANSI conversion, HTML sanitization, collapsible sections, truncated output, tool styling
 */

import AnsiToHtml from 'ansi-to-html'
import type { LucideIcon } from 'lucide-react'
import {
  Bookmark,
  Bot,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleStop,
  ClipboardList,
  Clock,
  FileCode,
  FilePlus,
  FileSearch,
  FolderSearch,
  Gauge,
  Globe,
  ListTodo,
  Notebook,
  Pencil,
  Play,
  Plug,
  Route,
  ScrollText,
  Search,
  Sparkles,
  Terminal,
  Timer,
  Users,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-sessions'
import { resolveToolDisplay, type ToolDisplayKey } from '@/lib/control-panel-prefs'
import { defaultOpenApplied, expandedState } from '@/lib/expanded-state'

// ANSI to HTML converter - vibrant colors for dark backgrounds
const ansiConverter = new AnsiToHtml({
  fg: '#e0e0e0',
  bg: 'transparent',
  colors: {
    0: '#666666', // black (visible on dark bg)
    1: '#ff6b6b', // red - bright coral
    2: '#98c379', // green - soft lime
    3: '#e5c07b', // yellow - warm gold
    4: '#61afef', // blue - bright sky blue
    5: '#c678dd', // magenta - vibrant purple
    6: '#56b6c2', // cyan - teal
    7: '#abb2bf', // white - soft gray
    8: '#5c6370', // bright black
    9: '#e06c75', // bright red
    10: '#98c379', // bright green
    11: '#d19a66', // bright yellow/orange
    12: '#61afef', // bright blue
    13: '#c678dd', // bright magenta
    14: '#56b6c2', // bright cyan
    15: '#ffffff', // bright white
  },
})

// Sanitize text before ANSI conversion to prevent HTML/style/script injection.
// Tool output (especially Bash/WebFetch) can contain raw HTML that would
// bleed into the DOM via dangerouslySetInnerHTML.
function sanitizeForAnsi(text: string): string {
  return text
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function AnsiText({ text, highlight }: { text: string; highlight?: RegExp }) {
  const html = useMemo(() => {
    let result = ansiConverter.toHtml(sanitizeForAnsi(text))
    if (highlight) {
      // Apply highlight to text content only (not inside HTML tags)
      // Split on HTML tags, highlight text segments, rejoin
      result = result.replace(/([^<]+)|(<[^>]+>)/g, (match, textPart, tagPart) => {
        if (tagPart) return tagPart
        if (!textPart) return match
        return textPart.replace(highlight, '<mark class="bg-amber-400/40 text-inherit rounded-sm">$&</mark>')
      })
    }
    return result
  }, [text, highlight])
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}

export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Strip common home/project prefixes to show a useful relative-ish path
export function shortPath(fullPath: string): string {
  if (!fullPath) return fullPath
  const stripped = fullPath.replace(/^\/(?:Users|home)\/[^/]+\/(?:projects\/[^/]+\/)?/, '')
  if (stripped === fullPath && fullPath.startsWith('/')) {
    const parts = fullPath.split('/')
    return parts.length > 3 ? parts.slice(-3).join('/') : fullPath
  }
  return stripped
}

// Compute relative path from `from` to `to` (pure string, no fs)
function relativePath(from: string, to: string): string {
  const fromParts = from.replace(/\/$/, '').split('/')
  const toParts = to.replace(/\/$/, '').split('/')
  let common = 0
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++
  const ups = fromParts.length - common
  const rest = toParts.slice(common)
  return [...Array(ups).fill('..'), ...rest].join('/')
}

// Strip or shorten `cd <path> && ` prefix from a shell command for display.
// - Exact CWD match: strip entirely (it's a no-op)
// - Child/parent of CWD: replace with relative path
// - Unrelated: leave as-is
const CD_PREFIX_RE = /^cd\s+(?:(['"])(.+?)\1|(\S+))\s*(?:&&|;)\s*/
export function cleanCdPrefix(text: string, root: string): string {
  const m = text.match(CD_PREFIX_RE)
  if (!m) return text
  const cdPath = (m[2] || m[3]).replace(/\/$/, '')
  const normRoot = root.replace(/\/$/, '')
  const rest = text.slice(m[0].length)
  if (cdPath === normRoot) return rest
  const rel = relativePath(normRoot, cdPath)
  if (rel && !rel.startsWith('/') && rel.length < cdPath.length) {
    return `cd ${rel} && ${rest}`
  }
  return text
}

// Clean `sh('cd <path> && ...')` inside REPL JavaScript code
const SH_CD_RE = /sh\((['"`])(cd\s+(?:['"]?.+?['"]?\s*(?:&&|;)\s*))/g
// Strip `chdir('<path>')` / `chdir("<path>")` / `chdir(`<path>`)` lines that are no-ops
const CHDIR_LINE_RE = /^[ \t]*chdir\(\s*(['"`])(.+?)\1\s*\)\s*;?[ \t]*(\r?\n|$)/gm
export function cleanReplShCalls(code: string, root: string): string {
  const normRoot = root.replace(/\/$/, '')
  const withoutChdir = code.replace(CHDIR_LINE_RE, (full, _q, path) => {
    return path.replace(/\/$/, '') === normRoot ? '' : full
  })
  return withoutChdir.replace(SH_CD_RE, (full, quote, cdPart) => {
    const cleaned = cleanCdPrefix(cdPart, root)
    if (cleaned !== cdPart) return `sh(${quote}${cleaned}`
    return full
  })
}

// Tool-specific styling - terminal aesthetic with Lucide icons
const TOOL_STYLES: Record<string, { color: string; Icon: LucideIcon }> = {
  Bash: { color: 'text-orange-400', Icon: Terminal },
  Read: { color: 'text-cyan-400', Icon: FileCode },
  Edit: { color: 'text-yellow-400', Icon: Pencil },
  Write: { color: 'text-green-400', Icon: FilePlus },
  Glob: { color: 'text-purple-400', Icon: FolderSearch },
  Grep: { color: 'text-purple-400', Icon: FileSearch },
  NotebookEdit: { color: 'text-yellow-400', Icon: Notebook },
  WebFetch: { color: 'text-blue-400', Icon: Globe },
  WebSearch: { color: 'text-blue-400', Icon: Search },
  Agent: { color: 'text-pink-400', Icon: Bot },
  Task: { color: 'text-pink-400', Icon: Bot },
  TaskCreate: { color: 'text-emerald-400', Icon: ListTodo },
  TaskUpdate: { color: 'text-emerald-400', Icon: CircleCheck },
  TaskOutput: { color: 'text-emerald-400', Icon: ScrollText },
  TaskStop: { color: 'text-red-400', Icon: CircleStop },
  TaskList: { color: 'text-emerald-400', Icon: ClipboardList },
  TodoWrite: { color: 'text-emerald-400', Icon: ListTodo },
  AskUserQuestion: { color: 'text-amber-400', Icon: CircleHelp },
  Skill: { color: 'text-teal-400', Icon: Sparkles },
  ToolSearch: { color: 'text-teal-400', Icon: Search },
  EnterPlanMode: { color: 'text-sky-400', Icon: Route },
  ExitPlanMode: { color: 'text-sky-400', Icon: Route },
  LSP: { color: 'text-indigo-400', Icon: Zap },
  SendMessage: { color: 'text-pink-400', Icon: Users },
  TeamCreate: { color: 'text-pink-400', Icon: Users },
  TeamDelete: { color: 'text-red-400', Icon: Users },
  Bookmark: { color: 'text-amber-400', Icon: Bookmark },
  CronCreate: { color: 'text-sky-400', Icon: Clock },
  CronList: { color: 'text-sky-400', Icon: Clock },
  CronDelete: { color: 'text-red-400', Icon: Clock },
  ScheduleWakeup: { color: 'text-amber-400', Icon: Timer },
  Monitor: { color: 'text-violet-400', Icon: Gauge },
  REPL: { color: 'text-indigo-400', Icon: Braces },
}

const DEFAULT_TOOL_STYLE = { color: 'text-event-tool', Icon: Play }
const MCP_TOOL_STYLE = { color: 'text-teal-400', Icon: Plug }

export function getToolStyle(name: string) {
  return TOOL_STYLES[name] || (name.startsWith('mcp__') ? MCP_TOOL_STYLE : DEFAULT_TOOL_STYLE)
}

// Collapsible section with persistent expanded state across virtualizer remounts
export function Collapsible({
  id,
  label,
  defaultOpen = false,
  expandAll: expandAllProp,
  onExpand,
  children,
}: {
  id?: string
  label: string
  defaultOpen?: boolean
  expandAll?: boolean
  onExpand?: () => void
  children: React.ReactNode
}) {
  if (id && defaultOpen && !defaultOpenApplied.has(id)) {
    defaultOpenApplied.add(id)
    expandedState.add(id)
  }

  const expandAllStore = useConversationsStore(state => state.expandAll)
  const expandAll = expandAllProp ?? expandAllStore
  const [open, setOpen] = useState(() => (id ? expandedState.has(id) : defaultOpen))

  const isOpen = expandAll || open

  // biome-ignore lint/correctness/useExhaustiveDependencies: onExpand and open intentionally omitted - only fire callback when expandAll toggles on, not on every re-render
  useEffect(() => {
    if (expandAll && !open && onExpand) onExpand()
  }, [expandAll]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggle() {
    const next = !isOpen
    setOpen(next)
    if (id) {
      if (next) expandedState.add(id)
      else expandedState.delete(id)
    }
    if (expandAll && !next) {
      useConversationsStore.getState().toggleExpandAll()
    }
    if (next && onExpand) onExpand()
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground text-[10px] font-mono"
      >
        {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {label}
      </button>
      {isOpen && <div className="mt-1 ml-4 min-w-0 overflow-hidden">{children}</div>}
    </div>
  )
}

// Truncated output - caps visible lines with a "more" button.
// Line limit is configurable per-tool via Settings > Display.
// Also truncates individual lines longer than MAX_LINE_CHARS to prevent
// a few massive lines from dominating the output area.
const MAX_LINE_CHARS = 500

function capLineLength(line: string, max: number): { text: string; truncated: boolean } {
  if (line.length <= max) return { text: line, truncated: false }
  return { text: `${line.slice(0, max)} ...`, truncated: true }
}

export function TruncatedPre({ text, tool, highlight }: { text: string; tool?: ToolDisplayKey; highlight?: RegExp }) {
  const [revealed, setRevealed] = useState(false)
  const limit = useConversationsStore(s => (tool ? resolveToolDisplay(s.controlPanelPrefs, tool).lineLimit : 10))
  const safeText = typeof text === 'string' ? text : String(text ?? '')
  const lines = safeText.split('\n')
  const needsLineTruncation = limit > 0 && lines.length > limit && !revealed
  const visibleLines = needsLineTruncation ? lines.slice(0, limit) : lines

  // Cap individual line lengths (even when fully revealed)
  let linesWereCapped = false
  const cappedLines = revealed
    ? lines // fully revealed = show everything unmodified
    : visibleLines.map(line => {
        const result = capLineLength(line, MAX_LINE_CHARS)
        if (result.truncated) linesWereCapped = true
        return result.text
      })
  const displayText = cappedLines.join('\n')

  return (
    <div>
      <pre className="text-[10px] bg-black/30 p-2 whitespace-pre-wrap break-words overflow-x-auto font-mono">
        <AnsiText text={displayText} highlight={highlight} />
      </pre>
      {(needsLineTruncation || linesWereCapped) && !revealed && (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="text-[10px] text-accent hover:text-accent/80 font-mono mt-0.5 px-2"
        >
          {needsLineTruncation ? `+${lines.length - limit} more lines` : 'show full lines'}
        </button>
      )}
    </div>
  )
}
