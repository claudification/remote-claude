import { useVirtualizer } from '@tanstack/react-virtual'
import AnsiToHtml from 'ansi-to-html'
import {
	Bot,
	ChevronDown,
	ChevronRight,
	FileCode,
	FileSearch,
	FilePlus,
	FolderSearch,
	Globe,
	Pencil,
	Play,
	Search,
	Terminal,
	Zap,
} from 'lucide-react'
import { useRef, useState, useMemo } from 'react'
import type { TranscriptEntry, TranscriptContentBlock } from '@/lib/types'
import { cn, truncate } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

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

function AnsiText({ text }: { text: string }) {
	const html = useMemo(() => ansiConverter.toHtml(text), [text])
	return <span dangerouslySetInnerHTML={{ __html: html }} />
}

// Tool-specific styling - terminal aesthetic with Lucide icons
const TOOL_STYLES: Record<string, { color: string; Icon: LucideIcon }> = {
	Bash: { color: 'text-orange-400', Icon: Terminal },
	Read: { color: 'text-cyan-400', Icon: FileCode },
	Edit: { color: 'text-yellow-400', Icon: Pencil },
	Write: { color: 'text-green-400', Icon: FilePlus },
	Glob: { color: 'text-purple-400', Icon: FolderSearch },
	Grep: { color: 'text-purple-400', Icon: FileSearch },
	WebFetch: { color: 'text-blue-400', Icon: Globe },
	WebSearch: { color: 'text-blue-400', Icon: Search },
	Task: { color: 'text-pink-400', Icon: Bot },
	LSP: { color: 'text-indigo-400', Icon: Zap },
}

const DEFAULT_TOOL_STYLE = { color: 'text-event-tool', Icon: Play }

function getToolStyle(name: string) {
	return TOOL_STYLES[name] || DEFAULT_TOOL_STYLE
}

