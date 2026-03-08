import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TerminalTheme {
	name: string
	background: string
	foreground: string
	cursor: string
	cursorAccent: string
	selectionBackground: string
	selectionForeground?: string
	black: string
	red: string
	green: string
	yellow: string
	blue: string
	magenta: string
	cyan: string
	white: string
	brightBlack: string
	brightRed: string
	brightGreen: string
	brightYellow: string
	brightBlue: string
	brightMagenta: string
	brightCyan: string
	brightWhite: string
}

export const THEMES: Record<string, TerminalTheme> = {
	'tokyo-night': {
		name: 'Tokyo Night',
		background: '#1a1b26',
		foreground: '#a9b1d6',
		cursor: '#c0caf5',
		cursorAccent: '#1a1b26',
		selectionBackground: '#33467c',
		selectionForeground: '#c0caf5',
		black: '#15161e',
		red: '#f7768e',
		green: '#9ece6a',
		yellow: '#e0af68',
		blue: '#7aa2f7',
		magenta: '#bb9af7',
		cyan: '#7dcfff',
		white: '#a9b1d6',
		brightBlack: '#414868',
		brightRed: '#f7768e',
		brightGreen: '#9ece6a',
		brightYellow: '#e0af68',
		brightBlue: '#7aa2f7',
		brightMagenta: '#bb9af7',
		brightCyan: '#7dcfff',
		brightWhite: '#c0caf5',
	},
	dracula: {
		name: 'Dracula',
		background: '#282a36',
		foreground: '#f8f8f2',
		cursor: '#f8f8f2',
		cursorAccent: '#282a36',
		selectionBackground: '#44475a',
		black: '#21222c',
		red: '#ff5555',
		green: '#50fa7b',
		yellow: '#f1fa8c',
		blue: '#bd93f9',
		magenta: '#ff79c6',
		cyan: '#8be9fd',
		white: '#f8f8f2',
		brightBlack: '#6272a4',
		brightRed: '#ff6e6e',
		brightGreen: '#69ff94',
		brightYellow: '#ffffa5',
		brightBlue: '#d6acff',
		brightMagenta: '#ff92df',
		brightCyan: '#a4ffff',
		brightWhite: '#ffffff',
	},
	monokai: {
		name: 'Monokai',
		background: '#272822',
		foreground: '#f8f8f2',
		cursor: '#f8f8f0',
		cursorAccent: '#272822',
		selectionBackground: '#49483e',
		black: '#272822',
		red: '#f92672',
		green: '#a6e22e',
		yellow: '#f4bf75',
		blue: '#66d9ef',
		magenta: '#ae81ff',
		cyan: '#a1efe4',
		white: '#f8f8f2',
		brightBlack: '#75715e',
		brightRed: '#f92672',
		brightGreen: '#a6e22e',
		brightYellow: '#f4bf75',
		brightBlue: '#66d9ef',
		brightMagenta: '#ae81ff',
		brightCyan: '#a1efe4',
		brightWhite: '#f9f8f5',
	},
	'gruvbox-dark': {
		name: 'Gruvbox Dark',
		background: '#282828',
		foreground: '#ebdbb2',
		cursor: '#ebdbb2',
		cursorAccent: '#282828',
		selectionBackground: '#504945',
		black: '#282828',
		red: '#cc241d',
		green: '#98971a',
		yellow: '#d79921',
		blue: '#458588',
		magenta: '#b16286',
		cyan: '#689d6a',
		white: '#a89984',
		brightBlack: '#928374',
		brightRed: '#fb4934',
		brightGreen: '#b8bb26',
		brightYellow: '#fabd2f',
		brightBlue: '#83a598',
		brightMagenta: '#d3869b',
		brightCyan: '#8ec07c',
		brightWhite: '#ebdbb2',
	},
	nord: {
		name: 'Nord',
		background: '#2e3440',
		foreground: '#d8dee9',
		cursor: '#d8dee9',
		cursorAccent: '#2e3440',
		selectionBackground: '#434c5e',
		black: '#3b4252',
		red: '#bf616a',
		green: '#a3be8c',
		yellow: '#ebcb8b',
		blue: '#81a1c1',
		magenta: '#b48ead',
		cyan: '#88c0d0',
		white: '#e5e9f0',
		brightBlack: '#4c566a',
		brightRed: '#bf616a',
		brightGreen: '#a3be8c',
		brightYellow: '#ebcb8b',
		brightBlue: '#81a1c1',
		brightMagenta: '#b48ead',
		brightCyan: '#8be5fd',
		brightWhite: '#eceff4',
	},
	'catppuccin-mocha': {
		name: 'Catppuccin Mocha',
		background: '#1e1e2e',
		foreground: '#cdd6f4',
		cursor: '#f5e0dc',
		cursorAccent: '#1e1e2e',
		selectionBackground: '#45475a',
		black: '#45475a',
		red: '#f38ba8',
		green: '#a6e3a1',
		yellow: '#f9e2af',
		blue: '#89b4fa',
		magenta: '#f5c2e7',
		cyan: '#94e2d5',
		white: '#bac2de',
		brightBlack: '#585b70',
		brightRed: '#f38ba8',
		brightGreen: '#a6e3a1',
		brightYellow: '#f9e2af',
		brightBlue: '#89b4fa',
		brightMagenta: '#f5c2e7',
		brightCyan: '#94e2d5',
		brightWhite: '#a6adc8',
	},
	'solarized-dark': {
		name: 'Solarized Dark',
		background: '#002b36',
		foreground: '#839496',
		cursor: '#839496',
		cursorAccent: '#002b36',
		selectionBackground: '#073642',
		black: '#073642',
		red: '#dc322f',
		green: '#859900',
		yellow: '#b58900',
		blue: '#268bd2',
		magenta: '#d33682',
		cyan: '#2aa198',
		white: '#eee8d5',
		brightBlack: '#586e75',
		brightRed: '#cb4b16',
		brightGreen: '#586e75',
		brightYellow: '#657b83',
		brightBlue: '#839496',
		brightMagenta: '#6c71c4',
		brightCyan: '#93a1a1',
		brightWhite: '#fdf6e3',
	},
	'one-dark': {
		name: 'One Dark',
		background: '#282c34',
		foreground: '#abb2bf',
		cursor: '#528bff',
		cursorAccent: '#282c34',
		selectionBackground: '#3e4451',
		black: '#282c34',
		red: '#e06c75',
		green: '#98c379',
		yellow: '#e5c07b',
		blue: '#61afef',
		magenta: '#c678dd',
		cyan: '#56b6c2',
		white: '#abb2bf',
		brightBlack: '#5c6370',
		brightRed: '#e06c75',
		brightGreen: '#98c379',
		brightYellow: '#e5c07b',
		brightBlue: '#61afef',
		brightMagenta: '#c678dd',
		brightCyan: '#56b6c2',
		brightWhite: '#ffffff',
	},
	phosphor: {
		name: 'Phosphor',
		background: '#0a0a0a',
		foreground: '#00ff00',
		cursor: '#00ff00',
		cursorAccent: '#0a0a0a',
		selectionBackground: '#003300',
		black: '#0a0a0a',
		red: '#ff0000',
		green: '#00ff00',
		yellow: '#ffff00',
		blue: '#0066ff',
		magenta: '#ff00ff',
		cyan: '#00ffff',
		white: '#00ff00',
		brightBlack: '#006600',
		brightRed: '#ff3333',
		brightGreen: '#33ff33',
		brightYellow: '#ffff33',
		brightBlue: '#3399ff',
		brightMagenta: '#ff33ff',
		brightCyan: '#33ffff',
		brightWhite: '#66ff66',
	},
}

