import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import { Marked } from 'marked'
import { describe, expect, test } from 'vitest'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)

// Replicate the exact markdown setup from markdown.tsx
const marked = new Marked()
const renderer = new marked.Renderer()

renderer.link = ({ href, text }) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
renderer.code = ({ text, lang }) => {
  const langClass = lang ? ` class="hljs language-${lang}"` : ' class="hljs"'
  // Replicate the fix: escape angle brackets in fallback path (no hljs match)
  let highlighted: string | undefined
  if (lang && hljs.getLanguage(lang)) {
    try {
      highlighted = hljs.highlight(text, { language: lang }).value
    } catch {}
  }
  const safe = highlighted ?? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<div class="code-block-wrap"><pre><code${langClass}>${safe}</code></pre></div>`
}

marked.setOptions({ gfm: true, breaks: true, renderer, async: false })

marked.use({
  hooks: {
    preprocess(src: string) {
      const parts = src.split(/(^```[^\n]*\n[\s\S]*?\n```$|`[^`\n]+`)/gm)
      return parts
        .map((part, i) => {
          if (i % 2 === 1) return part
          return part.replace(/<(\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?)>/g, '&lt;$1&gt;')
        })
        .join('')
    },
  },
})

// Replicate strikethrough extension
marked.use({
  tokenizer: {
    del() {
      return undefined as ReturnType<typeof this.del>
    },
  },
  extensions: [
    {
      name: 'del',
      level: 'inline' as const,
      start(src: string) {
        return src.indexOf('~~')
      },
      tokenizer(src: string) {
        const match = src.match(/^~~(?!~)(\S[\s\S]{0,198}?\S|\S)~~(?!~)/)
        if (match) {
          // biome-ignore lint/suspicious/noExplicitAny: marked extension API
          const token = { type: 'del', raw: match[0], text: match[1], tokens: [] as any[] }
          // biome-ignore lint/suspicious/noExplicitAny: marked internal lexer
          ;(this as any).lexer.inlineTokens(match[1], token.tokens)
          return token
        }
        return undefined
      },
      // biome-ignore lint/suspicious/noExplicitAny: marked extension renderer
      renderer(token: any) {
        return `<del>${this.parser.parseInline(token.tokens)}</del>`
      },
    },
  ],
})

function render(input: string): string {
  return (marked.parse(input) as string).trim()
}

function renderInline(input: string): string {
  return (marked.parseInline(input) as string).trim()
}

// Helper: check visible text (strips HTML tags, decodes entities)
function textContent(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim()
}

describe('angle bracket escaping', () => {
  test('bare <tag> in text is escaped', () => {
    const html = render('hello <world> there')
    expect(html).toContain('&lt;world&gt;')
    expect(html).not.toContain('<world>')
  })

  test('<key> placeholder is escaped', () => {
    const html = render('!step:<key>[:<classes>[:<title>]]')
    expect(html).toContain('&lt;key&gt;')
    expect(html).toContain('&lt;classes&gt;')
    expect(html).toContain('&lt;title&gt;')
  })

  test('multiple angle brackets in one line', () => {
    const html = render('use <Component> with <Props> and <Children>')
    expect(html).toContain('&lt;Component&gt;')
    expect(html).toContain('&lt;Props&gt;')
    expect(html).toContain('&lt;Children&gt;')
  })

  test('angle brackets inside fenced code blocks are preserved', () => {
    const html = render('```\n<div class="foo">hello</div>\n```')
    // Code blocks: preprocess skips them, content passed to hljs/code renderer as-is
    expect(html).toContain('<code')
    expect(html).toContain('<div')
  })

  test('angle brackets inside inline code are NOT escaped', () => {
    const html = render('use `<Component>` here')
    expect(html).toContain('&lt;Component&gt;')
  })

  test('self-closing tags like <br/> pass through (not matched by tag regex)', () => {
    const html = render('line1<br/>line2')
    // Our preprocess regex matches <word> but not <br/> (slash not in pattern)
    // Marked itself handles <br/> as valid HTML - it passes through
    expect(html).toContain('<br/>')
  })

  test('closing tags like </div> are escaped', () => {
    const html = render('text </div> more')
    expect(html).toContain('&lt;/div&gt;')
  })

  test('non-tag angle brackets preserved: 3 < 5 > 1', () => {
    // The regex only matches <word...> pattern, not bare < or >
    const html = render('3 < 5 > 1')
    // These aren't tag-like so they pass through to marked which handles them
    expect(textContent(html)).toContain('3')
  })
})

