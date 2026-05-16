import { Marked } from 'marked'
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef } from 'react'
import { CopyMenu } from './copy-menu'
import { filenameFromUrl, type MediaKind, openMediaLightbox } from './media-lightbox'
import { ensureLang, getHighlighter, normalizeLang } from './transcript/syntax'

const marked = new Marked()

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Extension-based media detection for `![x](url.png)` (images) and
// `[clip](url.mp4)` style links. Matches against the URL's path only so
// querystrings / fragments don't trip us up.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv'])

function detectMediaKind(href: string): MediaKind | null {
  if (!href) return null
  try {
    // Use a dummy base so protocol-relative + relative URLs still parse.
    const u = new URL(href, 'https://x.invalid')
    const m = u.pathname.toLowerCase().match(/\.([a-z0-9]+)$/)
    if (!m) return null
    const ext = m[1]
    if (IMAGE_EXT.has(ext)) return 'image'
    if (VIDEO_EXT.has(ext)) return 'video'
    return null
  } catch {
    return null
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Resolve the display label for a media chip: markdown-provided text wins,
// URL filename is the fallback. Marked sets `text === href` when the user
// writes a bare URL (no `[label](url)`); treat that as "no label given".
function resolveMediaLabel(href: string, markdownText: string): string {
  const given = markdownText && markdownText !== href ? markdownText : ''
  return given || filenameFromUrl(href)
}

// Image chip: bounded thumbnail + caption that opens the full asset in the
// lightbox. `max-h-32` caps the inline footprint at 128px so virtualizer row
// estimates stay stable -- no "huge screenshot blows up the transcript"
// surprise. Caption below the thumbnail shows the markdown alt, or the URL
// filename when alt is empty (CC's attached-file syntax uses the filename
// anyway, so either way you get something human-readable).
function renderImageChip(href: string, alt: string): string {
  const safeHref = escapeAttr(href)
  const name = resolveMediaLabel(href, alt)
  const safeAlt = escapeAttr(alt || name)
  const safeName = escapeAttr(name)
  return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="lightbox-chip lightbox-chip-image inline-block align-middle max-w-full" data-lightbox-src="${safeHref}" data-lightbox-kind="image" data-lightbox-alt="${safeAlt}"><span class="inline-flex flex-col items-start gap-1 max-w-full"><img src="${safeHref}" alt="${safeAlt}" loading="lazy" class="max-h-32 max-w-full object-contain rounded border border-border/40 cursor-zoom-in hover:border-accent/60 transition-colors" /><span class="text-[10px] text-muted-foreground font-mono truncate max-w-full" title="${safeName}">${safeName}</span></span></a>`
}

// Video chip: no inline <video> (that would autoplay + explode layout); a
// small play-icon pill with the markdown label (or filename fallback).
// Click pops the lightbox.
function renderVideoChip(href: string, label: string): string {
  const safeHref = escapeAttr(href)
  const safeName = escapeAttr(resolveMediaLabel(href, label))
  return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="lightbox-chip lightbox-chip-video" data-lightbox-src="${safeHref}" data-lightbox-kind="video"><span class="inline-flex items-center gap-1.5 px-2 py-1 bg-muted/40 border border-border/50 rounded text-xs text-foreground/90 hover:bg-muted/60 hover:border-accent/60 transition-colors cursor-pointer align-middle"><svg viewBox="0 0 16 16" aria-hidden="true" class="h-3 w-3 text-accent fill-current"><path d="M4 2.5v11l10-5.5-10-5.5z"/></svg><span class="font-mono">${safeName}</span></span></a>`
}

// Custom renderer
const renderer = new marked.Renderer()
renderer.link = ({ href, text }) => {
  // `[clip](url.mp4)` / `[pic](url.png)` -> media chip. The chip is an
  // anchor with data-lightbox-* attrs; Markdown's onClick delegate (below)
  // preventDefaults and opens the lightbox. Fall through to a plain link
  // for non-media URLs so nothing else changes.
  const kind = detectMediaKind(href)
  if (kind === 'image') return renderImageChip(href, text)
  if (kind === 'video') return renderVideoChip(href, text)
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
}
renderer.image = ({ href, text, title }) => {
  const kind = detectMediaKind(href) || 'image'
  if (kind === 'video') return renderVideoChip(href, text || title || '')
  return renderImageChip(href, text || title || '')
}
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
  const canonical = normalizeLang(lang)
  const escaped = escapeHtml(text)
  // Cache hit -> emit highlighted HTML synchronously, no flash on re-renders.
  if (canonical) {
    const cached = hlCacheGet(`${canonical}\n${text}`)
    if (cached !== undefined) {
      return `<div class="code-block-wrap"><pre><code class="shiki language-${canonical}">${cached}</code></pre><button class="code-copy-btn" title="Copy">⧉</button></div>`
    }
  }
  // No cache: emit placeholder with raw source in a data attr, useEffect highlights post-mount.
  // Unknown langs: just emit escaped text with no highlight attempt.
  const dataAttr = canonical ? ` data-shiki-source="${encodeURIComponent(text)}" data-shiki-lang="${canonical}"` : ''
  const cls = canonical ? `shiki language-${canonical}` : 'shiki'
  return `<div class="code-block-wrap"><pre><code class="${cls}"${dataAttr}>${escaped}</code></pre><button class="code-copy-btn" title="Copy">⧉</button></div>`
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
          let out = part.replace(/<(\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?)>/g, '&lt;$1&gt;')
          // Strip trailing backslash before newline. With `breaks: true`, every `\n`
          // already produces a hard break, so `\\\n` is redundant -- and marked leaks
          // the `\` literally when the next line starts a list or other block.
          out = out.replace(/\\\n/g, '\n')
          return out
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

// Post-mount shiki highlight pass. Finds `<code data-shiki-source>` placeholders,
// loads the language if needed, runs `codeToTokens`, swaps innerHTML with colored spans,
// caches the result so a re-render of identical (lang, text) is synchronous.
function renderShikiBlocks(container: HTMLElement) {
  const blocks = container.querySelectorAll<HTMLElement>('code[data-shiki-source]')
  if (blocks.length === 0) return
  // Group by language so we only ensureLang() once per lang per render pass.
  const byLang = new Map<string, HTMLElement[]>()
  for (const el of blocks) {
    const lang = el.getAttribute('data-shiki-lang') || ''
    if (!lang) continue
    const arr = byLang.get(lang) || []
    arr.push(el)
    byLang.set(lang, arr)
  }
  for (const [lang, elements] of byLang) {
    ensureLang(lang).then(ok => {
      if (!ok) {
        // Lang unknown after lookup -- clear the placeholder attrs so we don't retry.
        for (const el of elements) {
          el.removeAttribute('data-shiki-source')
          el.removeAttribute('data-shiki-lang')
        }
        return
      }
      return getHighlighter().then(hl => {
        for (const el of elements) {
          // Element may have been detached or replaced since the request started.
          if (!el.isConnected) continue
          const encoded = el.getAttribute('data-shiki-source')
          if (!encoded) continue
          const text = decodeURIComponent(encoded)
          const cacheKey = `${lang}\n${text}`
          let html = hlCacheGet(cacheKey)
          if (html === undefined) {
            try {
              const tokens = hl.codeToTokens(text, { lang, theme: 'tokyo-night' })
              html = tokens.tokens
                .map((line: Array<{ color?: string; content: string }>) =>
                  line.map(t => `<span style="color:${t.color}">${escapeHtml(t.content)}</span>`).join(''),
                )
                .join('\n')
              hlCacheSet(cacheKey, html)
            } catch {
              html = undefined
            }
          }
          if (html !== undefined) {
            el.innerHTML = html
          }
          el.removeAttribute('data-shiki-source')
          el.removeAttribute('data-shiki-lang')
        }
      })
    })
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

// LRU cache for highlighted code fragments, keyed by `${lang}\n${text}`.
// Survives component mount/unmount so scrolling back to an earlier group
// (or remounting after a Zustand update) skips re-highlighting identical code.
const HL_CACHE_MAX = 200
const hlCache = new Map<string, string>()

function hlCacheGet(key: string): string | undefined {
  const v = hlCache.get(key)
  if (v !== undefined) {
    hlCache.delete(key)
    hlCache.set(key, v)
  }
  return v
}

function hlCacheSet(key: string, value: string) {
  if (hlCache.size >= HL_CACHE_MAX) {
    const oldest = hlCache.keys().next().value
    if (oldest !== undefined) hlCache.delete(oldest)
  }
  hlCache.set(key, value)
}

// LRU cache for parsed markdown HTML, keyed by `${inline?'i':'b'}\n${source}`.
// marked.parse runs synchronously during render/commit. On a conversation
// switch the transcript view is remounted (key={conversationId}), so every
// visible Markdown component would re-parse from scratch -- a measurable
// chunk of the switch-lag beach ball. A module-level cache survives
// mount/unmount, so re-visiting a conversation (or re-rendering an
// already-seen block) skips the parse entirely.
const PARSE_CACHE_MAX = 300
const parseCache = new Map<string, string>()

function parseCacheGet(key: string): string | undefined {
  const v = parseCache.get(key)
  if (v !== undefined) {
    parseCache.delete(key)
    parseCache.set(key, v)
  }
  return v
}

function parseCacheSet(key: string, value: string) {
  if (parseCache.size >= PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value
    if (oldest !== undefined) parseCache.delete(oldest)
  }
  parseCache.set(key, value)
}

interface MarkdownProps {
  children: string
  inline?: boolean
  /** Show a hover-reveal CopyMenu button for the raw markdown source */
  copyable?: boolean
}

export const Markdown = memo(function Markdown({ children, inline, copyable }: MarkdownProps) {
  // Defer the content used for parsing so rapid stream-delta updates (headless
  // streaming text, long assistant turns) can be coalesced by React. During the
  // stall window the previous HTML stays mounted -- no main-thread parse work.
  const deferred = useDeferredValue(children)
  const html = useMemo(() => {
    const cacheKey = `${inline ? 'i' : 'b'}\n${deferred}`
    const cached = parseCacheGet(cacheKey)
    if (cached !== undefined) return cached
    const out = inline ? (marked.parseInline(deferred) as string) : (marked.parse(deferred) as string)
    parseCacheSet(cacheKey, out)
    return out
  }, [deferred, inline])

  const ref = useRef<HTMLDivElement>(null)

  // Post-mount: kick off shiki highlighting + mermaid rendering. Both walk the just-rendered DOM.
  // biome-ignore lint/correctness/useExhaustiveDependencies: html is the dep key; ref is stable
  useEffect(() => {
    const el = ref.current
    if (!el) return
    renderShikiBlocks(el)
    renderMermaidBlocks(el)
  }, [html])

  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement

    // Lightbox chip: open the media overlay instead of navigating. Respect
    // modifier-clicks so cmd/ctrl/middle-click still opens in a new tab.
    const chip = target.closest('.lightbox-chip') as HTMLAnchorElement | null
    if (chip) {
      const me = e as unknown as MouseEvent
      if (me.metaKey || me.ctrlKey || me.shiftKey || me.button === 1) return
      const src = chip.getAttribute('data-lightbox-src') || chip.href
      const kind = (chip.getAttribute('data-lightbox-kind') as MediaKind) || 'image'
      const alt = chip.getAttribute('data-lightbox-alt') || undefined
      if (src) {
        e.preventDefault()
        openMediaLightbox(src, kind, alt)
      }
      return
    }

    const btn = target.closest('.code-copy-btn') as HTMLButtonElement | null
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

  const inner = (
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

  if (!copyable) return inner

  return (
    <div className="relative group/md">
      {inner}
      <CopyMenu
        text={children}
        className="absolute top-0 right-0 opacity-60 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/md:opacity-60 hover:!opacity-100 transition-opacity"
      />
    </div>
  )
})