export const FONTS = [
	{ id: 'geist-mono', name: 'Geist Mono', family: '"Geist Mono", monospace' },
	{ id: 'jetbrains', name: 'JetBrains Mono', family: '"JetBrains Mono", monospace' },
	{ id: 'fira-code', name: 'Fira Code', family: '"Fira Code", monospace' },
	{ id: 'cascadia', name: 'Cascadia Code', family: '"Cascadia Code", monospace' },
	{ id: 'source-code', name: 'Source Code Pro', family: '"Source Code Pro", monospace' },
	{ id: 'ibm-plex', name: 'IBM Plex Mono', family: '"IBM Plex Mono", monospace' },
	{ id: 'hack', name: 'Hack', family: '"Hack", monospace' },
	{ id: 'menlo', name: 'Menlo', family: '"Menlo", "Monaco", monospace' },
	{ id: 'system', name: 'System Mono', family: 'ui-monospace, monospace' },
]

export const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20]

const STORAGE_KEY = 'rclaude-terminal-settings'

export interface TerminalSettings {
	themeId: string
	fontId: string
	fontSize: number
}

const DEFAULTS: TerminalSettings = {
	themeId: 'tokyo-night',
	fontId: 'geist-mono',
	fontSize: 14,
}

export function loadTerminalSettings(): TerminalSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY)
		if (!raw) return DEFAULTS
		const parsed = JSON.parse(raw)
		return {
			themeId: parsed.themeId && THEMES[parsed.themeId] ? parsed.themeId : DEFAULTS.themeId,
			fontId: parsed.fontId && FONTS.find(f => f.id === parsed.fontId) ? parsed.fontId : DEFAULTS.fontId,
			fontSize: FONT_SIZES.includes(parsed.fontSize) ? parsed.fontSize : DEFAULTS.fontSize,
		}
	} catch {
		return DEFAULTS
	}
}

