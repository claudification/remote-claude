import { useRef, useState, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'

interface MarkdownInputProps {
	value: string
	onChange: (value: string) => void
	onSubmit: () => void
	disabled?: boolean
	placeholder?: string
	className?: string
}

const MOBILE_BREAKPOINT = 640 // sm breakpoint

function useIsMobile() {
	const [isMobile, setIsMobile] = useState(false)
	useEffect(() => {
		const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
		check()
		window.addEventListener('resize', check)
		return () => window.removeEventListener('resize', check)
	}, [])
	return isMobile
}

// Lightweight markdown syntax highlighter - colors syntax markers, not rendered output
function highlightMarkdown(text: string): string {
	if (!text) return '\n' // Need at least a newline for height matching

	// Escape HTML first
	let html = text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')

	// Fenced code blocks (``` ... ```) - fence markers + lang tag in bright cyan, content in dimmer cyan
	html = html.replace(/(```(\w*)\n?)([\s\S]*?)(```)/g,
		'<span class="text-cyan-300 font-bold">$1</span><span class="text-cyan-400/70">$3</span><span class="text-cyan-300 font-bold">$4</span>')

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
	const isMobile = useIsMobile()
	const [expanded, setExpanded] = useState(false)

	// Auto-resize textarea to fit content
	const autoResize = useCallback(() => {
		const textarea = textareaRef.current
		if (!textarea) return

		// Reset to auto to measure scrollHeight correctly
		textarea.style.height = 'auto'

		if (expanded) {
			// In expanded mode, fill available space (handled by flex)
			textarea.style.height = '100%'
			textarea.style.overflowY = 'auto'
			return
		}

		// Cap at 40vh
		const maxHeight = window.innerHeight * 0.4
		const newHeight = Math.min(textarea.scrollHeight, maxHeight)
		textarea.style.height = `${newHeight}px`

		// Enable scrolling when capped
		textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
	}, [expanded])

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

	// Lock body scroll when expanded
	useEffect(() => {
		if (!expanded) return
		const body = document.body
		const scrollY = window.scrollY
		const prev = {
			position: body.style.position,
			top: body.style.top,
			left: body.style.left,
			right: body.style.right,
			overflow: body.style.overflow,
		}
		body.style.position = 'fixed'
		body.style.top = `-${scrollY}px`
		body.style.left = '0'
		body.style.right = '0'
		body.style.overflow = 'hidden'
		return () => {
			body.style.position = prev.position
			body.style.top = prev.top
			body.style.left = prev.left
			body.style.right = prev.right
			body.style.overflow = prev.overflow
			window.scrollTo(0, scrollY)
		}
	}, [expanded])

	function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		// In expanded (mobile) mode: Enter = newline, no keyboard submit
		// In inline (desktop) mode: Enter = submit, Shift+Enter = newline
		if (!expanded && e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			handleSubmit()
		}
		// Escape collapses expanded mode
		if (e.key === 'Escape' && expanded) {
			e.preventDefault()
			setExpanded(false)
		}
	}

	function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
		onChange(e.target.value)
	}

	function handleFocus() {
		if (isMobile) {
			setExpanded(true)
		}
	}

	function handleSubmit() {
		onSubmit()
		if (expanded) {
			setExpanded(false)
		} else {
			// Re-focus on desktop after submit
			requestAnimationFrame(() => textareaRef.current?.focus())
		}
	}

	function handleCancel() {
		setExpanded(false)
		textareaRef.current?.blur()
	}

	const textClasses = expanded
		? 'font-mono whitespace-pre-wrap break-words'  // font-size set via inline style (rem broken by 13px root)
		: 'text-xs font-mono whitespace-pre-wrap break-words'

	// iOS auto-zooms inputs with font-size < 16px. Root is 13px so rem units are broken for this.
	const expandedFontSize = expanded ? { fontSize: '18px', lineHeight: '1.5' } : undefined

	// Expanded mobile compose mode
	if (expanded) {
		return (
			<div className="fixed inset-x-0 top-0 z-50 flex flex-col bg-background" style={{ touchAction: 'manipulation', height: '100dvh' }}>
				{/* Header bar */}
				<div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border">
					<button
						type="button"
						onClick={handleCancel}
						className="text-xs text-muted-foreground px-2 py-1"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleSubmit}
						disabled={disabled || !value.trim()}
						className={cn(
							'text-sm font-bold px-4 py-1.5 rounded',
							value.trim()
								? 'bg-accent text-accent-foreground'
								: 'bg-muted text-muted-foreground',
						)}
					>
						Send
					</button>
				</div>
				{/* Editor area */}
				<div className="relative flex-1 min-h-0">
					{/* Highlight layer */}
					<div
						ref={highlightRef}
						className={cn(
							'absolute inset-0 px-3 py-3 pointer-events-none overflow-auto',
							textClasses,
							'text-foreground',
						)}
						style={expandedFontSize}
						aria-hidden="true"
						dangerouslySetInnerHTML={{ __html: highlightMarkdown(value) }}
					/>
					{/* Textarea */}
					<textarea
						ref={textareaRef}
						value={value}
						onChange={handleInput}
						onKeyDown={handleKeyDown}
						onScroll={syncScroll}
						disabled={disabled}
						placeholder={placeholder}
						autoFocus
						className={cn(
							'absolute inset-0 w-full h-full bg-transparent px-3 py-3 resize-none',
							textClasses,
							'text-transparent caret-foreground selection:bg-accent/30 selection:text-foreground',
							'focus:outline-none',
							'placeholder:text-muted-foreground',
						)}
						style={expandedFontSize}
					/>
				</div>
			</div>
		)
	}

	// Normal inline mode
	return (
		<div ref={containerRef} className={cn('relative', className)}>
			{/* Highlight layer - renders colored markdown behind textarea */}
			<div
				ref={highlightRef}
				className={cn(
					'absolute inset-0 px-3 py-2 pointer-events-none',
					textClasses,
					'overflow-hidden text-foreground',
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
				onFocus={handleFocus}
				onScroll={syncScroll}
				disabled={disabled}
				placeholder={placeholder}
				rows={1}
				className={cn(
					'relative w-full bg-transparent border border-border rounded px-3 py-2 resize-none',
					textClasses,
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