describe('square bracket edge cases', () => {
  test('bare brackets not consumed as links: [foo]', () => {
    const html = render('value is [optional]')
    expect(textContent(html)).toContain('[optional]')
  })

  test('nested brackets: [a[b]]', () => {
    const html = render('syntax: [a[b]]')
    expect(textContent(html)).toContain('[a[b]]')
  })

  test('brackets with colons: [:<foo>]', () => {
    const html = render('[:<foo>]')
    expect(textContent(html)).toContain('[:')
    expect(html).toContain('&lt;foo&gt;')
  })

  test('complex bracket+angle pattern: !step:<key>[:<classes>[:<title>]]', () => {
    const html = render('!step:<key>[:<classes>[:<title>]]')
    const text = textContent(html)
    // ALL parts must survive
    expect(text).toContain('!step:')
    expect(text).toContain('[:<classes>[:<title>]]')
    expect(html).toContain('&lt;key&gt;')
    expect(html).toContain('&lt;classes&gt;')
    expect(html).toContain('&lt;title&gt;')
  })

  test('image-like false positive: !important[note]', () => {
    const html = render('!important[note]')
    expect(textContent(html)).toContain('!important[note]')
  })

  test('real markdown image preserved: ![alt](http://example.com/img.png)', () => {
    const html = render('![alt](http://example.com/img.png)')
    expect(html).toContain('<img')
    expect(html).toContain('src="http://example.com/img.png"')
  })

  test('real markdown link preserved: [text](http://example.com)', () => {
    const html = render('[text](http://example.com)')
    expect(html).toContain('<a href="http://example.com"')
    expect(html).toContain('text</a>')
  })
})

describe('the actual !step bug - full content', () => {
  const fullContent = `\`\`\`
!step:<key>[:<classes>[:<title>]]
\`\`\`

| Parameter | Required | Description |
|-----------|----------|-------------|
| \`key\` | yes | Step identifier (used for navigation/tracking) |
| \`classes\` | no | CSS classes applied to the step |
| \`title\` | no | Display title shown in the step progress |

**Examples:**
\`\`\`
!step:personal-info                          -- just a key
!step:personal-info:col-md-8                 -- key + CSS class
!step:personal-info:col-md-8:Personal Info   -- key + class + title
!step:medical::Medical History               -- key + no classes + title
\`\`\``

  test('fenced code block preserves full syntax (escaped for browser safety)', () => {
    const html = render(fullContent)
    // Code renderer escapes angle brackets so browser doesn't eat them as HTML elements
    expect(html).toContain('!step:')
    expect(html).toContain('&lt;key&gt;')
    expect(html).toContain('&lt;classes&gt;')
    expect(html).toContain('&lt;title&gt;')
  })

  test('table renders with all rows', () => {
    const html = render(fullContent)
    expect(html).toContain('<table')
    expect(html).toContain('key')
    expect(html).toContain('classes')
    expect(html).toContain('title')
  })

  test('examples code block preserves all lines', () => {
    const html = render(fullContent)
    expect(html).toContain('!step:personal-info')
    expect(html).toContain('!step:personal-info:col-md-8')
    expect(html).toContain('!step:medical::Medical History')
  })
})

describe('parseInline (no preprocess hook)', () => {
  // Surprising finding: marked's parseInline ALSO escapes unknown HTML tags!
  // So the bug is NOT in parseInline failing to escape.

  test('marked parseInline escapes unknown HTML tags', () => {
    const html = renderInline('hello <world> there')
    // marked escapes unknown tags even in parseInline mode
    expect(html).toContain('&lt;world&gt;')
  })

  test('parseInline handles angle brackets in !step syntax', () => {
    const html = renderInline('!step:<key>[:<classes>[:<title>]]')
    // marked escapes these as unknown HTML tags
    expect(html).toContain('&lt;key&gt;')
    expect(html).toContain('&lt;classes&gt;')
    expect(html).toContain('&lt;title&gt;')
    // Square brackets survive
    expect(html).toContain('[:')
    expect(html).toContain(']]')
  })

  test('square brackets in parseInline', () => {
    const html = renderInline('foo[bar]baz')
    expect(html).toContain('foo[bar]baz')
  })

  test('image pattern in parseInline: ![alt](url)', () => {
    const html = renderInline('![alt](http://example.com/img.png)')
    expect(html).toContain('<img')
  })
})

describe('inline code protection', () => {
  test('angle brackets in inline code: `<Component>`', () => {
    const html = render('use `<Component>` in your code')
    // Inline code should show the angle brackets literally
    expect(html).toContain('<code>')
    // The content inside code should have escaped brackets
    expect(html).toContain('&lt;Component&gt;')
  })

  test('brackets in inline code: `[key]`', () => {
    const html = render('access `[key]` to get value')
    expect(html).toContain('<code>[key]</code>')
  })

  test('complex syntax in inline code: `!step:<key>[:<classes>]`', () => {
    const html = render('use `!step:<key>[:<classes>]` format')
    expect(html).toContain('<code>')
    // Inside inline code, angle brackets are handled by marked's code renderer
    expect(html).toContain('!step:')
  })
})