export function saveTerminalSettings(settings: TerminalSettings) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function getTheme(id: string): TerminalTheme {
	return THEMES[id] || THEMES['tokyo-night']
}

export function getFont(id: string) {
	return FONTS.find(f => f.id === id) || FONTS[0]
}

interface TerminalSettingsPanelProps {
	settings: TerminalSettings
	onChange: (settings: TerminalSettings) => void
	onClose: () => void
}

export function TerminalSettingsPanel({ settings, onChange, onClose }: TerminalSettingsPanelProps) {
	const [local, setLocal] = useState(settings)

	function update(patch: Partial<TerminalSettings>) {
		const next = { ...local, ...patch }
		setLocal(next)
		saveTerminalSettings(next)
		onChange(next)
	}

	return (
		<div className="absolute top-10 right-2 z-50 w-72 bg-[#16161e] border border-[#33467c] shadow-2xl font-mono text-xs">
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2 border-b border-[#33467c]">
				<span className="text-[10px] uppercase tracking-wider text-[#565f89]">Terminal Settings</span>
				<button type="button" onClick={onClose} className="text-[#565f89] hover:text-[#a9b1d6]">
					<X className="w-3.5 h-3.5" />
				</button>
			</div>

			{/* Theme */}
			<div className="px-3 py-2 border-b border-[#33467c]/50">
				<div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Theme</div>
				<div className="grid grid-cols-3 gap-1">
					{Object.entries(THEMES).map(([id, theme]) => (
						<button
							key={id}
							type="button"
							onClick={() => update({ themeId: id })}
							className={cn(
								'px-1.5 py-1.5 text-[10px] rounded border transition-colors text-left',
								local.themeId === id
									? 'border-[#7aa2f7] text-[#c0caf5]'
									: 'border-transparent text-[#565f89] hover:text-[#a9b1d6] hover:border-[#33467c]',
							)}
						>
							<div className="flex items-center gap-1.5 mb-1">
								<div
									className="w-3 h-3 rounded-sm border border-white/10"
									style={{ background: theme.background }}
								>
									<div className="w-full h-full flex items-center justify-center">
										<div className="w-1.5 h-0.5 rounded-full" style={{ background: theme.green }} />
									</div>
								</div>
								<span className="truncate">{theme.name}</span>
							</div>
						</button>
					))}
				</div>
			</div>

			{/* Font */}
			<div className="px-3 py-2 border-b border-[#33467c]/50">
				<div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Font</div>
				<div className="space-y-0.5">
					{FONTS.map(font => (
						<button
							key={font.id}
							type="button"
							onClick={() => update({ fontId: font.id })}
							className={cn(
								'w-full px-2 py-1 text-left rounded transition-colors',
								local.fontId === font.id
									? 'text-[#c0caf5] bg-[#33467c]/50'
									: 'text-[#565f89] hover:text-[#a9b1d6] hover:bg-[#33467c]/25',
							)}
							style={{ fontFamily: font.family }}
						>
							{font.name}
						</button>
					))}
				</div>
			</div>

			{/* Font Size */}
			<div className="px-3 py-2">
				<div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Size</div>
				<div className="flex items-center gap-1 flex-wrap">
					{FONT_SIZES.map(size => (
						<button
							key={size}
							type="button"
							onClick={() => update({ fontSize: size })}
							className={cn(
								'w-7 h-7 flex items-center justify-center rounded transition-colors',
								local.fontSize === size
									? 'text-[#c0caf5] bg-[#33467c]/50 border border-[#7aa2f7]'
									: 'text-[#565f89] hover:text-[#a9b1d6] border border-transparent hover:border-[#33467c]',
							)}
						>
							{size}
						</button>
					))}
				</div>
			</div>
		</div>
	)
}
