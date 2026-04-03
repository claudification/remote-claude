import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
// Import only languages we need
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { Marked } from 'marked'
import { useCallback, useEffect, useMemo, useRef } from 'react'

// Register languages
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('go', go)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)

const marked = new Marked()

// Custom renderer
const renderer = new marked.Renderer()
renderer.link = ({ href, text }) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
renderer.table = ({ header, rows, raw }) => {
  // Store raw GFM source in a hidden div for markdown copy
  const escapedRaw = raw.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // Render header - parseInline renders bold/italic/code/links in cells
  let html = '<table><thead><tr>'
  for (const cell of header) {
    const align = cell.align ? ` style="text-align:${cell.align}"` : ''
    html += `<th${align}>${marked.parseInline(cell.text)}</th>`
  }
  html += '</tr></thead><tbody>'
  for (const row of rows) {
    html += '<tr>'
    for (const cell of row) {
      const align = cell.align ? ` style="text-align:${cell.align}"` : ''
      html += `<td${align}>${marked.parseInline(cell.text)}</td>`
    }
    html += '</tr>'
  }
  html += '</tbody></table>'
  return `<div class="table-block">${html}<div class="table-source" style="display:none">${escapedRaw}</div></div>`
}
// GitHub-flavored markdown alerts/callouts: > [!TIP], > [!NOTE], > [!WARNING], etc.
const ALERT_STYLES: Record<string, { icon: string; color: string; border: string }> = {
  TIP: { icon: '💡', color: 'text-emerald-400', border: 'border-emerald-500/40' },
  NOTE: { icon: 'ℹ️', color: 'text-blue-400', border: 'border-blue-500/40' },
  IMPORTANT: { icon: '❗', color: 'text-violet-400', border: 'border-violet-500/40' },
  WARNING: { icon: '⚠️', color: 'text-amber-400', border: 'border-amber-500/40' },
  CAUTION: { icon: '🔴', color: 'text-red-400', border: 'border-red-500/40' },
}
renderer.blockquote = ({ text }) => {
  // Check for [!TYPE] pattern at the start of the blockquote content.
  // In marked 17, `text` is raw (not HTML-rendered), so we match raw markdown.
  const alertMatch = text.match(/^\s*\[!(TIP|NOTE|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i)
  if (alertMatch) {
    const type = alertMatch[1].toUpperCase()
    const style = ALERT_STYLES[type]
    if (style) {
      const rawContent = text.slice(alertMatch[0].length)
      const content = marked.parseInline(rawContent) as string
      return `<div class="alert-callout border-l-2 ${style.border} pl-3 py-1.5 my-2"><div class="${style.color} font-bold text-[10px] uppercase mb-0.5">${style.icon} ${type}</div><div class="text-foreground/80">${content}</div></div>`
    }
  }
  // Regular blockquote -- parse inline markdown in content
  return `<blockquote>${marked.parseInline(text)}</blockquote>`
}

renderer.code = ({ text, lang }) => {
  // Mermaid blocks: emit placeholder, rendered post-mount via useEffect
  if (lang === 'mermaid') {
    const escaped = text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<pre class="mermaid" data-mermaid-source="${encodeURIComponent(text)}">${escaped}</pre>`
  }
  const langClass = lang ? ` class="hljs language-${lang}"` : ' class="hljs"'
  let highlighted: string | undefined
  if (lang && hljs.getLanguage(lang)) {
    try {
      highlighted = hljs.highlight(text, { language: lang }).value
    } catch {}
  }
  // hljs.highlight escapes <> internally, but the fallback path (no lang match)
  // must escape manually or raw <tag> in code blocks becomes invisible HTML elements
  const safe = highlighted ?? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<div class="code-block-wrap"><pre><code${langClass}>${safe}</code></pre><button class="code-copy-btn" title="Copy">⧉</button></div>`
}

// Configure marked options
marked.setOptions({
  gfm: true,
  breaks: true,
  renderer,
  // SECURITY: Do NOT render raw HTML from markdown source.
  // Angle brackets get escaped so <whatever> shows as text, not DOM elements.
  // Our own renderer output (links, del, code blocks) still works fine.
  async: false,
})

// Sanitize: escape HTML tags in source before marked processes them.
// This ensures <foo> in transcript text renders as visible "&lt;foo&gt;" not invisible HTML.
// Only markdown syntax (links, bold, code, etc.) should produce HTML via the renderer.
//
// Strategy: escape HTML tags everywhere EXCEPT inside fenced code blocks and inline code.
// The split regex must handle multiple code fences correctly (non-greedy, ordered alternation).
marked.use({
  hooks: {
    preprocess(src: string) {
      // Split on fenced code blocks (``` ... ```) and inline code (` ... `)
      // Fenced blocks: match opening ``` with optional lang, then everything up to closing ```
      // Use non-greedy match and require ``` at start of line for opening fence
      const parts = src.split(/(^```[^\n]*\n[\s\S]*?\n```$|`[^`\n]+`)/gm)
      return parts
        .map((part, i) => {
          // Odd indices are code blocks/inline code - leave them alone
          if (i % 2 === 1) return part
          // Escape ALL angle brackets that look like HTML tags
          return part.replace(/<(\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?)>/g, '&lt;$1&gt;')
        })
        .join('')
    },
  },
})

// Override GFM strikethrough:
// - Double tildes only (single ~ breaks ~/foo paths, triple ~~~ blocked)
// - Content must start and end with non-whitespace
// - Max 200 chars content (prevents long-distance accidental matches like ~~50..long text..~~40)
// - Word-adjacent ~~ is allowed (foo~~bar~~, ~~struck~~baz) - matches GFM spec
// - Built-in GFM del disabled to prevent fallback without our rules
marked.use({
  tokenizer: {
    del() {
      return undefined
    },
  },
  extensions: [
    {
      name: 'del',
      level: 'inline',
      start(src: string) {
        return src.indexOf('~~')
      },
      tokenizer(src: string) {
        const match = src.match(/^~~(?!~)(\S[\s\S]{0,198}?\S|\S)~~(?!~)/)
        if (match) {
          // biome-ignore lint/suspicious/noExplicitAny: marked extension API requires loose token typing
          const token = { type: 'del', raw: match[0], text: match[1], tokens: [] as any[] }
          // biome-ignore lint/suspicious/noExplicitAny: marked internal lexer not exposed in public types
          ;(this as any).lexer.inlineTokens(match[1], token.tokens)
          return token
        }
        return undefined
      },
      // biome-ignore lint/suspicious/noExplicitAny: marked extension renderer receives generic token
      renderer(token: any) {
        return `<del>${this.parser.parseInline(token.tokens)}</del>`
      },
    },
  ],
})

// Mermaid SVG theme - uses CSS variables for automatic dark mode support
const MERMAID_THEME = {
  bg: 'var(--background)',
  fg: 'var(--foreground)',
  line: 'var(--muted-foreground)',
  accent: 'var(--primary)',
  muted: 'var(--muted-foreground)',
  surface: 'var(--secondary)',
  border: 'var(--border)',
  transparent: true,
}

// Lazy-loaded mermaid renderer -- only fetched when a mermaid block exists
let mermaidModule: typeof import('beautiful-mermaid') | null = null
let mermaidLoading = false
const mermaidQueue: HTMLElement[] = []

function processMermaidQueue() {
  if (!mermaidModule) return
  for (const block of mermaidQueue.splice(0)) {
    const source = decodeURIComponent(block.getAttribute('data-mermaid-source') || '')
    if (!source) continue
    try {
      const svg = mermaidModule.renderMermaidSVG(source, MERMAID_THEME)
      const wrapper = document.createElement('div')
      wrapper.className = 'mermaid-container'
      wrapper.innerHTML = svg
      block.replaceWith(wrapper)
    } catch (err) {
      const errDiv = document.createElement('div')
      errDiv.className = 'mermaid-error'
      errDiv.textContent = `Mermaid error: ${err instanceof Error ? err.message : String(err)}`
      block.replaceWith(errDiv)
    }
  }
}

function renderMermaidBlocks(container: HTMLElement) {
  const blocks = container.querySelectorAll('pre.mermaid')
  if (blocks.length === 0) return

  for (const block of blocks) mermaidQueue.push(block as HTMLElement)

  if (mermaidModule) {
    processMermaidQueue()
    return
  }

  if (!mermaidLoading) {
    mermaidLoading = true
    import('beautiful-mermaid').then(mod => {
      mermaidModule = mod
      processMermaidQueue()
    })
  }
}

interface MarkdownProps {
  children: string
  inline?: boolean
}

export function Markdown({ children, inline }: MarkdownProps) {
  const html = useMemo(() => {
    return inline ? (marked.parseInline(children) as string) : (marked.parse(children) as string)
  }, [children, inline])

  const ref = useRef<HTMLDivElement>(null)

  // Post-mount: render mermaid blocks into SVG
  useEffect(() => {
    if (ref.current) renderMermaidBlocks(ref.current)
  }, [html])

  const handleClick = useCallback((e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLButtonElement | null
    if (!btn) return
    const wrap = btn.closest('.code-block-wrap')
    const code = wrap?.querySelector('code')
    if (!code) return
    navigator.clipboard.writeText(code.textContent || '').then(() => {
      btn.textContent = '✓'
      setTimeout(() => {
        btn.textContent = '⧉'
      }, 1500)
    })
  }, [])

  return (
    <div
      ref={ref}
      role="document"
      className="prose-hacker [overflow-wrap:break-word]"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
      onKeyDown={e => {
        if (e.key === 'Enter') handleClick(e as unknown as React.MouseEvent)
      }}
    />
  )
}
