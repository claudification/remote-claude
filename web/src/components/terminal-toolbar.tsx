import { useState } from 'react'
import { cn } from '@/lib/utils'

interface TerminalToolbarProps {
	onSend: (data: string) => void
}

interface ShortcutButton {
	label: string
	data: string
	title?: string
}

const PRIMARY_SHORTCUTS: ShortcutButton[] = [
	{ label: '^C', data: '\x03', title: 'Interrupt (Ctrl+C)' },
	{ label: 'Esc', data: '\x1b', title: 'Escape' },
	{ label: 'Tab', data: '\t', title: 'Tab' },
	{ label: '\u2191', data: '\x1b[A', title: 'Up arrow' },
	{ label: '\u2193', data: '\x1b[B', title: 'Down arrow' },
	{ label: '\u21B5', data: '\r', title: 'Enter' },
]

const CLAUDE_SHORTCUTS: ShortcutButton[] = [
	{ label: '^B bg', data: '\x02', title: 'Background task (Ctrl+B)' },
	{ label: '^R search', data: '\x12', title: 'Search history (Ctrl+R)' },
	{ label: '^T todo', data: '\x14', title: 'Todo list (Ctrl+T)' },
	{ label: '^O transcript', data: '\x0f', title: 'Open transcript (Ctrl+O)' },
	{ label: 'M-p model', data: '\x1bp', title: 'Switch model (Alt+P)' },
	{ label: 'M-o fast', data: '\x1bo', title: 'Toggle fast mode (Alt+O)' },
]

type Modifier = 'ctrl' | 'alt' | 'meta'

export function TerminalToolbar({ onSend }: TerminalToolbarProps) {
	const [showClaude, setShowClaude] = useState(false)
	const [activeModifier, setActiveModifier] = useState<Modifier | null>(null)

	function handleShortcut(data: string) {
		onSend(data)
	}

	function handleModifier(mod: Modifier) {
		setActiveModifier(prev => (prev === mod ? null : mod))
	}

	function handleKey(key: string) {
		if (!activeModifier) return

		let data: string
		switch (activeModifier) {
			case 'ctrl':
				// Ctrl+key: subtract 0x60 from lowercase letter
				data = String.fromCharCode(key.toLowerCase().charCodeAt(0) - 0x60)
				break
			case 'alt':
				data = `\x1b${key}`
				break
			case 'meta':
				data = `\x1b${key}`
				break
			default:
				return
		}
		onSend(data)
		setActiveModifier(null)
	}

	return (
		<div className="shrink-0 border-t border-border bg-background/95 select-none" style={{ touchAction: 'manipulation' }}>
			{/* Primary shortcuts */}
			<div className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto">
				{PRIMARY_SHORTCUTS.map(btn => (
					<button
						key={btn.label}
						type="button"
						onClick={() => handleShortcut(btn.data)}
						title={btn.title}
						className={cn(
							'px-2.5 py-1.5 text-xs font-mono rounded',
							'bg-muted/50 border border-border text-foreground',
							'hover:bg-muted active:bg-accent/20 active:border-accent/50',
							'transition-colors whitespace-nowrap',
						)}
					>
						{btn.label}
					</button>
				))}

				<div className="w-px h-5 bg-border mx-1" />

				{/* Modifier locks */}
				{(['ctrl', 'alt', 'meta'] as Modifier[]).map(mod => (
					<button
						key={mod}
						type="button"
						onClick={() => handleModifier(mod)}
						className={cn(
							'px-2 py-1.5 text-[10px] font-mono rounded uppercase',
							'border transition-colors whitespace-nowrap',
							activeModifier === mod
								? 'bg-accent/20 border-accent text-accent'
								: 'bg-muted/50 border-border text-muted-foreground hover:text-foreground',
						)}
					>
						{mod}
					</button>
				))}

				<div className="w-px h-5 bg-border mx-1" />

				<button
					type="button"
					onClick={() => setShowClaude(!showClaude)}
					className={cn(
						'px-2 py-1.5 text-[10px] font-mono rounded',
						'border transition-colors whitespace-nowrap',
						showClaude
							? 'bg-accent/20 border-accent text-accent'
							: 'bg-muted/50 border-border text-muted-foreground hover:text-foreground',
					)}
				>
					CC
				</button>
			</div>

			{/* Modifier key input - shown when a modifier is locked */}
			{activeModifier && (
				<div className="flex items-center gap-1 px-2 pb-1.5 overflow-x-auto">
					<span className="text-[10px] text-accent font-mono mr-1">{activeModifier.toUpperCase()}+</span>
					{'abcdefghijklmnopqrstuvwxyz'.split('').map(key => (
						<button
							key={key}
							type="button"
							onClick={() => handleKey(key)}
							className={cn(
								'w-7 h-7 text-xs font-mono rounded',
								'bg-muted/50 border border-border text-foreground',
								'hover:bg-muted active:bg-accent/20',
								'transition-colors',
							)}
						>
							{key}
						</button>
					))}
				</div>
			)}

			{/* Claude Code shortcuts */}
			{showClaude && (
				<div className="flex items-center gap-1 px-2 pb-1.5 overflow-x-auto">
					{CLAUDE_SHORTCUTS.map(btn => (
						<button
							key={btn.label}
							type="button"
							onClick={() => handleShortcut(btn.data)}
							title={btn.title}
							className={cn(
								'px-2.5 py-1.5 text-[10px] font-mono rounded',
								'bg-muted/50 border border-border text-foreground',
								'hover:bg-muted active:bg-accent/20 active:border-accent/50',
								'transition-colors whitespace-nowrap',
							)}
						>
							{btn.label}
						</button>
					))}
				</div>
			)}
		</div>
	)
}
