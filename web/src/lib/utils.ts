import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}

export function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString('en-US', { hour12: false })
}

export function formatAge(timestamp: number): string {
	const diff = Date.now() - timestamp
	const seconds = Math.floor(diff / 1000)
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	return `${hours}h ${minutes % 60}m ago`
}

export function truncatePath(path: string, maxLen = 40): string {
	if (path.length <= maxLen) return path
	return `...${path.slice(-maxLen + 3)}`
}

export function lastPathSegments(path: string, n = 3): string {
	// Strip home directory prefix (/Users/xxx/ or /home/xxx/)
	const homeStripped = path.replace(/^\/(Users|home)\/[^/]+\//, '')

	const segments = homeStripped.split('/').filter(Boolean)
	if (segments.length <= n) return homeStripped.startsWith('/') ? homeStripped.slice(1) : homeStripped
	return segments.slice(-n).join('/')
}

export function truncate(text: string, maxLen: number): string {
	if (!text) return ''
	if (text.length <= maxLen) return text
	return `${text.slice(0, maxLen)}...`
}

export function formatModel(model: string | undefined): string {
	if (!model) return 'unknown'
	return model
		.replace('claude-', '')
		.replace('-20250514', '')
		.replace(/-\d{8}$/, '')
}
