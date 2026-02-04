import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
	children: ReactNode
}

interface State {
	hasError: boolean
	error: Error | null
	errorInfo: ErrorInfo | null
	copied: boolean
}

export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props)
		this.state = { hasError: false, error: null, errorInfo: null, copied: false }
	}

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { hasError: true, error }
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		this.setState({ error, errorInfo })
		console.error('ErrorBoundary caught:', error, errorInfo)
	}

	getErrorText(): string {
		const { error, errorInfo } = this.state
		const lines = [
			'═══════════════════════════════════════════════════════════════',
			'  CLAUDE CONCENTRATOR - ERROR REPORT',
			'═══════════════════════════════════════════════════════════════',
			'',
			`Timestamp: ${new Date().toISOString()}`,
			`User Agent: ${navigator.userAgent}`,
			`URL: ${window.location.href}`,
			'',
			'─── ERROR ───────────────────────────────────────────────────────',
			'',
			`Name: ${error?.name || 'Unknown'}`,
			`Message: ${error?.message || 'No message'}`,
			'',
			'─── STACK TRACE ─────────────────────────────────────────────────',
			'',
			error?.stack || 'No stack trace available',
			'',
		]

		if (errorInfo?.componentStack) {
			lines.push('─── COMPONENT STACK ─────────────────────────────────────────────', '', errorInfo.componentStack, '')
		}

		lines.push('═══════════════════════════════════════════════════════════════')

		return lines.join('\n')
	}

	async copyError() {
		try {
			await navigator.clipboard.writeText(this.getErrorText())
			this.setState({ copied: true })
			setTimeout(() => this.setState({ copied: false }), 2000)
		} catch (err) {
			console.error('Failed to copy:', err)
		}
	}

	reload() {
		window.location.reload()
	}

	render() {
		if (this.state.hasError) {
			const { error, copied } = this.state

			return (
				<div className="min-h-screen bg-background p-8 font-mono">
					<div className="max-w-4xl mx-auto">
						{/* Header */}
						<pre className="text-destructive text-sm mb-6">
							{`
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ███████╗██████╗ ██████╗  ██████╗ ██████╗ ██╗                              │
│   ██╔════╝██╔══██╗██╔══██╗██╔═══██╗██╔══██╗██║                              │
│   █████╗  ██████╔╝██████╔╝██║   ██║██████╔╝██║                              │
│   ██╔══╝  ██╔══██╗██╔══██╗██║   ██║██╔══██╗╚═╝                              │
│   ███████╗██║  ██║██║  ██║╚██████╔╝██║  ██║██╗                              │
│   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝                              │
│                                                                             │
│   Something went wrong. But hey, at least it's not a BSOD!                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
`.trim()}
						</pre>

						{/* Error Summary */}
						<div className="border border-destructive bg-destructive/10 p-4 mb-6">
							<div className="text-destructive font-bold mb-2">[ {error?.name || 'Error'} ]</div>
							<div className="text-foreground">{error?.message || 'An unknown error occurred'}</div>
						</div>

						{/* Actions */}
						<div className="flex gap-4 mb-6">
							<button
								type="button"
								onClick={() => this.copyError()}
								className="px-4 py-2 bg-primary text-primary-foreground font-bold text-sm hover:bg-primary/80 transition-colors"
							>
								{copied ? '✓ COPIED!' : '⎘ COPY ERROR'}
							</button>
							<button
								type="button"
								onClick={() => this.reload()}
								className="px-4 py-2 bg-secondary text-secondary-foreground font-bold text-sm hover:bg-secondary/80 transition-colors"
							>
								↻ RELOAD
							</button>
						</div>

						{/* Stack Trace */}
						<div className="border border-border">
							<div className="p-3 border-b border-border bg-card text-primary font-bold text-sm">[ STACK TRACE ]</div>
							<pre className="p-4 text-xs text-muted-foreground overflow-x-auto max-h-64 overflow-y-auto">
								{error?.stack || 'No stack trace available'}
							</pre>
						</div>

						{/* Component Stack */}
						{this.state.errorInfo?.componentStack && (
							<div className="border border-border mt-4">
								<div className="p-3 border-b border-border bg-card text-primary font-bold text-sm">
									[ COMPONENT STACK ]
								</div>
								<pre className="p-4 text-xs text-muted-foreground overflow-x-auto max-h-48 overflow-y-auto">
									{this.state.errorInfo.componentStack}
								</pre>
							</div>
						)}

						{/* Footer */}
						<div className="mt-6 text-muted-foreground text-xs">
							<pre>
								{`
┌─────────────────────────────────────────────────────────────────────────────┐
│  Pro tip: Copy the error and share it with someone who can help.            │
│  Blame Zuckerberg if this was caused by a Meta library.                     │
└─────────────────────────────────────────────────────────────────────────────┘
`.trim()}
							</pre>
						</div>
					</div>
				</div>
			)
		}

		return this.props.children
	}
}
