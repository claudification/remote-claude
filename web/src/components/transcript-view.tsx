import { useVirtualizer } from '@tanstack/react-virtual'
import AnsiToHtml from 'ansi-to-html'
import type { LucideIcon } from 'lucide-react'
import {
  Bookmark,
  Bot,
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
  Users,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchSubagentTranscript, useSessionsStore } from '@/hooks/use-sessions'
import type { TranscriptContentBlock, TranscriptEntry } from '@/lib/types'
import { cn, truncate } from '@/lib/utils'
import { JsonInspector } from './json-inspector'
import { Markdown } from './markdown'

// ANSI to HTML converter - vibrant colors for dark backgrounds
const ansiConverter = new AnsiToHtml({
  fg: '#e0e0e0',
  bg: 'transparent',
  colors: {
    0: '#666666', // black (visible on dark bg)
    1: '#ff6b6b', // red - bright coral
    2: '#98c379', // green - soft lime
    3: '#e5c07b', // yellow - warm gold
    4: '#61afef', // blue - bright sky blue (was too dark)
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

export function AnsiText({ text }: { text: string }) {
  const html = useMemo(() => ansiConverter.toHtml(text), [text])
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}

// Tool-specific styling - terminal aesthetic with Lucide icons
const TOOL_STYLES: Record<string, { color: string; Icon: LucideIcon }> = {
  // File operations
  Bash: { color: 'text-orange-400', Icon: Terminal },
  Read: { color: 'text-cyan-400', Icon: FileCode },
  Edit: { color: 'text-yellow-400', Icon: Pencil },
  Write: { color: 'text-green-400', Icon: FilePlus },
  Glob: { color: 'text-purple-400', Icon: FolderSearch },
  Grep: { color: 'text-purple-400', Icon: FileSearch },
  NotebookEdit: { color: 'text-yellow-400', Icon: Notebook },
  // Web
  WebFetch: { color: 'text-blue-400', Icon: Globe },
  WebSearch: { color: 'text-blue-400', Icon: Search },
  // Agents & tasks
  Agent: { color: 'text-pink-400', Icon: Bot },
  Task: { color: 'text-pink-400', Icon: Bot },
  TaskCreate: { color: 'text-emerald-400', Icon: ListTodo },
  TaskUpdate: { color: 'text-emerald-400', Icon: CircleCheck },
  TaskOutput: { color: 'text-emerald-400', Icon: ScrollText },
  TaskStop: { color: 'text-red-400', Icon: CircleStop },
  TaskList: { color: 'text-emerald-400', Icon: ClipboardList },
  TodoWrite: { color: 'text-emerald-400', Icon: ListTodo },
  // Interactive
  AskUserQuestion: { color: 'text-amber-400', Icon: CircleHelp },
  Skill: { color: 'text-teal-400', Icon: Sparkles },
  ToolSearch: { color: 'text-teal-400', Icon: Search },
  // Planning
  EnterPlanMode: { color: 'text-sky-400', Icon: Route },
  ExitPlanMode: { color: 'text-sky-400', Icon: Route },
  // System
  LSP: { color: 'text-indigo-400', Icon: Zap },
  SendMessage: { color: 'text-pink-400', Icon: Users },
  TeamCreate: { color: 'text-pink-400', Icon: Users },
  TeamDelete: { color: 'text-red-400', Icon: Users },
  // Bookmarks
  Bookmark: { color: 'text-amber-400', Icon: Bookmark },
  // Cron
  CronCreate: { color: 'text-sky-400', Icon: Clock },
  CronList: { color: 'text-sky-400', Icon: Clock },
  CronDelete: { color: 'text-red-400', Icon: Clock },
}

const DEFAULT_TOOL_STYLE = { color: 'text-event-tool', Icon: Play }
const MCP_TOOL_STYLE = { color: 'text-teal-400', Icon: Plug }

function getToolStyle(name: string) {
  return TOOL_STYLES[name] || (name.startsWith('mcp__') ? MCP_TOOL_STYLE : DEFAULT_TOOL_STYLE)
}

// Module-level state that survives virtualizer unmount/remount cycles
const expandedState = new Set<string>()
const defaultOpenApplied = new Set<string>()

function Collapsible({
  id,
  label,
  defaultOpen = false,
  onExpand,
  children,
}: {
  id?: string
  label: string
  defaultOpen?: boolean
  onExpand?: () => void
  children: React.ReactNode
}) {
  // Apply defaultOpen only once per unique id (not on every remount)
  if (id && defaultOpen && !defaultOpenApplied.has(id)) {
    defaultOpenApplied.add(id)
    expandedState.add(id)
  }

  const expandAll = useSessionsStore(state => state.expandAll)
  const [open, setOpen] = useState(() => (id ? expandedState.has(id) : defaultOpen))

  // Expand all override
  const isOpen = expandAll || open

  // Fire onExpand when expandAll opens a previously closed collapsible
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
    // If expand-all is on and user manually collapses, turn off expand-all
    if (expandAll && !next) {
      useSessionsStore.getState().toggleExpandAll()
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
      {isOpen && <div className="mt-1 ml-4">{children}</div>}
    </div>
  )
}

// Syntax-highlighted diff view for Edit operations
// Uses Shiki (lazy-loaded) to highlight code, with diff line backgrounds overlaid

import { useState as useSyntaxState } from 'react'

// Lazy singleton highlighter
let highlighterPromise: Promise<any> | null = null

const EAGER_LANGS = [
  'javascript',
  'typescript',
  'tsx',
  'jsx',
  'shellscript',
  'html',
  'astro',
  'css',
  'json',
  'yaml',
  'markdown',
]

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki/bundle/web').then(m =>
      m.createHighlighter({
        themes: ['tokyo-night'],
        langs: EAGER_LANGS,
      }),
    )
  }
  return highlighterPromise
}