function Collapsible({
	label,
	defaultOpen = false,
	children,
}: {
	label: string
	defaultOpen?: boolean
	children: React.ReactNode
}) {
	const [open, setOpen] = useState(defaultOpen)
	return (
		<div className="mt-1">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex items-center gap-1 text-muted-foreground hover:text-foreground text-[10px] font-mono"
			>
				{open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
				{label}
			</button>
			{open && <div className="mt-1 ml-4">{children}</div>}
		</div>
	)
}

// Render a diff view for Edit operations
function DiffView({ patches }: { patches: Array<{ oldStart: number; lines: string[] }> }) {
	return (
		<pre className="text-[10px] font-mono overflow-x-auto">
			{patches.map((patch, i) => (
				<div key={i}>
					<div className="text-muted-foreground">@@ {patch.oldStart} @@</div>
					{patch.lines.map((line, j) => (
						<div
							key={j}
							className={cn(
								line.startsWith('+') && 'text-green-400 bg-green-500/10',
								line.startsWith('-') && 'text-red-400 bg-red-500/10',
								!line.startsWith('+') && !line.startsWith('-') && 'text-muted-foreground',
							)}
						>
							{line}
						</div>
					))}
				</div>
			))}
		</pre>
	)
}

// Compact tool display - one line summary with expandable details
function ToolLine({
	tool,
	result,
	toolUseResult,
}: {
	tool: TranscriptContentBlock
	result?: string
	toolUseResult?: Record<string, unknown>
}) {
	const name = tool.name || 'Tool'
	const input = tool.input || {}
	const style = getToolStyle(name)

	// Build one-line summary based on tool type
	let summary = ''
	let details: React.ReactNode = null

	switch (name) {
		case 'Bash': {
			const cmd = input.command as string
			summary = cmd?.length > 80 ? cmd.slice(0, 80) + '...' : cmd
			if (result) {
				details = (
					<pre className="text-[10px] bg-black/30 p-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono">
						<AnsiText text={truncate(result, 1500)} />
					</pre>
				)
			}
			break
		}
		case 'Read': {
			const path = input.file_path as string
			summary = path?.split('/').pop() || path
			break
		}
		case 'Edit': {
			const path = input.file_path as string
			summary = path?.split('/').pop() || path
			const patches = (toolUseResult as any)?.structuredPatch
			if (patches?.length) {
				details = <DiffView patches={patches} />
			}
			break
		}
		case 'Write': {
			const path = input.file_path as string
			const content = input.content as string
			summary = `${path?.split('/').pop()} (${content?.length || 0} chars)`
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
		case 'Task': {
			const desc = input.description as string
			const agent = input.subagent_type as string
			summary = `${agent}: ${desc}`
			break
		}
		default:
			summary = JSON.stringify(input).slice(0, 60)
	}

	const { Icon } = style

	return (
		<div className="font-mono text-xs">
			<div className="flex items-center gap-2">
				<span className={cn('w-20 shrink-0 flex items-center gap-1', style.color)}>
					<Icon className="w-3 h-3" />
					{name}
				</span>
				<span className="text-foreground/80 truncate">{summary}</span>
			</div>
			{details && <Collapsible label="output">{details}</Collapsible>}
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

// Group consecutive assistant entries (they often have multiple tool calls)
interface DisplayGroup {
	type: 'user' | 'assistant'
	timestamp: string
	entries: TranscriptEntry[]
}

function groupEntries(entries: TranscriptEntry[]): DisplayGroup[] {
	const groups: DisplayGroup[] = []
	let current: DisplayGroup | null = null

	for (const entry of entries) {
		// Only process user and assistant entries
		if (entry.type !== 'user' && entry.type !== 'assistant') continue

		const content = entry.message?.content
		if (!content) continue

		// Skip tool_result-only user entries (these are rendered with tool_use)
		if (entry.type === 'user' && Array.isArray(content)) {
			if (content.every(c => c.type === 'tool_result')) continue
		}

		// Skip empty string content
		if (typeof content === 'string' && !content.trim()) continue

		// Skip arrays with no displayable content
		if (Array.isArray(content)) {
			const hasContent = content.some(c =>
				(c.type === 'text' && c.text?.trim()) ||
				(c.type === 'thinking' && c.text?.trim()) ||
				c.type === 'tool_use'
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

function GroupView({
	group,
	resultMap,
}: {
	group: DisplayGroup
	resultMap: Map<string, { result: string; extra?: Record<string, unknown> }>
}) {
	const time = group.timestamp ? new Date(group.timestamp).toLocaleTimeString('en-US', { hour12: false }) : ''
	const isUser = group.type === 'user'

	// Collect all content from all entries in group
	const allText: string[] = []
	const allThinking: string[] = []
	const allTools: Array<{ tool: TranscriptContentBlock; result?: string; extra?: Record<string, unknown> }> = []
	const allImages: Array<{ hash: string; ext: string; url: string; originalPath: string }> = []

	for (const entry of group.entries) {
		// Collect images from entry
		if (entry.images) {
			allImages.push(...entry.images)
		}

		const content = entry.message?.content
		if (typeof content === 'string') {
			allText.push(content)
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === 'text' && block.text) {
					// Ensure text is a string
					const text = typeof block.text === 'string' ? block.text : JSON.stringify(block.text)
					if (text.trim()) allText.push(text)
				} else if (block.type === 'thinking' && block.text) {
					const text = typeof block.text === 'string' ? block.text : JSON.stringify(block.text)
					if (text.trim()) allThinking.push(text)
				} else if (block.type === 'tool_use') {
					const id = block.id
					const res = id ? resultMap.get(id) : undefined
					allTools.push({ tool: block, result: res?.result, extra: res?.extra })
				}
			}
		}
	}

	const label = isUser ? 'USER' : 'CLAUDE'
	const borderColor = isUser ? 'border-event-prompt' : 'border-primary'
	const labelBg = isUser ? 'bg-event-prompt text-background' : 'bg-primary text-primary-foreground'

	return (
		<div className="mb-4">
			{/* Single header for the group */}
			<div className="flex items-center gap-2 mb-2">
				<span className={cn('text-[10px]', borderColor)}>┌──</span>
				<span className={cn('px-2 py-0.5 text-[10px] font-bold', labelBg)}>{label}</span>
				<span className="text-muted-foreground text-[10px]">{time}</span>
				<span className={cn('flex-1 text-[10px] overflow-hidden', borderColor)}>{'─'.repeat(40)}</span>
			</div>

			{/* Content */}
			<div className="pl-4 space-y-2">
				{/* Thinking (collapsed by default) */}
				{allThinking.length > 0 && (
					<Collapsible label={`thinking (${allThinking.length})`}>
						<div className="text-muted-foreground/60 italic text-xs whitespace-pre-wrap">
							{truncate(allThinking.join('\n\n'), 500)}
						</div>
					</Collapsible>
				)}

				{/* Text content */}
				{allText.length > 0 && (
					<div className="text-sm whitespace-pre-wrap break-words">
						{allText.join('\n\n')}
					</div>
				)}

				{/* Images */}
				{allImages.length > 0 && (
					<div className="flex flex-wrap gap-2 pt-2">
						{allImages.map((img) => (
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
				)}

				{/* Tool calls - compact list */}
				{allTools.length > 0 && (
					<div className="space-y-1 pt-1">
						{allTools.map((t, i) => (
							<ToolLine key={i} tool={t.tool} result={t.result} toolUseResult={t.extra} />
						))}
					</div>
				)}
			</div>
		</div>
	)
}

interface TranscriptViewProps {
	entries: TranscriptEntry[]
	follow?: boolean
}

export function TranscriptView({ entries, follow = false }: TranscriptViewProps) {
	const parentRef = useRef<HTMLDivElement>(null)

	const resultMap = useMemo(() => buildResultMap(entries), [entries])
	const groups = useMemo(() => groupEntries(entries), [entries])

	const virtualizer = useVirtualizer({
		count: groups.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 150,
		overscan: 5,
	})

	const prevCountRef = useRef(groups.length)
	if (follow && groups.length > prevCountRef.current && parentRef.current) {
		virtualizer.scrollToIndex(groups.length - 1, { align: 'end' })
	}
	prevCountRef.current = groups.length

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
		<div ref={parentRef} className="h-full overflow-y-auto">
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
						<GroupView group={groups[virtualItem.index]} resultMap={resultMap} />
					</div>
				))}
			</div>
		</div>
	)
}
