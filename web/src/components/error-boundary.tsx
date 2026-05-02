import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { clearCacheAndReload } from '@/lib/utils'
import { BUILD_VERSION } from '../../../src/shared/version'

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
    this.reportCrash(error, errorInfo)
    // Signal SW to bypass cache on next page load (browser refresh).
    // main.tsx checks this flag and nukes SW + caches before React renders.
    try {
      localStorage.setItem('sw-crash-detected', '1')
    } catch {}
  }

  reportCrash(error: Error, errorInfo: ErrorInfo) {
    try {
      const store = useConversationsStore.getState()
      const session = store.selectedConversationId ? store.sessionsById[store.selectedConversationId] : undefined
      fetch('/api/crash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: { name: error.name, message: error.message, stack: error.stack },
          componentStack: errorInfo.componentStack,
          appState: this.getAppState(),
          localStorage: this.getLocalStorageDump(),
          version: BUILD_VERSION.gitHashShort,
          buildTime: BUILD_VERSION.buildTime,
          url: window.location.href,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          touch: navigator.maxTouchPoints > 0,
          conversationId: store.selectedConversationId,
          sessionStatus: session?.status,
          sessionProject: session?.project,
        }),
      }).catch(() => {})
    } catch {}
  }

  getLocalStorageDump(): string {
    try {
      const keys = ['control-panel-prefs', 'rclaude-terminal-settings']
      const entries: string[] = []
      for (const key of keys) {
        const val = localStorage.getItem(key)
        if (val) entries.push(`  ${key}: ${val}`)
      }
      return entries.length > 0 ? entries.join('\n') : '  (none)'
    } catch {
      return '  (localStorage unavailable)'
    }
  }

  getAppState(): string {
    try {
      const store = useConversationsStore.getState()
      const session = store.selectedConversationId ? store.sessionsById[store.selectedConversationId] : undefined
      const transcriptEntries = store.selectedConversationId
        ? store.transcripts[store.selectedConversationId]
        : undefined
      const lines = [
        `  selectedConversation: ${store.selectedConversationId?.slice(0, 8) || '(none)'}`,
        `  sessionCount: ${store.sessions.length}`,
        `  expandAll: ${store.expandAll}`,
        `  showTerminal: ${store.showTerminal}`,
        `  wsConnected: ${store.isConnected}`,
        `  viewport: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
        `  touch: ${navigator.maxTouchPoints > 0}`,
      ]
      if (session) {
        lines.push(
          `  session.status: ${session.status}`,
          `  session.project: ${session.project}`,
          `  session.eventCount: ${session.eventCount}`,
          `  session.ccSessionIds: [${(session.ccSessionIds || []).map(w => w.slice(0, 8)).join(', ')}]`,
          `  transcriptEntries: ${transcriptEntries?.length ?? 0}`,
          `  subagentCount: ${session.subagents?.length ?? 0}`,
          `  taskCount: ${session.taskCount ?? 0}`,
        )
      }
      return lines.join('\n')
    } catch (e) {
      return `  (failed to read store: ${e})`
    }
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
      `Version: ${BUILD_VERSION.gitHashShort} (${BUILD_VERSION.buildTime})`,
      '',
      '─── RECENT COMMITS ──────────────────────────────────────────────',
      '',
      ...(BUILD_VERSION.recentCommits || []).map(c => `  ${c.hash} ${c.message}`),
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

    lines.push(
      '─── APP STATE ───────────────────────────────────────────────────',
      '',
      this.getAppState(),
      '',
      '─── LOCAL SETTINGS ──────────────────────────────────────────────',
      '',
      this.getLocalStorageDump(),
      '',
      '═══════════════════════════════════════════════════════════════',
    )

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

            {/* Version + Recent Commits */}
            <div className="border border-border mb-6">
              <div className="p-3 border-b border-border bg-card text-primary font-bold text-sm">[ BUILD INFO ]</div>
              <div className="p-4 text-xs text-muted-foreground space-y-1">
                <div>
                  <span className="text-foreground/60">version:</span>{' '}
                  <span className="text-accent">{BUILD_VERSION.gitHashShort}</span>{' '}
                  <span className="text-foreground/40">({BUILD_VERSION.buildTime})</span>
                </div>
                {BUILD_VERSION.recentCommits?.length > 0 && (
                  <div className="mt-2 space-y-0.5">
                    {BUILD_VERSION.recentCommits.map(c => (
                      <div key={c.hash}>
                        <span className="text-accent/70">{c.hash}</span>{' '}
                        <span className="text-foreground/60">{c.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
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
                onClick={() => clearCacheAndReload()}
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

            {/* App State */}
            <div className="border border-border mt-4">
              <div className="p-3 border-b border-border bg-card text-primary font-bold text-sm">[ APP STATE ]</div>
              <pre className="p-4 text-xs text-muted-foreground overflow-x-auto max-h-48 overflow-y-auto">
                {this.getAppState()}
              </pre>
            </div>

            {/* Local Settings */}
            <div className="border border-border mt-4">
              <div className="p-3 border-b border-border bg-card text-primary font-bold text-sm">
                [ LOCAL SETTINGS ]
              </div>
              <pre className="p-4 text-xs text-muted-foreground overflow-x-auto max-h-48 overflow-y-auto">
                {this.getLocalStorageDump()}
              </pre>
            </div>

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
