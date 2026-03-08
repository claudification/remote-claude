import { useMemo } from 'react'
import type { ReactElement } from 'react'

// Color-coded JSON renderer - no external deps, just styled spans
function colorize(value: unknown, depth = 0): ReactElement {
	if (value === null) return <span className="text-red-400">null</span>
	if (value === undefined) return <span className="text-red-400">undefined</span>
	if (typeof value === 'boolean') return <span className="text-amber-400">{String(value)}</span>
	if (typeof value === 'number') return <span className="text-cyan-400">{value}</span>

	if (typeof value === 'string') {
		// Truncate very long strings
		const display = value.length > 500 ? value.slice(0, 500) + '...' : value
		return <span className="text-green-400">"{display}"</span>
	}

	const indent = '  '.repeat(depth)
	const innerIndent = '  '.repeat(depth + 1)

	if (Array.isArray(value)) {
		if (value.length === 0) return <span className="text-muted-foreground">[]</span>
		return (
			<span>
				<span className="text-muted-foreground">[</span>
				{'\n'}
				{value.map((item, i) => (
					<span key={i}>
						{innerIndent}
						{colorize(item, depth + 1)}
						{i < value.length - 1 && <span className="text-muted-foreground">,</span>}
						{'\n'}
					</span>
				))}
				{indent}
				<span className="text-muted-foreground">]</span>
			</span>
		)
	}

	if (typeof value === 'object') {
		const entries = Object.entries(value)
		if (entries.length === 0) return <span className="text-muted-foreground">{'{}'}</span>
		return (
			<span>
				<span className="text-muted-foreground">{'{'}</span>
				{'\n'}
				{entries.map(([key, val], i) => (
					<span key={key}>
						{innerIndent}
						<span className="text-purple-400">"{key}"</span>
						<span className="text-muted-foreground">: </span>
						{colorize(val, depth + 1)}
						{i < entries.length - 1 && <span className="text-muted-foreground">,</span>}
						{'\n'}
					</span>
				))}
				{indent}
				<span className="text-muted-foreground">{'}'}</span>
			</span>
		)
	}

	return <span className="text-foreground">{String(value)}</span>
}

export default function JsonHighlight({ data }: { data: unknown }) {
	const rendered = useMemo(() => colorize(data), [data])
	return (
		<pre className="whitespace-pre-wrap bg-black/20 p-3 overflow-auto max-h-[50vh] leading-relaxed">
			{rendered}
		</pre>
	)
}
