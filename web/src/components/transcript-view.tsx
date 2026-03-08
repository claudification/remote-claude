import { useVirtualizer } from '@tanstack/react-virtual'
import AnsiToHtml from 'ansi-to-html'
import {
	Bot,
	Bookmark,
	ChevronDown,
	ChevronRight,
	CircleCheck,
	CircleHelp,
	CircleStop,
	ClipboardList,
	FileCode,
	FileSearch,
	FilePlus,
	FolderSearch,
	Globe,
	ListTodo,
	Route,
	Notebook,
	Pencil,
	Play,
	Plug,
	Search,
	ScrollText,
	Sparkles,
	Terminal,
	Users,
	Zap,
} from 'lucide-react'
import { useEffect, useRef, useState, useMemo } from 'react'
import type { TranscriptEntry, TranscriptContentBlock } from '@/lib/types'
import { cn, truncate } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
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

function AnsiText({ text }: { text: string }) {
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
}

const DEFAULT_TOOL_STYLE = { color: 'text-event-tool', Icon: Play }
const MCP_TOOL_STYLE = { color: 'text-teal-400', Icon: Plug }

function getToolStyle(name: string) {
	return TOOL_STYLES[name] || (name.startsWith('mcp__') ? MCP_TOOL_STYLE : DEFAULT_TOOL_STYLE)
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
		case 'Task':
		case 'Agent': {
			const desc = input.description as string
			const agent = input.subagent_type as string
			const prompt = input.prompt as string
			summary = agent ? `${agent}: ${desc}` : desc
			if (prompt) {
				details = (
					<pre className="text-[10px] text-muted-foreground max-h-32 overflow-auto whitespace-pre-wrap">
						{truncate(prompt, 2000)}
					</pre>
				)
			}
			break
		}
		case 'AskUserQuestion': {
			const questions = input.questions as Array<{ question: string; header?: string; options?: Array<{ label: string }> }>
			if (questions?.length) {
				const q0 = questions[0].question
				summary = q0.length > 60 ? q0.slice(0, 60) + '...' : q0
				details = (
					<div className="text-[10px] font-mono space-y-1 mt-1">
						{questions.map((q, qi) => (
							<div key={qi}>
								{q.header && <span className="text-amber-400/70">[{q.header}] </span>}
								<span className="text-foreground/80">{q.question}</span>
								{q.options && (
									<div className="ml-2 text-muted-foreground">
										{q.options.map((o, oi) => (
											<div key={oi} className="text-amber-400/50">{'>'} {o.label}</div>
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
			summary = desc?.length > 60 ? desc.slice(0, 60) + '...' : desc
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
					<pre className="text-[10px] text-muted-foreground max-h-24 overflow-auto">
						{truncate(result, 500)}
					</pre>
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
			summary = msg?.length > 60 ? msg.slice(0, 60) + '...' : msg
			break
		}
		case 'TeamCreate':
		case 'TeamDelete': {
			const teamName = input.name as string
			summary = teamName || ''
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
				<JsonInspector
					title={name}
					data={input}
					result={result}
					extra={toolUseResult}
				/>
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
				(c.type === 'thinking' && (c.thinking?.trim() || c.text?.trim())) ||
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
	showThinking = false,
}: {
	group: DisplayGroup
	resultMap: Map<string, { result: string; extra?: Record<string, unknown> }>
	showThinking?: boolean
}) {
	const time = group.timestamp ? new Date(group.timestamp).toLocaleTimeString('en-US', { hour12: false }) : ''
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

			{/* Content - rendered in chronological order */}
			<div className="pl-4 space-y-2">
				{items.map((item, i) => {
					switch (item.kind) {
						case 'thinking':
							if (!showThinking) return null
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
									{item.images.map((img) => (
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
							return <ToolLine key={i} tool={item.tool} result={item.result} toolUseResult={item.extra} />
					}
				})}
			</div>
		</div>
	)
}

interface TranscriptViewProps {
	entries: TranscriptEntry[]
	follow?: boolean
	showThinking?: boolean
}

export function TranscriptView({ entries, follow = false, showThinking = false }: TranscriptViewProps) {
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

	// Scroll to end when follow is enabled and new items arrive (or on initial load)
	useEffect(() => {
		if (!follow || groups.length === 0) return
		// Scroll on initial load or when new groups arrive
		if (groups.length !== prevCountRef.current || prevCountRef.current === 0) {
			// Small delay to let virtualizer measure
			requestAnimationFrame(() => {
				virtualizer.scrollToIndex(groups.length - 1, { align: 'end' })
			})
		}
		prevCountRef.current = groups.length
	}, [follow, groups.length, virtualizer])

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
		<div ref={parentRef} className="h-full overflow-y-auto p-3 sm:p-4">
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
						<GroupView group={groups[virtualItem.index]} resultMap={resultMap} showThinking={showThinking} />
					</div>
				))}
			</div>
		</div>
	)
}
