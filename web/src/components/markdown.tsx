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
import { useCallback, useMemo, useRef } from 'react'

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
renderer.code = ({ text, lang }) => {
  const langClass = lang ? ` class="hljs language-${lang}"` : ' class="hljs"'
  let highlighted = text
  if (lang && hljs.getLanguage(lang)) {
    try {
      highlighted = hljs.highlight(text, { language: lang }).value
    } catch {}
  }
  return `<div class="code-block-wrap"><pre><code${langClass}>${highlighted}</code></pre><button class="code-copy-btn" title="Copy">⧉</button></div>`
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

// Sanitize: escape HTML tags in the source before marked processes them.
// This ensures <foo> in transcript text renders as visible "&lt;foo&gt;" not invisible HTML.
// Marked's built-in html:false doesn't exist in v15+ - we use a walkTokens hook instead.
marked.use({
  hooks: {
    preprocess(src: string) {
      // Escape HTML tags that aren't inside fenced code blocks
      // Split on fenced code blocks, only escape outside them
      const parts = src.split(/(```[\s\S]*?```|`[^`\n]+`)/g)
      return parts
        .map((part, i) => {
          // Odd indices are code blocks/inline code - leave them alone
          if (i % 2 === 1) return part
          // Escape < that look like HTML tags (not operators like < in math)
          return part.replace(/<(\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?)>/g, '&lt;$1&gt;')
        })
        .join('')
    },
  },
})

// Override GFM strikethrough to require double tildes only (~~text~~)
// Default marked GFM also matches single ~text~ which breaks paths like ~/foo
marked.use({
  extensions: [
    {
      name: 'del',
      level: 'inline',
      start(src: string) {
        return src.indexOf('~~')
      },
      tokenizer(src: string) {
        const match = src.match(/^~~(?!~)([\s\S]+?)~~(?!~)/)
        if (match) {
          return { type: 'del', raw: match[0], text: match[1], tokens: [] }
        }
        return undefined
      },
      renderer(token: any) {
        return `<del>${this.parser.parseInline(token.tokens)}</del>`
      },
    },
  ],
})

interface MarkdownProps {
  children: string
}

export function Markdown({ children }: MarkdownProps) {
  const html = useMemo(() => {
    return marked.parse(children) as string
  }, [children])

  const ref = useRef<HTMLDivElement>(null)

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

  return <div ref={ref} className="prose-hacker" dangerouslySetInnerHTML={{ __html: html }} onClick={handleClick} />
}
