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
import { markedHighlight } from 'marked-highlight'
import { useMemo } from 'react'

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

// Create marked instance with syntax highlighting
const marked = new Marked(
	markedHighlight({
		emptyLangClass: 'hljs',
		langPrefix: 'hljs language-',
		highlight(code, lang) {
			if (lang && hljs.getLanguage(lang)) {
				try {
					return hljs.highlight(code, { language: lang }).value
				} catch {
					// Fall through to auto-detect
				}
			}
			// Auto-detect language
			try {
				return hljs.highlightAuto(code).value
			} catch {
				return code
			}
		},
	}),
)

// Configure marked options
marked.setOptions({
	gfm: true,
	breaks: true,
})

interface MarkdownProps {
	children: string
}

export function Markdown({ children }: MarkdownProps) {
	const html = useMemo(() => {
		return marked.parse(children) as string
	}, [children])

	return <div className="prose-hacker" dangerouslySetInnerHTML={{ __html: html }} />
}
