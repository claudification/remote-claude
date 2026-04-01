import { Marked } from 'marked'
import { describe, expect, test } from 'vitest'

// Replicate the exact strikethrough setup from markdown.tsx
const marked = new Marked()
marked.setOptions({ gfm: true, async: false })

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

function render(input: string): string {
  return (marked.parse(input) as string).trim()
}

function hasStrikethrough(input: string): boolean {
  return render(input).includes('<del>')
}

function getStruck(input: string): string | null {
  const match = render(input).match(/<del>(.*?)<\/del>/)
  return match ? match[1] : null
}

describe('strikethrough rendering', () => {
  // ── Should render strikethrough ──────────────────────────────────────

  describe('valid strikethrough', () => {
    test('basic ~~word~~', () => {
      expect(hasStrikethrough('~~hello~~')).toBe(true)
      expect(getStruck('~~hello~~')).toBe('hello')
    })

    test('~~multiple words~~', () => {
      expect(hasStrikethrough('~~hello world~~')).toBe(true)
      expect(getStruck('~~hello world~~')).toBe('hello world')
    })

    test('surrounded by spaces', () => {
      expect(hasStrikethrough('before ~~struck~~ after')).toBe(true)
      expect(getStruck('before ~~struck~~ after')).toBe('struck')
    })

    test('at start of line', () => {
      expect(hasStrikethrough('~~struck~~ after')).toBe(true)
      expect(getStruck('~~struck~~ after')).toBe('struck')
    })

    test('at end of line', () => {
      expect(hasStrikethrough('before ~~struck~~')).toBe(true)
      expect(getStruck('before ~~struck~~')).toBe('struck')
    })

    test('after punctuation: (~~struck~~)', () => {
      expect(hasStrikethrough('(~~struck~~)')).toBe(true)
      expect(getStruck('(~~struck~~)')).toBe('struck')
    })

    test('followed by period', () => {
      expect(hasStrikethrough('~~struck~~.')).toBe(true)
    })

    test('followed by comma', () => {
      expect(hasStrikethrough('~~struck~~, more')).toBe(true)
    })

    test('followed by colon', () => {
      expect(hasStrikethrough('~~struck~~: more')).toBe(true)
    })

    test('followed by semicolon', () => {
      expect(hasStrikethrough('~~struck~~; more')).toBe(true)
    })

    test('followed by exclamation', () => {
      expect(hasStrikethrough('~~struck~~!')).toBe(true)
    })

    test('followed by question', () => {
      expect(hasStrikethrough('~~struck~~?')).toBe(true)
    })

    test('single character: ~~x~~', () => {
      expect(hasStrikethrough('~~x~~')).toBe(true)
      expect(getStruck('~~x~~')).toBe('x')
    })

    test('with numbers: ~~40-50 hours~~', () => {
      expect(hasStrikethrough('~~40-50 hours~~')).toBe(true)
      expect(getStruck('~~40-50 hours~~')).toBe('40-50 hours')
    })

    test('long text with mixed content', () => {
      expect(hasStrikethrough('~~The pricing is $10k, maybe $15k~~')).toBe(true)
    })

    test('after bracket: [~~struck~~]', () => {
      expect(hasStrikethrough('[~~struck~~]')).toBe(true)
    })

    test('after quote: "~~struck~~"', () => {
      expect(hasStrikethrough('"~~struck~~"')).toBe(true)
    })

    test('multiple in one line', () => {
      const html = render('~~one~~ and ~~two~~')
      expect(html).toContain('<del>one</del>')
      expect(html).toContain('<del>two</del>')
    })

    test('nested bold: ~~**bold**~~', () => {
      const html = render('~~**bold struck**~~')
      expect(html).toContain('<del>')
      expect(html).toContain('<strong>bold struck</strong>')
    })

    test('nested italic: ~~*italic*~~', () => {
      const html = render('~~*italic struck*~~')
      expect(html).toContain('<del>')
      expect(html).toContain('<em>italic struck</em>')
    })

    test('adjacent to other markdown: *italic* ~~struck~~', () => {
      const html = render('*italic* ~~struck~~')
      expect(html).toContain('<em>italic</em>')
      expect(html).toContain('<del>struck</del>')
    })

    test('hyphenated content: ~~40-50 hours, 2-3 weeks~~', () => {
      expect(hasStrikethrough('~~40-50 hours, 2-3 weeks~~')).toBe(true)
      expect(getStruck('~~40-50 hours, 2-3 weeks~~')).toBe('40-50 hours, 2-3 weeks')
    })

    test('special chars: ~~$10k (maybe)~~', () => {
      expect(hasStrikethrough('~~$10k (maybe)~~')).toBe(true)
    })

    test('followed by closing paren', () => {
      expect(hasStrikethrough('(~~struck~~)')).toBe(true)
    })

    test('followed by slash', () => {
      expect(hasStrikethrough('~~struck~~/')).toBe(true)
    })
  })

  // ── Word-adjacent ~~ (allowed - matches GFM spec) ───────────────────

  describe('word-adjacent (allowed)', () => {
    test('word before opening: foo~~bar~~', () => {
      expect(hasStrikethrough('foo~~bar~~')).toBe(true)
      expect(getStruck('foo~~bar~~')).toBe('bar')
    })

    test('word after closing: ~~struck~~baz', () => {
      expect(hasStrikethrough('~~struck~~baz')).toBe(true)
      expect(getStruck('~~struck~~baz')).toBe('struck')
    })

    test('words on both sides: foo~~bar~~baz', () => {
      expect(hasStrikethrough('foo~~bar~~baz')).toBe(true)
      expect(getStruck('foo~~bar~~baz')).toBe('bar')
    })

    test('digit before: 5~~struck~~', () => {
      expect(hasStrikethrough('5~~struck~~')).toBe(true)
    })

    test('digit after: ~~struck~~5', () => {
      expect(hasStrikethrough('~~struck~~5')).toBe(true)
    })

    test('underscore before: _~~struck~~', () => {
      expect(hasStrikethrough('_~~struck~~')).toBe(true)
    })
  })

  // ── Should NOT render strikethrough ──────────────────────────────────

  describe('rejected - no strikethrough', () => {
    test('single tilde: ~hello~', () => {
      expect(hasStrikethrough('~hello~')).toBe(false)
    })

    test('triple tilde: ~~~hello~~~', () => {
      expect(hasStrikethrough('~~~hello~~~')).toBe(false)
    })

    test('content starts with space: ~~ spaced~~', () => {
      expect(hasStrikethrough('~~ spaced~~')).toBe(false)
    })

    test('content ends with space: ~~spaced ~~', () => {
      expect(hasStrikethrough('~~spaced ~~')).toBe(false)
    })

    test('only whitespace: ~~   ~~', () => {
      expect(hasStrikethrough('~~   ~~')).toBe(false)
    })

    test('unmatched opening: ~~hello', () => {
      expect(hasStrikethrough('~~hello')).toBe(false)
    })

    test('unmatched closing: hello~~', () => {
      expect(hasStrikethrough('hello~~')).toBe(false)
    })

    test('empty: ~~~~', () => {
      expect(hasStrikethrough('~~~~')).toBe(false)
    })

    test('home path: ~/foo', () => {
      expect(hasStrikethrough('~/foo')).toBe(false)
    })

    test('home path in text', () => {
      expect(hasStrikethrough('check ~/projects/foo for details')).toBe(false)
    })

    test('consecutive tildes: ~~~~text~~~~', () => {
      expect(hasStrikethrough('~~~~text~~~~')).toBe(false)
    })
  })

  // ── Max length protection ────────────────────────────────────────────

  describe('max length (200 chars)', () => {
    test('content at 200 chars matches', () => {
      const content = 'x'.repeat(200)
      expect(hasStrikethrough(`~~${content}~~`)).toBe(true)
    })

    test('content at 201 chars does NOT match', () => {
      const content = 'x'.repeat(201)
      expect(hasStrikethrough(`~~${content}~~`)).toBe(false)
    })

    test('realistic long-distance accident: ~~50..long text..~~40', () => {
      const filler = '.'.repeat(180)
      expect(hasStrikethrough(`~~50${filler} ~~40`)).toBe(false)
    })

    test('realistic long sentence is fine', () => {
      const sentence =
        '~~The pricing question for Mike is whether this fits under the existing retainer or needs a small separate SOW ($10k)~~'
      expect(hasStrikethrough(sentence)).toBe(true)
    })

    test('two prices far apart should NOT strike', () => {
      const text =
        'The cost was ~~50 per unit but we negotiated it down significantly over the course of several months of back and forth discussions with the vendor and their procurement team to finally arrive at a price of ~~40 per unit'
      expect(hasStrikethrough(text)).toBe(false)
    })
  })

  // ── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('inside inline code: `~~not struck~~`', () => {
      const html = render('`~~not struck~~`')
      expect(html).not.toContain('<del>')
      expect(html).toContain('~~not struck~~')
    })

    test('inside fenced code block', () => {
      const html = render('```\n~~not struck~~\n```')
      expect(html).not.toContain('<del>')
    })

    test('code inside del: del wraps the code span', () => {
      const html = render('~~has `code` inside~~')
      expect(html).toContain('<del>')
      expect(html).toContain('<code>code</code>')
    })

    test('mixed valid and invalid in same line', () => {
      const longFiller = 'x'.repeat(250)
      const html = render(`~~short~~ and ~~${longFiller}~~`)
      expect(html).toContain('<del>short</del>')
      // Long one exceeds 200 char limit
      expect((html.match(/<del>/g) || []).length).toBe(1)
    })

    test('escaped tildes render as literal', () => {
      const html = render('\\~\\~hello\\~\\~')
      expect(html).not.toContain('<del>')
      expect(html).toContain('~~hello~~')
    })

    test('url with tildes', () => {
      expect(hasStrikethrough('https://example.com/~~foo~~')).toBe(false)
    })

    test('multiline within paragraph', () => {
      expect(hasStrikethrough('~~line1\nline2~~')).toBe(true)
    })

    test('word-adjacent inside code blocks are untouched', () => {
      const html = render('```\nfoo~~bar~~\n```')
      expect(html).toContain('foo~~bar~~')
    })

    test('word-adjacent inside inline code are untouched', () => {
      const html = render('`foo~~bar~~`')
      expect(html).toContain('foo~~bar~~')
    })
  })
})