// Lazy-load a language into the highlighter if not already loaded
async function ensureLang(lang: string): Promise<boolean> {
  const hl = await getHighlighter()
  const loaded = hl.getLoadedLanguages() as string[]
  if (loaded.includes(lang)) return true
  try {
    const mod = await import('shiki/bundle/web')
    const available = mod.bundledLanguagesInfo.map((l: any) => l.id)
    if (!available.includes(lang)) return false
    await hl.loadLanguage(lang)
    return true
  } catch {
    return false
  }
}

// File extension -> shiki language id
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sass: 'sass',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'mdx',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  php: 'php',
  r: 'r',
  coffee: 'coffee',
  pug: 'pug',
  hbs: 'handlebars',
}

function langFromPath(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext ? EXT_TO_LANG[ext] : undefined
}

function DiffView({ patches, filePath }: { patches: Array<{ oldStart: number; lines: string[] }>; filePath?: string }) {
  const [highlighted, setHighlighted] = useSyntaxState<Map<string, string> | null>(null)

  useEffect(() => {
    const lang = filePath ? langFromPath(filePath) : undefined
    if (!lang) return

    // Collect all code lines (strip diff prefix) for batch highlighting
    const codeLines: string[] = []
    for (const patch of patches) {
      for (const line of patch.lines) {
        // Strip diff prefix (+/-/space) to get actual code
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
          tokens.tokens.forEach((lineTokens: any[], idx: number) => {
            const html = lineTokens
              .map((t: any) => `<span style="color:${t.color}">${escapeHtml(t.content)}</span>`)
              .join('')
            lineMap.set(codeLines[idx], html)
          })
        } catch {
          // Highlighting failed - fall back to plain
        }
        setHighlighted(lineMap)
      })
      .catch(() => {})
  }, [patches, filePath])

  return (
    <pre className="text-[10px] font-mono overflow-x-auto">
      {patches.map((patch, i) => (
        <div key={i}>
          <div className="text-muted-foreground">@@ {patch.oldStart} @@</div>
          {patch.lines.map((line, j) => {
            const prefix = line[0] || ' '
            const content = line.slice(1)
            const syntaxHtml = highlighted?.get(content)
            return (
              <div key={j} className={cn(prefix === '+' && 'bg-green-500/10', prefix === '-' && 'bg-red-500/10')}>
                <span
                  className={cn(
                    prefix === '+' && 'text-green-400',
                    prefix === '-' && 'text-red-400',
                    prefix !== '+' && prefix !== '-' && 'text-muted-foreground',
                  )}
                >
                  {prefix}
                </span>
                {syntaxHtml ? (
                  <span dangerouslySetInnerHTML={{ __html: syntaxHtml }} />
                ) : (
                  <span
                    className={cn(
                      prefix === '+' && 'text-green-400',
                      prefix === '-' && 'text-red-400',
                      prefix !== '+' && prefix !== '-' && 'text-muted-foreground',
                    )}
                  >
                    {content}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </pre>
  )
}

// Syntax-highlighted shell command block
function ShellCommand({ command }: { command: string }) {
  const [html, setHtml] = useSyntaxState<string | null>(null)

  useEffect(() => {
    getHighlighter()
      .then(highlighter => {
        try {
          const tokens = highlighter.codeToTokens(command, { lang: 'shellscript', theme: 'tokyo-night' })
          const highlighted = tokens.tokens
            .map((lineTokens: any[]) =>
              lineTokens.map((t: any) => `<span style="color:${t.color}">${escapeHtml(t.content)}</span>`).join(''),
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
function WritePreview({ content, filePath }: { content: string; filePath?: string }) {
  const [html, setHtml] = useSyntaxState<string | null>(null)
  const truncated = content.length > 3000 ? content.slice(0, 3000) : content
  const lines = truncated.split('\n')

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
            .map((lineTokens: any[]) =>
              lineTokens.map((t: any) => `<span style="color:${t.color}">${escapeHtml(t.content)}</span>`).join(''),
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

  return (
    <pre className="text-[10px] font-mono max-h-48 overflow-auto">
      {html ? (
        <code>
          {html.split('\n').map((lineHtml, i) => (
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
          {lines.map((line, i) => (
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
      {content.length > 3000 && (
        <div className="text-muted-foreground mt-1">... +{content.length - 3000} chars truncated</div>
      )}
    </pre>
  )
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Strip common home/project prefixes to show a useful relative-ish path
// /Users/jonas/projects/remote-claude/src/foo.ts -> src/foo.ts
// /home/user/app/lib/bar.ts -> lib/bar.ts
function shortPath(fullPath: string): string {
  if (!fullPath) return fullPath
  // Strip /Users/*/projects/*/ or /home/*/ prefixes
  const stripped = fullPath.replace(/^\/(?:Users|home)\/[^/]+\/(?:projects\/[^/]+\/)?/, '')
  // If nothing was stripped (different pattern), show last 3 segments
  if (stripped === fullPath && fullPath.startsWith('/')) {
    const parts = fullPath.split('/')
    return parts.length > 3 ? parts.slice(-3).join('/') : fullPath
  }
  return stripped
}

// Compact tool display - one line summary with expandable details
function ToolLine({
  tool,
  result,
  toolUseResult,
  subagents,
}: {
  tool: TranscriptContentBlock
  result?: string
  toolUseResult?: Record<string, unknown>
  subagents?: Array<{
    agentId: string
    agentType: string
    description?: string
    status: 'running' | 'stopped'
    startedAt: number
    stoppedAt?: number
    eventCount: number
  }>
}) {
  const name = tool.name || 'Tool'
  const input = tool.input || {}
  const style = getToolStyle(name)
  const expandAll = useSessionsStore(state => state.expandAll)

  // Build one-line summary based on tool type
  let summary = ''
  let details: React.ReactNode = null
  let agentBadge: React.ReactNode = null
  let matchedAgentId: string | null = null

  switch (name) {
    case 'Bash': {
      const cmd = input.command as string
      summary = cmd?.length > 80 && !expandAll ? `${cmd.slice(0, 80)}...` : cmd
      if (result) {
        const outputText = expandAll ? result : truncate(result, 1500)
        details = (
          <div className="space-y-1">
            {expandAll && cmd && <ShellCommand command={cmd} />}
            <pre
              className={cn(
                'text-[10px] bg-black/30 p-2 overflow-auto whitespace-pre-wrap font-mono',
                expandAll ? 'max-h-[80vh]' : 'max-h-32',
              )}
            >
              <AnsiText text={outputText} />
            </pre>
          </div>
        )
      } else if (expandAll && cmd) {
        details = <ShellCommand command={cmd} />
      }
      break
    }
    case 'Read': {
      const path = input.file_path as string
      summary = shortPath(path) || path
      break
    }
    case 'Edit': {
      const path = input.file_path as string
      summary = shortPath(path) || path
      const patches = (toolUseResult as any)?.structuredPatch
      if (patches?.length) {
        details = <DiffView patches={patches} filePath={path} />
      }
      break
    }
    case 'Write': {
      const path = input.file_path as string
      const content = input.content as string
      summary = `${shortPath(path)} (${content?.length || 0} chars)`
      if (content) {
        details = <WritePreview content={content} filePath={path} />
      }
      break
    }
    case 'WebSearch': {
      const query = input.query as string
      summary = query
      if (result) {
        details = (
          <pre className="text-[10px] text-muted-foreground max-h-32 overflow-auto whitespace-pre-wrap">
            {truncate(result, 1500)}
          </pre>
        )
      }
      break
    }
    case 'WebFetch': {
      const url = input.url as string
      try {
        const parsed = new URL(url)
        summary = parsed.hostname + parsed.pathname
      } catch {
        summary = url
      }
      if (result) {
        details = (
          <pre className="text-[10px] text-muted-foreground max-h-32 overflow-auto whitespace-pre-wrap">
            {truncate(result, 1500)}
          </pre>
        )
      }
      break
    }
    case 'Glob':
    case 'Grep': {
      const pattern = input.pattern as string
      summary = pattern
      if (result) {
        const lines = result.split('\n').filter(Boolean)
        details = (
          <pre className="text-[10px] text-muted-foreground max-h-24 overflow-auto">
            {lines.slice(0, 20).join('\n')}
            {lines.length > 20 && `\n... +${lines.length - 20} more`}
          </pre>
        )
      }
      break
    }
    case 'Task':
    case 'Agent': {
      const desc = input.description as string
      const agentType = input.subagent_type as string
      const prompt = input.prompt as string
      summary = agentType ? `${agentType}: ${desc}` : desc
      if (prompt) {
        details = (
          <pre className="text-[10px] text-muted-foreground max-h-32 overflow-auto whitespace-pre-wrap">
            {truncate(prompt, 2000)}
          </pre>
        )
      }
      // Look up live agent status from store
      if (name === 'Agent') {
        const subagent = subagents?.find(a => a.description === desc)
        if (subagent) {
          matchedAgentId = subagent.agentId
          const isRunning = subagent.status === 'running'
          const elapsed = subagent.stoppedAt
            ? Math.round((subagent.stoppedAt - subagent.startedAt) / 1000)
            : Math.round((Date.now() - subagent.startedAt) / 1000)
          const agentIdForNav = subagent.agentId
          agentBadge = (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                const store = useSessionsStore.getState()
                store.selectSubagent(agentIdForNav)
                if (store.selectedSessionId) {
                  store.openTab(store.selectedSessionId, 'transcript')
                }
              }}
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold cursor-pointer hover:brightness-125 transition-all',
                isRunning ? 'bg-active/20 text-active animate-pulse' : 'bg-emerald-500/20 text-emerald-400',
              )}
              title="View agent transcript"
            >
              {isRunning ? 'running' : 'done'}
              {subagent.eventCount > 0 && (
                <span className="text-muted-foreground font-normal">{subagent.eventCount} events</span>
              )}
              <span className="text-muted-foreground font-normal">{elapsed}s</span>
            </button>
          )
        }
      }
      break
    }
    case 'AskUserQuestion': {
      const questions = input.questions as Array<{
        question: string
        header?: string
        options?: Array<{ label: string }>
      }>
      if (questions?.length) {
        const q0 = questions[0].question
        summary = q0.length > 60 ? `${q0.slice(0, 60)}...` : q0
        details = (
          <div className="text-[10px] font-mono space-y-1 mt-1">
            {questions.map((q, qi) => (
              <div key={qi}>
                {q.header && <span className="text-amber-400/70">[{q.header}] </span>}
                <span className="text-foreground/80">{q.question}</span>
                {q.options && (
                  <div className="ml-2 text-muted-foreground">
                    {q.options.map((o, oi) => (
                      <div key={oi} className="text-amber-400/50">
                        {'>'} {o.label}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      }
      break
    }
    case 'ToolSearch': {
      const query = input.query as string
      summary = query
      break
    }
    case 'TaskCreate': {
      const desc = input.description as string
      summary = desc?.length > 60 ? `${desc.slice(0, 60)}...` : desc
      break
    }
    case 'TaskUpdate': {
      const taskId = (input.taskId || input.id || input.task_id) as string | undefined
      const status = (input.status || input.state) as string | undefined
      const parts: string[] = []
      if (taskId) parts.push(`#${taskId}`)
      if (status) parts.push(status)
      if (input.addBlockedBy) parts.push('blockedBy')
      if (input.description) parts.push(String(input.description).slice(0, 50))
      summary = parts.join(' ') || 'update'
      break
    }
    case 'TaskOutput':
    case 'TaskList':
    case 'TaskStop': {
      const taskId = (input.taskId || input.id || input.task_id) as string
      summary = taskId ? `#${taskId}` : ''
      if (result) {
        details = (
          <pre className="text-[10px] text-muted-foreground max-h-24 overflow-auto">{truncate(result, 500)}</pre>
        )
      }
      break
    }
    case 'TodoWrite': {
      const todos = input.todos as Array<{ content: string; status?: string }>
      if (todos?.length) {
        summary = `${todos.length} item${todos.length !== 1 ? 's' : ''}`
        details = (
          <div className="text-[10px] font-mono text-muted-foreground">
            {todos.slice(0, 10).map((t, i) => (
              <div key={i}>
                <span className={t.status === 'completed' ? 'text-green-400' : 'text-foreground/60'}>
                  {t.status === 'completed' ? '[x]' : '[ ]'}
                </span>{' '}
                {t.content}
              </div>
            ))}
            {todos.length > 10 && <div>... +{todos.length - 10} more</div>}
          </div>
        )
      }
      break
    }
    case 'Skill': {
      const skill = input.skill as string
      const args = input.args as string
      summary = args ? `${skill} ${args}` : skill
      break
    }
    case 'EnterPlanMode':
      summary = 'entering plan mode'
      break
    case 'ExitPlanMode':
      summary = 'exiting plan mode'
      break
    case 'NotebookEdit': {
      const cellId = input.cell_id as string
      summary = cellId ? `cell ${cellId}` : 'edit'
      break
    }
    case 'SendMessage': {
      const msg = input.message as string
      summary = msg?.length > 60 ? `${msg.slice(0, 60)}...` : msg
      break
    }
    case 'TeamCreate':
    case 'TeamDelete': {
      const teamName = input.name as string
      summary = teamName || ''
      break
    }
    case 'CronCreate': {
      const cronExpr = input.cron as string
      const prompt = input.prompt as string
      const recurring = input.recurring as boolean
      summary = `${cronExpr}${recurring ? ' (recurring)' : ''}`
      if (prompt) {
        details = (
          <pre className="text-[10px] text-muted-foreground max-h-24 overflow-auto whitespace-pre-wrap">
            {truncate(prompt, 500)}
          </pre>
        )
      }
      break
    }
    case 'CronList': {
      const extra = toolUseResult as Record<string, unknown> | undefined
      const jobs = extra?.jobs as
        | Array<{ id: string; humanSchedule: string; prompt: string; recurring: boolean }>
        | undefined
      if (jobs?.length) {
        summary = `${jobs.length} job${jobs.length !== 1 ? 's' : ''}`
        details = (
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
      } else {
        summary = 'no jobs'
      }
      break
    }
    case 'CronDelete': {
      const jobId = input.id as string
      summary = jobId ? `delete ${jobId.slice(0, 8)}` : 'delete'
      break
    }
    default: {
      // MCP tools (mcp__server__tool) - show tool name cleanly
      if (name.startsWith('mcp__')) {
        const parts = name.split('__')
        const server = parts[1] || ''
        const tool = parts.slice(2).join('__') || ''
        summary = `${server}/${tool}`
      } else {
        summary = JSON.stringify(input).slice(0, 60)
      }
    }
  }

  const { Icon } = style
  // Clean display name: strip mcp__ prefix, shorten long names
  const displayName = name.startsWith('mcp__')
    ? name.split('__').slice(2).join('/') || name.split('__')[1] || name
    : name

  return (
    <div className="font-mono text-xs">
      <div className="flex items-center gap-2">
        <span className={cn('shrink-0 flex items-center gap-1', style.color)} title={name}>
          <Icon className="w-3 h-3 shrink-0" />
          <span className="truncate max-w-[120px]">{displayName}</span>
        </span>
        <span className="text-foreground/80 truncate flex-1">{summary}</span>
        {agentBadge}
        <JsonInspector title={name} data={input} result={result} extra={toolUseResult} />
      </div>
      {details && (
        <Collapsible
          id={tool.id ? `tool-${tool.id}` : undefined}
          label="output"
          defaultOpen={name === 'Edit' || name === 'Write' || (name === 'Bash' && expandAll)}
        >
          {details}
        </Collapsible>
      )}
      {matchedAgentId && <AgentTranscriptInline agentId={matchedAgentId} toolId={tool.id} />}
    </div>
  )
}

// Inline expandable agent transcript - live via store subscription + HTTP seed
function AgentTranscriptInline({ agentId, toolId }: { agentId: string; toolId?: string }) {
  const sessionId = useSessionsStore(state => state.selectedSessionId)
  const storeKey = sessionId ? `${sessionId}:${agentId}` : ''
  const liveEntries = useSessionsStore(state => (storeKey ? state.subagentTranscripts[storeKey] : undefined))
  const [fetched, setFetched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const collapsibleId = toolId ? `agent-transcript-${toolId}` : `agent-transcript-${agentId}`

  function handleExpand() {
    if (fetched || loading || !sessionId) return
    setLoading(true)
    fetchSubagentTranscript(sessionId, agentId)
      .then(data => {
        setFetched(true)
        setLoading(false)
        if (data.length > 0) {
          // Seed into store so WS updates merge cleanly
          const key = `${sessionId}:${agentId}`
          useSessionsStore.setState(state => ({
            subagentTranscripts: { ...state.subagentTranscripts, [key]: data },
          }))
        }
      })
      .catch(err => {
        setError(err.message || 'Failed to fetch')
        setLoading(false)
      })
  }

  const entries = liveEntries || null

  return (
    <Collapsible id={collapsibleId} label="agent transcript" onExpand={handleExpand}>
      {loading && <div className="text-[10px] text-muted-foreground animate-pulse">loading transcript...</div>}
      {error && <div className="text-[10px] text-red-400">Error: {error}</div>}
      {entries && entries.length === 0 && (
        <div className="text-[10px] text-muted-foreground">No transcript entries</div>
      )}
      {entries && entries.length > 0 && <AgentTranscriptEntries entries={entries} />}
    </Collapsible>
  )
}

// Render agent transcript entries in a compact format
function AgentTranscriptEntries({ entries }: { entries: TranscriptEntry[] }) {
  const resultMap = useMemo(() => buildResultMap(entries), [entries])
  const groups = useMemo(() => groupEntries(entries), [entries])

  return (
    <div className="space-y-2 border-l-2 border-pink-400/30 pl-3">
      {groups.map((group, i) => (
        <AgentGroupView key={i} group={group} resultMap={resultMap} />
      ))}
    </div>
  )
}

// Simplified group view for agent transcripts (no virtualizer needed)
function AgentGroupView({
  group,
  resultMap,
}: {
  group: DisplayGroup
  resultMap: Map<string, { result: string; extra?: Record<string, unknown> }>
}) {
  const expandAll = useSessionsStore(state => state.expandAll)

  if (group.type === 'system') return null

  const isUser = group.type === 'user'

  type AgentItem =
    | { kind: 'text'; text: string }
    | { kind: 'thinking'; text: string }
    | { kind: 'tool'; tool: TranscriptContentBlock; result?: string; extra?: Record<string, unknown> }

  const content: AgentItem[] = []
  for (const entry of group.entries) {
    const c = entry.message?.content
    if (typeof c === 'string') {
      if (c.trim()) content.push({ kind: 'text', text: c })
    } else if (Array.isArray(c)) {
      for (const block of c) {
        if (block.type === 'text' && block.text?.trim()) {
          content.push({ kind: 'text', text: block.text })
        } else if (block.type === 'thinking' && (block.thinking || block.text)) {
          content.push({ kind: 'thinking', text: block.thinking || block.text || '' })
        } else if (block.type === 'tool_use') {
          const res = block.id ? resultMap.get(block.id) : undefined
          content.push({ kind: 'tool', tool: block, result: res?.result, extra: res?.extra })
        }
      }
    }
  }

  if (content.length === 0) return null

  const globalSettings = useSessionsStore(state => state.globalSettings)
  const userTag = (globalSettings.userLabel as string)?.trim() || 'USER'
  const agentTag = (globalSettings.agentLabel as string)?.trim() || 'AGENT'
  const label = isUser ? userTag : agentTag
  const customColor = isUser ? (globalSettings.userColor as string)?.trim() : (globalSettings.agentColor as string)?.trim()
  const labelColor = customColor || (isUser ? 'text-event-prompt' : 'text-pink-400')
  const sizeKey = (isUser ? (globalSettings.userSize as string) : (globalSettings.agentSize as string)) || ''
  const sizeClass = { xs: 'text-[7px]', sm: 'text-[8px]', '': 'text-[9px]', lg: 'text-[11px]', xl: 'text-[13px]' }[sizeKey] || 'text-[9px]'

  return (
    <div className="text-xs">
      <span
        className={cn(sizeClass, 'font-bold uppercase', !customColor && labelColor)}
        style={customColor ? { color: customColor } : undefined}
      >
        {label}
      </span>
      <div className="pl-2 space-y-1">
        {content.map((item, i) => {
          if (item.kind === 'thinking') {
            if (!expandAll) return null
            return (
              <div key={i} className="border-l-2 border-purple-400/40 pl-2 py-1">
                <div className="text-[10px] text-purple-400/70 uppercase font-bold tracking-wider mb-1">thinking</div>
                <div className="text-[11px] opacity-75">
                  <Markdown>{item.text}</Markdown>
                </div>
              </div>
            )
          }
          if (item.kind === 'text') {
            return (
              <div key={i} className="text-[11px]">
                <Markdown>{item.text}</Markdown>
              </div>
            )
          }
          if (item.kind === 'tool') {
            return <ToolLine key={i} tool={item.tool} result={item.result} toolUseResult={item.extra} />
          }
          return null
        })}
      </div>
    </div>
  )
}

// Build map of tool_use_id -> result
function buildResultMap(entries: TranscriptEntry[]) {
  const map = new Map<string, { result: string; extra?: Record<string, unknown> }>()
  for (const entry of entries) {
    if (entry.type !== 'user') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        map.set(block.tool_use_id, {
          result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          extra: entry.toolUseResult,
        })
      }
    }
  }
  return map
}

// Parse <task-notification> XML into structured data using DOMParser
interface TaskNotification {
  taskId: string
  summary: string
  status: 'completed' | 'failed' | string
  result?: string
}

function parseTaskNotifications(text: string): TaskNotification[] {
  const results: TaskNotification[] = []
  // Extract each <task-notification>...</task-notification> block (may not be properly closed)
  const blockRegex = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const xml = `<root>${blockMatch[1]}</root>`
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml')
      const taskId = doc.querySelector('task-id')?.textContent?.trim() || ''
      const status = doc.querySelector('status')?.textContent?.trim() || ''
      const summary = doc.querySelector('summary')?.textContent?.trim() || ''
      const result = doc.querySelector('result')?.textContent?.trim() || undefined
      if (taskId || summary) {
        results.push({ taskId, status, summary, result })
      }
    } catch {
      // Malformed XML - skip
    }
  }
  return results
}

// Group consecutive assistant entries (they often have multiple tool calls)
interface DisplayGroup {
  type: 'user' | 'assistant' | 'system' | 'compacting' | 'compacted'
  timestamp: string
  entries: TranscriptEntry[]
  notifications?: TaskNotification[]
}

function groupEntries(entries: TranscriptEntry[]): DisplayGroup[] {
  const groups: DisplayGroup[] = []
  let current: DisplayGroup | null = null

  for (const entry of entries) {
    // Compaction markers - break group chain and insert as-is
    if (entry.type === 'compacting' || entry.type === 'compacted') {
      current = null
      groups.push({
        type: entry.type as 'compacting' | 'compacted',
        timestamp: entry.timestamp || '',
        entries: [entry],
      })
      continue
    }

    // Only process user and assistant entries
    if (entry.type !== 'user' && entry.type !== 'assistant') continue

    const content = entry.message?.content
    if (!content) continue

    // Skip user entries that are tool_result containers (rendered with tool_use)
    // This includes mixed entries with tool_result + text (e.g. background task notifications)
    if (entry.type === 'user' && Array.isArray(content)) {
      if (content.some(c => c.type === 'tool_result')) continue
    }

    // Skip empty string content
    if (typeof content === 'string' && !content.trim()) continue

    // Convert task-notification messages into system groups, skip system-reminders
    if (entry.type === 'user') {
      const textContent =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join('')
            : ''
      if (textContent.includes('<system-reminder>')) continue
      // Skip /slash command XML (e.g. /compact, /help) - raw XML noise
      // The actual effect (compacting/compacted) is captured as its own entry type
      if (textContent.includes('<command-name>') || textContent.includes('<local-command-caveat>') || textContent.includes('<local-command-stdout>')) continue
      if (textContent.includes('<task-notification>')) {
        const notifications = parseTaskNotifications(textContent)
        if (notifications.length > 0) {
          // Break current group chain and insert system group
          current = null
          groups.push({
            type: 'system',
            timestamp: entry.timestamp || '',
            entries: [entry],
            notifications,
          })
          continue
        }
      }
    }

    // Skip arrays with no displayable content
    if (Array.isArray(content)) {
      const hasContent = content.some(
        c =>
          (c.type === 'text' && c.text?.trim()) ||
          (c.type === 'thinking' && (c.thinking?.trim() || c.text?.trim())) ||
          c.type === 'tool_use',
      )
      if (!hasContent) continue
    }

    const type = entry.type as 'user' | 'assistant'
    if (current && current.type === type) {
      current.entries.push(entry)
    } else {
      current = { type, timestamp: entry.timestamp || '', entries: [entry] }
      groups.push(current)
    }
  }

  return groups
}

function TaskNotificationLine({ notification: n, time }: { notification: TaskNotification; time: string }) {
  const [expanded, setExpanded] = useState(false)
  const isCompleted = n.status === 'completed'

  return (
    <div>
      <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
        <span className="text-[10px]">{time}</span>
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', isCompleted ? 'bg-emerald-400' : 'bg-red-400')} />
        <span className="truncate flex-1">{n.summary}</span>
        {n.result && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className={cn(
              'w-4 h-4 shrink-0 flex items-center justify-center rounded-full border text-[9px] font-bold transition-colors',
              expanded
                ? 'border-accent text-accent bg-accent/10'
                : 'border-muted-foreground/40 text-muted-foreground/60 hover:border-accent hover:text-accent',
            )}
            title="Show result"
          >
            i
          </button>
        )}
      </div>
      {expanded && n.result && (
        <pre className="text-[10px] font-mono text-foreground/70 mt-1 ml-6 pl-2 border-l border-muted-foreground/20 max-h-32 overflow-auto whitespace-pre-wrap">
          {n.result}
        </pre>
      )}
    </div>
  )
}

function GroupView({
  group,
  resultMap,
  showThinking = false,
}: {
  group: DisplayGroup
  resultMap: Map<string, { result: string; extra?: Record<string, unknown> }>
  showThinking?: boolean
}) {
  const subagents = useSessionsStore(state => {
    const session = state.sessions.find(s => s.id === state.selectedSessionId)
    return session?.subagents
  })
  const expandAll = useSessionsStore(state => state.expandAll)
  const time = group.timestamp ? new Date(group.timestamp).toLocaleTimeString('en-US', { hour12: false }) : ''

  // System groups: compact notification badges with expandable result
  if (group.type === 'system' && group.notifications?.length) {
    return (
      <div className="mb-2 space-y-1">
        {group.notifications.map((n, i) => (
          <TaskNotificationLine key={i} notification={n} time={time} />
        ))}
      </div>
    )
  }

  const isUser = group.type === 'user'

  // Build ordered list of renderable items preserving chronological order
  type RenderItem =
    | { kind: 'text'; text: string }
    | { kind: 'thinking'; text: string }
    | { kind: 'tool'; tool: TranscriptContentBlock; result?: string; extra?: Record<string, unknown> }
    | { kind: 'images'; images: Array<{ hash: string; ext: string; url: string; originalPath: string }> }

  const items: RenderItem[] = []

  for (const entry of group.entries) {
    if (entry.images?.length) {
      items.push({ kind: 'images', images: entry.images })
    }

    const content = entry.message?.content
    if (typeof content === 'string') {
      if (content.trim()) items.push({ kind: 'text', text: content })
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const text = typeof block.text === 'string' ? block.text : JSON.stringify(block.text)
          if (text.trim()) items.push({ kind: 'text', text })
        } else if (block.type === 'thinking' && (block.thinking || block.text)) {
          const raw = block.thinking || block.text
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
          if (text.trim()) items.push({ kind: 'thinking', text })
        } else if (block.type === 'tool_use') {
          const id = block.id
          const res = id ? resultMap.get(id) : undefined
          items.push({ kind: 'tool', tool: block, result: res?.result, extra: res?.extra })
        }
      }
    }
  }

  const globalSettings = useSessionsStore(state => state.globalSettings)
  const userTag = (globalSettings.userLabel as string)?.trim() || 'USER'
  const agentTag = (globalSettings.agentLabel as string)?.trim() || 'CLAUDE'
  const label = isUser ? userTag : agentTag
  const customColor = isUser ? (globalSettings.userColor as string)?.trim() : (globalSettings.agentColor as string)?.trim()
  const borderColor = isUser ? 'border-event-prompt' : 'border-primary'
  const labelBg = isUser ? 'bg-event-prompt text-background' : 'bg-primary text-primary-foreground'
  const sizeKey = (isUser ? (globalSettings.userSize as string) : (globalSettings.agentSize as string)) || ''
  const sizeClass = { xs: 'text-[8px]', sm: 'text-[9px]', '': 'text-[10px]', lg: 'text-[13px]', xl: 'text-[16px]' }[sizeKey] || 'text-[10px]'

  return (
    <div className="mb-4">
      {/* Single header for the group */}
      <div className="flex items-center gap-2 mb-2">
        <span className={cn('text-[10px]', borderColor)}>┌──</span>
        <span
          className={cn('px-2 py-0.5 font-bold', sizeClass, !customColor && labelBg)}
          style={customColor ? { backgroundColor: customColor, color: '#0a0a0a' } : undefined}
        >
          {label}
        </span>
        <span className="text-muted-foreground text-[10px]">{time}</span>
        <span className={cn('flex-1 text-[10px] overflow-hidden', borderColor)}>{'─'.repeat(40)}</span>
      </div>

      {/* Content - rendered in chronological order */}
      <div className="pl-4 space-y-2">
        {items.map((item, i) => {
          switch (item.kind) {
            case 'thinking':
              if (!showThinking && !expandAll) return null
              return (
                <div key={i} className="border-l-2 border-purple-400/40 pl-3 py-1">
                  <div className="text-[10px] text-purple-400/70 uppercase font-bold tracking-wider mb-1">thinking</div>
                  <div className="text-sm opacity-75">
                    <Markdown>{item.text}</Markdown>
                  </div>
                </div>
              )
            case 'text':
              return (
                <div key={i} className="text-sm">
                  <Markdown>{item.text}</Markdown>
                </div>
              )
            case 'images':
              return (
                <div key={i} className="flex flex-wrap gap-2 pt-2">
                  {item.images.map(img => (
                    <a
                      key={img.hash}
                      href={img.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block"
                      title={img.originalPath}
                    >
                      <img
                        src={img.url}
                        alt={img.originalPath.split('/').pop() || 'image'}
                        className="max-w-xs max-h-48 rounded border border-border hover:border-primary transition-colors"
                        loading="lazy"
                      />
                    </a>
                  ))}
                </div>
              )
            case 'tool':
              return (
                <ToolLine
                  key={i}
                  tool={item.tool}
                  result={item.result}
                  toolUseResult={item.extra}
                  subagents={subagents}
                />
              )
          }
        })}
      </div>
    </div>
  )
}

// Construction-striped "COMPACTED" divider line
function CompactedDivider() {
  return (
    <div className="my-4 flex items-center gap-2">
      <div
        className="flex-1 h-px"
        style={{
          backgroundImage:
            'repeating-linear-gradient(90deg, #e5c07b 0px, #e5c07b 8px, transparent 8px, transparent 16px)',
        }}
      />
      <span className="px-2 py-0.5 text-[10px] font-bold font-mono uppercase tracking-widest text-amber-400/80 bg-amber-400/10 border border-amber-400/30">
        compacted
      </span>
      <div
        className="flex-1 h-px"
        style={{
          backgroundImage:
            'repeating-linear-gradient(90deg, #e5c07b 0px, #e5c07b 8px, transparent 8px, transparent 16px)',
        }}
      />
    </div>
  )
}

// Compacting in-progress banner
function CompactingBanner() {
  return (
    <div className="my-4 flex items-center gap-2 px-3 py-2 bg-amber-400/10 border border-amber-400/30 animate-pulse">
      <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
      <span className="text-[11px] font-mono font-bold text-amber-400 uppercase tracking-wider">
        Compacting context...
      </span>
    </div>
  )
}

interface TranscriptViewProps {
  entries: TranscriptEntry[]
  follow?: boolean
  showThinking?: boolean
  onUserScroll?: () => void
  onReachedBottom?: () => void
}

export function TranscriptView({
  entries,
  follow = false,
  showThinking = false,
  onUserScroll,
  onReachedBottom,
}: TranscriptViewProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  // Ref kills the scroll timer synchronously (before React re-renders)
  const followKilledRef = useRef(false)

  const resultMap = useMemo(() => buildResultMap(entries), [entries])
  const groups = useMemo(() => groupEntries(entries), [entries])

  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 150,
    overscan: 5,
    // Defer ResizeObserver callbacks to avoid setState-during-render (React #300)
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement
      if (!el) return
      const observer = new ResizeObserver(entries => {
        const entry = entries[0]
        if (entry) {
          requestAnimationFrame(() => {
            cb({ width: entry.contentRect.width, height: entry.contentRect.height })
          })
        }
      })
      observer.observe(el)
      return () => observer.disconnect()
    },
  })

  // Reset kill ref when follow re-engages
  useEffect(() => {
    if (follow) followKilledRef.current = false
  }, [follow])

  // Kill follow on user interaction (wheel/touch are never fired by programmatic scrollTo)
  const killFollow = useCallback(
    (e: React.WheelEvent | React.TouchEvent) => {
      if (!follow) return
      if ('deltaY' in e && e.deltaY >= 0) return
      followKilledRef.current = true
      onUserScroll?.()
    },
    [follow, onUserScroll],
  )

  // Re-engage follow when user manually scrolls to the bottom
  useEffect(() => {
    const el = parentRef.current
    if (!el || follow) return
    function handleScroll() {
      if (!el) return
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
      if (atBottom) onReachedBottom?.()
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [follow, onReachedBottom])

  // Follow mode: scroll to bottom on new data OR initial load
  const newDataSeq = useSessionsStore(state => state.newDataSeq)
  const scrollToBottom = useCallback(() => {
    const el = parentRef.current
    if (!el || followKilledRef.current) return
    el.scrollTop = el.scrollHeight
  }, [])

  // Scroll on data updates
  useEffect(() => {
    if (!follow || followKilledRef.current) return
    // Double rAF: lets React + virtualizer finish layout
    requestAnimationFrame(() => requestAnimationFrame(scrollToBottom))
  }, [follow, newDataSeq, scrollToBottom])

  // Scroll on initial mount / follow re-engage - virtualizer needs time to measure
  useEffect(() => {
    if (!follow) return
    const t = setTimeout(scrollToBottom, 150)
    return () => clearTimeout(t)
  }, [follow, entries.length, scrollToBottom])

  if (groups.length === 0) {
    return (
      <div className="text-muted-foreground text-center py-10 font-mono">
        <pre className="text-xs">
          {`
┌─────────────────────────┐
│   [ NO TRANSCRIPT ]     │
│   Waiting for data...   │
└─────────────────────────┘
`.trim()}
        </pre>
      </div>
    )
  }

  return (
    <div ref={parentRef} className="h-full overflow-y-auto p-3 sm:p-4" onWheel={killFollow} onTouchStart={killFollow}>
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map(virtualItem => (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            {(() => {
              const group = groups[virtualItem.index]
              if (group.type === 'compacted') return <CompactedDivider />
              if (group.type === 'compacting') return <CompactingBanner />
              return <GroupView group={group} resultMap={resultMap} showThinking={showThinking} />
            })()}
          </div>
        ))}
      </div>
    </div>
  )
}
