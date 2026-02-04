import type { TranscriptEntry } from '@/lib/types'
import { truncate } from '@/lib/utils'
import { Markdown } from './markdown'

function hasDisplayableContent(entry: TranscriptEntry): boolean {
	const content = entry.message?.content
	if (!content) return false
	if (typeof content === 'string') return content.trim().length > 0

	// Check for text, tool_use, or thinking blocks with content
	return content.some(
		c =>
			(c.type === 'text' && c.text?.trim()) ||
			c.type === 'tool_use' ||
			(c.type === 'thinking' && c.text?.trim()),
	)
}

function renderContent(entry: TranscriptEntry, isAssistant: boolean) {
	const content = entry.message?.content
	if (!content) return null

	if (typeof content === 'string') {
		return isAssistant ? (
			<Markdown>{content}</Markdown>
		) : (
			<div className="whitespace-pre-wrap break-words">{content}</div>
		)
	}

	const textParts = content.filter(c => c.type === 'text' && c.text?.trim()).map(c => c.text)
	const thinkingParts = content.filter(c => c.type === 'thinking' && c.text?.trim()).map(c => c.text)
	const toolUses = content.filter(c => c.type === 'tool_use')

	return (
		<>
			{/* Show thinking content if present */}
			{thinkingParts.length > 0 && (
				<div className="mb-2 text-muted-foreground/70 italic border-l-2 border-muted pl-3 text-xs">
					<span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">thinking</span>
					<div className="mt-1 whitespace-pre-wrap">{truncate(thinkingParts.join('\n'), 500)}</div>
				</div>
			)}
			{textParts.length > 0 &&
				(isAssistant ? (
					<Markdown>{textParts.join('\n')}</Markdown>
				) : (
					<div className="whitespace-pre-wrap break-words">{textParts.join('\n')}</div>
				))}
			{toolUses.map((tool, i) => (
				<div key={i} className="mt-3 border border-event-tool/30 bg-event-tool/5">
					<div className="flex items-center gap-2 px-2 py-1 bg-event-tool/20 border-b border-event-tool/30">
						<span className="text-event-tool text-[10px]">►</span>
						<span className="text-event-tool font-bold text-xs">{tool.name}</span>
					</div>
					{tool.input && (
						<pre className="text-[10px] p-2 text-muted-foreground overflow-x-auto max-h-32 overflow-y-auto">
							{truncate(JSON.stringify(tool.input, null, 2), 300)}
						</pre>
					)}
				</div>
			))}
		</>
	)
}

export function TranscriptItem({ entry }: { entry: TranscriptEntry }) {
	const type = entry.type
	const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false }) : ''
	const isAssistant = type === 'assistant'

	// Skip entries with no displayable content
	if (!hasDisplayableContent(entry)) return null

	if (isAssistant) {
		return (
			<div className="mb-3">
				{/* Header */}
				<div className="flex items-center gap-2 mb-1">
					<span className="text-primary text-[10px]">┌──</span>
					<span className="bg-primary text-primary-foreground px-2 py-0.5 text-[10px] font-bold">CLAUDE</span>
					<span className="text-muted-foreground text-[10px]">{timestamp}</span>
					<span className="flex-1 text-primary text-[10px] overflow-hidden whitespace-nowrap">{'─'.repeat(50)}</span>
				</div>
				{/* Content */}
				<div className="pl-4 border-l-2 border-primary/50 text-sm">{renderContent(entry, true)}</div>
			</div>
		)
	}

	if (type === 'user') {
		return (
			<div className="mb-3">
				{/* Header */}
				<div className="flex items-center gap-2 mb-1">
					<span className="text-event-prompt text-[10px]">┌──</span>
					<span className="bg-event-prompt text-background px-2 py-0.5 text-[10px] font-bold">USER</span>
					<span className="text-muted-foreground text-[10px]">{timestamp}</span>
					<span className="flex-1 text-event-prompt text-[10px] overflow-hidden whitespace-nowrap">
						{'─'.repeat(50)}
					</span>
				</div>
				{/* Content */}
				<div className="pl-4 border-l-2 border-event-prompt/50 text-sm text-event-prompt/90">
					{renderContent(entry, false)}
				</div>
			</div>
		)
	}

	return null
}

export function TranscriptView({ entries }: { entries: TranscriptEntry[] }) {
	const filtered = entries.filter(e => e.type === 'assistant' || e.type === 'user')

	if (filtered.length === 0) {
		return (
			<div className="text-muted-foreground text-center py-10">
				<pre className="text-xs">
					{`
┌─────────────────────────┐
│                         │
│   [ NO TRANSCRIPT ]     │
│                         │
│   Waiting for data...   │
│   _                     │
│                         │
└─────────────────────────┘
`.trim()}
				</pre>
			</div>
		)
	}

	return (
		<div className="space-y-1">
			{filtered.map((entry, i) => (
				<TranscriptItem key={i} entry={entry} />
			))}
		</div>
	)
}