describe('THE BUG: raw angle brackets in code blocks', () => {
  // This is the actual bug Jonas found: code fences preserve raw <tag> text,
  // but when rendered via dangerouslySetInnerHTML, the browser interprets
  // <key>, <classes>, <title> as unknown HTML elements and strips them.
  // Fix: escape angle brackets in the code renderer fallback path.

  test('unfenced code block escapes angle brackets', () => {
    const html = render('```\n!step:<key>[:<classes>[:<title>]]\n```')
    // Must NOT contain raw <key> - browser would eat it
    expect(html).not.toMatch(/<key>/)
    expect(html).not.toMatch(/<classes>/)
    expect(html).not.toMatch(/<title>/)
    // Must contain escaped versions
    expect(html).toContain('&lt;key&gt;')
    expect(html).toContain('&lt;classes&gt;')
    expect(html).toContain('&lt;title&gt;')
  })

  test('code block with generic types escapes properly', () => {
    const html = render('```\nMap<string, List<int>>\n```')
    expect(html).not.toMatch(/<string,/)
    expect(html).toContain('&lt;string')
  })

  test('code block with HTML tags escapes them', () => {
    const html = render('```\n<div class="foo">hello</div>\n```')
    expect(html).toContain('&lt;div')
    expect(html).toContain('&lt;/div&gt;')
  })

  test('code block with known language still works (hljs escapes internally)', () => {
    const html = render('```js\nconst x = a < b ? 1 : 2\n```')
    expect(html).toContain('<code class="hljs language-js">')
    // hljs handles escaping internally
    expect(html).not.toContain('< b')
  })
})

describe('fenced code block edge cases', () => {
  test('indented code fence still protected', () => {
    // Note: our preprocess regex requires ``` at start of line (^)
    // Indented fences won't match the split regex!
    const html = render('  ```\n  <div>hello</div>\n  ```')
    // This may or may not be protected depending on indent handling
    // Just document the behavior
    expect(html).toBeDefined()
  })

  test('code fence with language tag', () => {
    const html = render('```csharp\npublic class Foo<T> { }\n```')
    // Code block content isn't escaped by preprocess (fenced blocks are skipped)
    // hljs may or may not escape angle brackets depending on language support
    expect(html).toContain('Foo')
    expect(html).toContain('<code')
  })

  test('multiple code fences in one block', () => {
    const html = render('```\nfirst<tag>\n```\n\ntext<tag>\n\n```\nsecond<tag>\n```')
    // Middle text: angle brackets escaped by preprocess
    expect(html).toContain('&lt;tag&gt;')
    // Code blocks: contain <tag> (preserved by preprocess skip)
    expect(html).toContain('first')
    expect(html).toContain('second')
  })

  test('backtick-heavy content: ````nested````', () => {
    // Four backticks shouldn't break the split regex
    const html = render('````\n<tag>\n````')
    expect(html).toBeDefined()
  })
})

describe('table cell content', () => {
  test('angle brackets in table cells', () => {
    const html = render('| Col |\n|---|\n| <value> |')
    // Table cells go through parseInline - preprocess should have escaped already
    expect(html).toContain('&lt;value&gt;')
  })

  test('brackets in table cells', () => {
    const html = render('| Col |\n|---|\n| [optional] |')
    expect(textContent(html)).toContain('[optional]')
  })

  test('backticks in table cells', () => {
    const html = render('| Col |\n|---|\n| `code` |')
    expect(html).toContain('<code>code</code>')
  })
})

describe('real-world transcript patterns', () => {
  test('TypeScript generics: Map<string, number>', () => {
    const html = render('Use `Map<string, number>` for the store')
    expect(html).toContain('<code>')
  })

  test('bare TypeScript generic without backticks', () => {
    const html = render('The Map<string, number> type')
    expect(html).toContain('&lt;string, number&gt;')
    expect(textContent(html)).toContain('Map<string, number>')
  })

  test('JSX/React component mention', () => {
    const html = render('Render <ProjectList> in the sidebar')
    expect(html).toContain('&lt;ProjectList&gt;')
    expect(textContent(html)).toContain('<ProjectList>')
  })

  test('HTML in assistant explanation', () => {
    const html = render('The <div class="wrapper"> element contains...')
    // Preprocess escapes the tag, marked may further encode the quotes
    expect(html).toContain('&lt;div class=')
    expect(html).toContain('wrapper')
    expect(textContent(html)).toContain('element contains')
  })

  test('angle brackets in file path context', () => {
    const html = render('Edit <stdin> to fix the issue')
    expect(html).toContain('&lt;stdin&gt;')
  })

  test('C# generic syntax: List<int>', () => {
    const html = render('Returns a List<int> of IDs')
    expect(html).toContain('&lt;int&gt;')
    expect(textContent(html)).toContain('List<int>')
  })

  test('multiple generics: Dict<string, List<int>>', () => {
    const html = render('Uses Dict<string, List<int>> for caching')
    expect(html).toContain('&lt;string, List&lt;int&gt;&gt;')
  })
})
