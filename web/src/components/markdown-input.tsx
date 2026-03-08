import { useRef, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'

interface MarkdownInputProps {
	value: string
	onChange: (value: string) => void
	onSubmit: () => void
	disabled?: boolean
	placeholder?: string
	className?: string
}

// Lightweight markdown syntax highlighter - colors syntax markers, not rendered output
function highlightMarkdown(text: string): string {
	if (!text) return '\n' // Need at least a newline for height matching

	// Escape HTML first
	let html = text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')

	// Fenced code blocks (``` ... ```)
	html = html.replace(/(```[\s\S]*?```)/g, '<span class="text-cyan-400">$1</span>')

	// Inline code (`...`)
	html = html.replace(/(`[^`\n]+`)/g, '<span class="text-cyan-400">$1</span>')

	// Bold (**...**)
	html = html.replace(/(\*\*[^*]+\*\*)/g, '<span class="text-foreground font-bold">$1</span>')

	// Italic (*...* or _..._) - avoid matching ** or __
	html = html.replace(/(?<!\*)(\*[^*\n]+\*)(?!\*)/g, '<span class="text-foreground/70 italic">$1</span>')
	html = html.replace(/(?<!_)(_[^_\n]+_)(?!_)/g, '<span class="text-foreground/70 italic">$1</span>')

	// Headings (# at start of line)
	html = html.replace(/^(#{1,6}\s.*)$/gm, '<span class="text-accent font-bold">$1</span>')

	// Blockquotes (> at start of line)
	html = html.replace(/^(&gt;\s?.*)$/gm, '<span class="text-muted-foreground">$1</span>')

	// List items (- or * at start of line)
	html = html.replace(/^(\s*[-*]\s)/gm, '<span class="text-muted-foreground">$1</span>')

	// Links [text](url)
	html = html.replace(/(\[[^\]]*\]\([^)]*\))/g, '<span class="text-accent underline">$1</span>')

	// Ensure trailing newline for height matching
	if (!html.endsWith('\n')) html += '\n'

	return html
}

export function MarkdownInput({ value, onChange, onSubmit, disabled, placeholder, className }: MarkdownInputProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	const highlightRef = useRef<HTMLDivElement>(null)
	const containerRef = useRef<HTMLDivElement>(null)

	// Auto-resize textarea to fit content
	const autoResize = useCallback(() => {
		const textarea = textareaRef.current
		if (!textarea) return

		// Reset to auto to measure scrollHeight correctly
		textarea.style.height = 'auto'
		// Cap at 40vh
		const maxHeight = window.innerHeight * 0.4
		const newHeight = Math.min(textarea.scrollHeight, maxHeight)
		textarea.style.height = `${newHeight}px`

		// Enable scrolling when capped
		textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
	}, [])

	// Sync scroll between textarea and highlight div
	const syncScroll = useCallback(() => {
		if (textareaRef.current && highlightRef.current) {
			highlightRef.current.scrollTop = textareaRef.current.scrollTop
			highlightRef.current.scrollLeft = textareaRef.current.scrollLeft
		}
	}, [])

	// Resize on value change
	useEffect(() => {
		autoResize()
	}, [value, autoResize])

	// Resize on window resize
	useEffect(() => {
		window.addEventListener('resize', autoResize)
		return () => window.removeEventListener('resize', autoResize)
	}, [autoResize])

	function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			onSubmit()
		}
		// Shift+Enter = normal newline (default textarea behavior)
	}

	function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
		onChange(e.target.value)
	}

	return (
		<div ref={containerRef} className={cn('relative', className)}>
			{/* Highlight layer - renders colored markdown behind textarea */}
			<div
				ref={highlightRef}
				className={cn(
					'absolute inset-0 px-3 py-2 pointer-events-none',
					'text-xs font-mono whitespace-pre-wrap break-words overflow-hidden',
					'text-foreground',
				)}
				aria-hidden="true"
				dangerouslySetInnerHTML={{ __html: highlightMarkdown(value) }}
			/>
			{/* Textarea - transparent text, visible caret */}
			<textarea
				ref={textareaRef}
				value={value}
				onChange={handleInput}
				onKeyDown={handleKeyDown}
				onScroll={syncScroll}
				disabled={disabled}
				placeholder={placeholder}
				rows={1}
				className={cn(
					'relative w-full bg-transparent border border-border rounded px-3 py-2 resize-none',
					'text-xs font-mono whitespace-pre-wrap break-words',
					'text-transparent caret-foreground selection:bg-accent/30 selection:text-foreground',
					'focus:outline-none focus:ring-1 focus:ring-ring',
					'placeholder:text-muted-foreground',
					'disabled:opacity-50',
				)}
				style={{ minHeight: '2.25rem' }}
			/>
		</div>
	)
}
