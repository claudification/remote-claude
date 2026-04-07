import type { HookEvent } from '@shared/protocol'
import { ArrowLeft, ChevronDown, ChevronRight, ChevronUp, Copy, Terminal } from 'lucide-react'
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { fetchSubagentTranscript, reviveSession, sendInput, useSessionsStore, wsSend } from '@/hooks/use-sessions'
import { canTerminal, type TranscriptEntry } from '@/lib/types'
import { cn, contextWindowSize, formatAge, formatEffort, formatModel, haptic, isMobileViewport } from '@/lib/utils'
import { BgTasksView } from './bg-tasks-view'
import { ConversationView } from './conversation-view'
import { DiagView } from './diag-view'
import { EventsView } from './events-view'
import { ExplorerModal } from './explorer'
import { FileEditor } from './file-editor'
import { InlineTerminal } from './inline-terminal'
import { MarkdownInput } from './markdown-input'
import { renderProjectIcon } from './project-settings-editor'
import { ShareBanner } from './share-panel'
import { SharedView } from './shared-view'
import { SubagentView } from './subagent-view'
import { TaskBoard } from './task-board'
import { TasksView } from './tasks-view'
import { TranscriptView } from './transcript'

const WebTerminal = lazy(() => import('./web-terminal').then(m => ({ default: m.WebTerminal })))

type Tab = 'transcript' | 'tty' | 'events' | 'agents' | 'tasks' | 'files' | 'shared' | 'notes' | 'diag'

// Stable empty references to avoid re-render loops with Zustand selectors
// (Zustand uses Object.is - a new [] !== previous [], causing infinite re-renders)
const EMPTY_EVENTS: HookEvent[] = []
const EMPTY_TRANSCRIPT: TranscriptEntry[] = []

function LinkRequestBanners() {
  const requests = useSessionsStore(s => s.pendingLinkRequests)
  const respond = useSessionsStore(s => s.respondToLinkRequest)
  if (requests.length === 0) return null
  return (
    <div className="shrink-0 space-y-1 p-2">
      {requests.map(req => (
        <div
          key={`${req.fromSession}:${req.toSession}`}
          className="flex items-center gap-2 px-3 py-2 bg-teal-500/10 border border-teal-500/30 rounded font-mono text-xs"
        >
          <span className="text-teal-400 font-bold shrink-0">LINK</span>
          <span className="text-foreground/80 flex-1 truncate">
            <span className="text-teal-300">{req.fromProject}</span>
            {' -> '}
            <span className="text-teal-300">{req.toProject}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              haptic('success')
              respond(req.fromSession, req.toSession, 'approve')
            }}
            className="px-2 py-0.5 text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/30 transition-colors"
          >
            ALLOW
          </button>
          <button
            type="button"
            onClick={() => {
              haptic('error')
              respond(req.fromSession, req.toSession, 'block')
            }}
            className="px-2 py-0.5 text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30 transition-colors"
          >
            BLOCK
          </button>
        </div>
      ))}
    </div>
  )
}

function formatPermissionInput(toolName: string, inputPreview: string, cwd?: string): React.ReactNode {
  try {
    const input = JSON.parse(inputPreview)
    const relativize = (p: string) => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p)

    if (toolName === 'Write' || toolName === 'Edit') {
      const path = input.file_path || input.path
      const content = input.content || input.new_string
      return (
        <>
          {path && <div className="text-amber-300 text-[11px] truncate">{relativize(path)}</div>}
          {content && (
            <pre className="text-muted-foreground text-[10px] bg-background/50 px-2 py-1 rounded max-h-16 overflow-hidden whitespace-pre-wrap">
              {content.length > 300 ? `${content.slice(0, 300)}...` : content}
            </pre>
          )}
        </>
      )
    }

    if (toolName === 'Bash') {
      const cmd = input.command || input.cmd
      return cmd ? (
        <pre className="text-cyan-400 text-[11px] bg-background/50 px-2 py-1 rounded whitespace-pre-wrap">{cmd}</pre>
      ) : null
    }

    if (toolName === 'Read') {
      const path = input.file_path || input.path
      return path ? <div className="text-amber-300 text-[11px]">{relativize(path)}</div> : null
    }

    // Generic: show parsed JSON nicely
    const entries = Object.entries(input)
    if (entries.length === 0) return null
    return (
      <div className="text-[10px] space-y-0.5">
        {entries.map(([k, v]) => {
          const val = typeof v === 'string' ? v : JSON.stringify(v)
          const display = typeof v === 'string' && cwd ? relativize(val) : val
          return (
            <div key={k} className="flex gap-1.5">
              <span className="text-muted-foreground shrink-0">{k}:</span>
              <span className="text-foreground/80 truncate">{String(display).slice(0, 200)}</span>
            </div>
          )
        })}
      </div>
    )
  } catch {
    // JSON parse failed (likely truncated). Try to extract known fields with regex.
    const relativize = (p: string) => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p)
    const pathMatch = inputPreview.match(/"file_path"\s*:\s*"([^"]+)"/)
    const cmdMatch = inputPreview.match(/"command"\s*:\s*"([^"]*(?:\\.[^"]*)*)/)
    const oldStrMatch = inputPreview.match(/"old_string"\s*:\s*"([^"]*(?:\\.[^"]*)*)/)
    const contentMatch = inputPreview.match(/"content"\s*:\s*"([^"]*(?:\\.[^"]*)*)/)

    if ((toolName === 'Write' || toolName === 'Edit') && pathMatch) {
      const preview = oldStrMatch?.[1] || contentMatch?.[1]
      return (
        <>
          <div className="text-amber-300 text-[11px] truncate">{relativize(pathMatch[1])}</div>
          {preview && (
            <pre className="text-muted-foreground text-[10px] bg-background/50 px-2 py-1 rounded max-h-16 overflow-hidden whitespace-pre-wrap">
              {preview.replace(/\\n/g, '\n').replace(/\\"/g, '"').slice(0, 300)}
            </pre>
          )}
        </>
      )
    }

    if (toolName === 'Bash' && cmdMatch) {
      return (
        <pre className="text-cyan-400 text-[11px] bg-background/50 px-2 py-1 rounded whitespace-pre-wrap">
          {cmdMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')}
        </pre>
      )
    }

    if (toolName === 'Read' && pathMatch) {
      return <div className="text-amber-300 text-[11px]">{relativize(pathMatch[1])}</div>
    }

    // Fallback: show raw
    return (
      <pre className="text-muted-foreground text-[10px] bg-background/50 px-2 py-1 rounded overflow-x-auto max-h-20 whitespace-pre-wrap break-all">
        {inputPreview}
      </pre>
    )
  }
}

function PermissionBanners() {
  const permissions = useSessionsStore(s => s.pendingPermissions)
  const respond = useSessionsStore(s => s.respondToPermission)
  const sendRule = useSessionsStore(s => s.sendPermissionRule)
  const selectedSession = useSessionsStore(s => s.selectedSessionId)
  const session = useSessionsStore(s => s.sessions.find(sess => sess.id === selectedSession))
  const relevant = permissions.filter(p => p.sessionId === selectedSession)
  if (relevant.length === 0) return null
  return (
    <div className="shrink-0 space-y-1 p-2">
      {relevant.map(perm => (
        <div
          key={perm.requestId}
          className="flex flex-col gap-1.5 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded font-mono text-xs"
        >
          <div className="flex items-center gap-2">
            <span className="text-amber-400 font-bold shrink-0">PERMISSION</span>
            <span className="text-foreground font-bold truncate">{perm.toolName}</span>
            <span className="text-muted-foreground text-[10px] ml-auto">{perm.requestId}</span>
          </div>
          {perm.description && <div className="text-foreground/70 text-[11px]">{perm.description}</div>}
          {perm.inputPreview && formatPermissionInput(perm.toolName, perm.inputPreview, session?.cwd)}
          <div className="flex items-center gap-2 mt-0.5">
            <button
              type="button"
              onClick={() => {
                haptic('success')
                respond(perm.sessionId, perm.requestId, 'allow')
              }}
              className="px-3 py-1 text-[11px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/30 transition-colors"
            >
              ALLOW
            </button>
            <button
              type="button"
              onClick={() => {
                haptic('double')
                respond(perm.sessionId, perm.requestId, 'allow')
                sendRule(perm.sessionId, perm.toolName, 'allow')
              }}
              className="px-3 py-1 text-[11px] font-bold bg-blue-500/20 text-blue-400 border border-blue-500/40 hover:bg-blue-500/30 transition-colors"
            >
              ALWAYS
            </button>
            <button
              type="button"
              onClick={() => {
                haptic('error')
                respond(perm.sessionId, perm.requestId, 'deny')
              }}
              className="px-3 py-1 text-[11px] font-bold bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30 transition-colors"
            >
              DENY
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function ClipboardBanners() {
  const captures = useSessionsStore(s => s.clipboardCaptures)
  const dismiss = useSessionsStore(s => s.dismissClipboard)
  const selectedSession = useSessionsStore(s => s.selectedSessionId)
  const relevant = captures.filter(c => c.sessionId === selectedSession)
  if (relevant.length === 0) return null

  return (
    <div className="shrink-0 space-y-1 p-2">
      {relevant.map(cap => (
        <div
          key={cap.id}
          className="flex flex-col gap-1.5 px-3 py-2 bg-cyan-500/10 border border-cyan-500/30 rounded font-mono text-xs"
        >
          <div className="flex items-center gap-2">
            <span className="text-cyan-400 font-bold shrink-0">CLIPBOARD</span>
            <span className="text-muted-foreground text-[10px]">{cap.contentType}</span>
            <span className="text-muted-foreground text-[10px] ml-auto">
              {new Date(cap.timestamp).toLocaleTimeString()}
            </span>
          </div>
          {cap.contentType === 'text' && cap.text && (
            <pre className="text-foreground/80 text-[10px] bg-background/50 px-2 py-1 rounded max-h-20 overflow-hidden whitespace-pre-wrap">
              {cap.text.length > 500 ? `${cap.text.slice(0, 500)}...` : cap.text}
            </pre>
          )}
          {cap.contentType === 'image' && cap.base64 && (
            <img
              src={`data:${cap.mimeType || 'image/png'};base64,${cap.base64}`}
              alt="clipboard"
              className="max-h-32 max-w-full rounded border border-border/30 object-contain"
            />
          )}
          <div className="flex items-center gap-2 relative z-10">
            <button
              type="button"
              onClick={() => {
                // Synchronous textarea copy -- works on iOS Safari without async gesture chain issues
                const text = cap.text || (cap.base64 ? atob(cap.base64) : '')
                if (text) {
                  const ta = document.createElement('textarea')
                  ta.value = text
                  ta.style.cssText = 'position:fixed;left:-9999px;top:0'
                  document.body.appendChild(ta)
                  ta.focus()
                  ta.select()
                  document.execCommand('copy')
                  document.body.removeChild(ta)
                  haptic('success')
                  dismiss(cap.id)
                }
              }}
              className="px-3 py-2 text-[11px] font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 hover:bg-cyan-500/30 active:bg-cyan-500/40 transition-colors cursor-pointer touch-manipulation"
            >
              COPY
            </button>
            <button
              type="button"
              onClick={() => {
                haptic('tick')
                dismiss(cap.id)
              }}
              className="px-3 py-2 text-[11px] font-bold bg-muted/20 text-muted-foreground border border-border/30 hover:bg-muted/30 active:bg-muted/40 transition-colors cursor-pointer touch-manipulation"
            >
              DISMISS
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function AskQuestionBanners() {
  const questions = useSessionsStore(s => s.pendingAskQuestions)
  const respond = useSessionsStore(s => s.respondToAskQuestion)
  const selectedSession = useSessionsStore(s => s.selectedSessionId)
  const relevant = questions.filter(q => q.sessionId === selectedSession)

  if (relevant.length === 0) return null

  return (
    <div className="shrink-0 space-y-2 p-2">
      {relevant.map(askReq => (
        <AskQuestionCard key={askReq.toolUseId} request={askReq} onRespond={respond} />
      ))}
    </div>
  )
}

function AskQuestionCard({
  request,
  onRespond,
}: {
  request: {
    sessionId: string
    toolUseId: string
    questions: Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string; preview?: string }>
      multiSelect?: boolean
    }>
    timestamp: number
  }
  onRespond: (
    sessionId: string,
    toolUseId: string,
    answers?: Record<string, string>,
    annotations?: Record<string, { preview?: string; notes?: string }>,
    skip?: boolean,
  ) => void
}) {
  const [selections, setSelections] = useState<Record<string, Set<string>>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [elapsed, setElapsed] = useState(0)

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - request.timestamp) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [request.timestamp])

  const timeLeft = Math.max(0, 90 - elapsed)
  const isExpiring = timeLeft < 20

  function toggleOption(question: string, label: string, multiSelect?: boolean) {
    haptic('tap')
    setSelections(prev => {
      const current = prev[question] || new Set<string>()
      const next = new Set(current)
      if (multiSelect) {
        if (next.has(label)) next.delete(label)
        else next.add(label)
      } else {
        next.clear()
        next.add(label)
      }
      return { ...prev, [question]: next }
    })
  }

  function handleSubmit() {
    haptic('success')
    const answers: Record<string, string> = {}
    const annots: Record<string, { notes?: string }> = {}
    for (const q of request.questions) {
      const selected = selections[q.question]
      if (selected && selected.size > 0) {
        answers[q.question] = [...selected].join(', ')
      }
      if (notes[q.question]?.trim()) {
        annots[q.question] = { notes: notes[q.question].trim() }
      }
    }
    const hasAnnotations = Object.keys(annots).length > 0
    onRespond(request.sessionId, request.toolUseId, answers, hasAnnotations ? annots : undefined)
  }

  function handleSkip() {
    haptic('tick')
    onRespond(request.sessionId, request.toolUseId, undefined, undefined, true)
  }

  const allAnswered = request.questions.every(q => {
    const selected = selections[q.question]
    return selected && selected.size > 0
  })

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 bg-violet-500/10 border border-violet-400/40 rounded font-mono text-xs">
      <div className="flex items-center gap-2">
        <span className="text-violet-400 font-bold shrink-0">QUESTION</span>
        <span className="text-muted-foreground text-[10px] ml-auto tabular-nums">
          <span className={isExpiring ? 'text-red-400 font-bold animate-pulse' : ''}>{timeLeft}s</span>
        </span>
      </div>

      {request.questions.map(q => (
        <div key={q.question} className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 bg-violet-500/20 text-violet-400 text-[10px] font-bold uppercase">
              {q.header}
            </span>
            {q.multiSelect && <span className="text-[9px] text-muted-foreground">(select multiple)</span>}
          </div>
          <div className="text-foreground text-[11px] leading-relaxed">{q.question}</div>
          <div className="space-y-1">
            {q.options.map(opt => {
              const isSelected = selections[q.question]?.has(opt.label)
              return (
                <button
                  type="button"
                  key={opt.label}
                  onClick={() => toggleOption(q.question, opt.label, q.multiSelect)}
                  className={cn(
                    'w-full text-left px-2.5 py-1.5 border rounded transition-all',
                    isSelected
                      ? 'border-violet-400/70 bg-violet-500/25 text-violet-200'
                      : 'border-border hover:border-violet-400/50 hover:bg-violet-500/10 text-foreground/90',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'shrink-0 w-3.5 h-3.5 border flex items-center justify-center text-[9px]',
                        q.multiSelect ? 'rounded-sm' : 'rounded-full',
                        isSelected ? 'border-violet-400 bg-violet-500/40' : 'border-muted-foreground/50',
                      )}
                    >
                      {isSelected && (q.multiSelect ? '\u2713' : '\u25CF')}
                    </span>
                    <span className="font-bold text-[11px]">{opt.label}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground/80 ml-5.5 mt-0.5">{opt.description}</div>
                </button>
              )
            })}
          </div>
          {/* Optional notes field */}
          <input
            type="text"
            placeholder="Add a note (optional)"
            value={notes[q.question] || ''}
            onChange={e => setNotes(prev => ({ ...prev, [q.question]: e.target.value }))}
            className="w-full px-2 py-1 text-[10px] bg-muted/30 border border-border/30 rounded text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-violet-500/50"
          />
        </div>
      ))}

      <div className="flex items-center gap-2 mt-1">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!allAnswered}
          className={cn(
            'px-4 py-1.5 text-[11px] font-bold border transition-colors',
            allAnswered
              ? 'bg-violet-500/20 text-violet-400 border-violet-500/40 hover:bg-violet-500/30'
              : 'bg-muted/20 text-muted-foreground border-border/30 cursor-not-allowed',
          )}
        >
          SUBMIT
        </button>
        <button
          type="button"
          onClick={handleSkip}
          className="px-3 py-1.5 text-[11px] font-bold bg-muted/20 text-muted-foreground border border-border/30 hover:bg-muted/30 transition-colors"
        >
          SKIP TO TERMINAL
        </button>
      </div>
    </div>
  )
}

function ScrollToBottomButton({ onClick, direction = 'down' }: { onClick: () => void; direction?: 'down' | 'up' }) {
  const Icon = direction === 'up' ? ChevronUp : ChevronDown
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-22 right-3 z-50 w-8 h-8 flex items-center justify-center rounded-full bg-[#7aa2f7] text-[#1a1b26] shadow-lg shadow-[#7aa2f7]/20 hover:bg-[#89b4fa] transition-colors cursor-pointer"
      title={direction === 'up' ? 'Scroll to top' : 'Scroll to bottom'}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}

// Isolated input bar - typing here does NOT rerender transcript/events
const InputBar = memo(function InputBar({ sessionId }: { sessionId: string }) {
  const [inputValue, setLocalInput] = useState(() => useSessionsStore.getState().inputDrafts[sessionId] ?? '')
  const [isSending, setIsSending] = useState(false)
  const [showAttention, setShowAttention] = useState(false)
  const [voiceActive, setVoiceActive] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef(inputValue)
  const sessionRef = useRef(sessionId)

  // Listen for voice state changes from VoiceFab
  useEffect(() => {
    function handleVoiceState(e: Event) {
      const state = (e as CustomEvent).detail
      setVoiceActive(state !== 'idle')
    }
    window.addEventListener('voice-state', handleVoiceState)
    return () => window.removeEventListener('voice-state', handleVoiceState)
  }, [])

  // Track pendingAttention with 15s delay before showing
  const pendingAttention = useSessionsStore(s => s.sessions.find(sess => sess.id === sessionId)?.pendingAttention)
  useEffect(() => {
    if (!pendingAttention) {
      setShowAttention(false)
      return
    }
    // Show after 15s delay (permission/elicitation/ask might resolve quickly)
    const elapsed = Date.now() - pendingAttention.timestamp
    const remaining = Math.max(0, 15_000 - elapsed)
    const timer = setTimeout(() => setShowAttention(true), remaining)
    return () => clearTimeout(timer)
  }, [pendingAttention])

  function setInputValue(text: string) {
    setLocalInput(text)
    inputRef.current = text
  }

  // Session switch: save old draft, restore new
  useEffect(() => {
    if (sessionRef.current !== sessionId) {
      useSessionsStore.getState().setInputDraft(sessionRef.current, inputRef.current)
      const restored = useSessionsStore.getState().inputDrafts[sessionId] ?? ''
      setLocalInput(restored)
      inputRef.current = restored
      sessionRef.current = sessionId
    }
  }, [sessionId])

  // Save draft on unmount
  useEffect(() => {
    return () => {
      useSessionsStore.getState().setInputDraft(sessionRef.current, inputRef.current)
    }
  }, [])

  async function handleSend() {
    if (!inputValue.trim() || isSending) return
    const text = inputValue
    haptic('tap')
    // Clear optimistically -- restore on failure
    setInputValue('')
    useSessionsStore.getState().setInputDraft(sessionId, '')
    setIsSending(true)
    const success = sendInput(sessionId, text)
    setIsSending(false)
    if (!success) {
      haptic('error')
      console.error('[input] sendInput failed for session', sessionId)
      // Restore on failure
      setInputValue(text)
      useSessionsStore.getState().setInputDraft(sessionId, text)
    } else {
      // Defensive re-clear
      setInputValue('')
      useSessionsStore.getState().setInputDraft(sessionId, '')
    }
    if (!isMobileViewport()) {
      requestAnimationFrame(() => containerRef.current?.querySelector('textarea')?.focus())
    }
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'shrink-0 p-3 border-t bg-background z-10 transition-colors duration-200',
        voiceActive ? 'border-t-2 border-red-500/60 shadow-[0_-2px_12px_rgba(239,68,68,0.15)]' : 'border-border',
      )}
    >
      {showAttention && pendingAttention && (
        <div
          role="button"
          tabIndex={0}
          className="mb-2 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded font-mono text-xs text-amber-400 flex items-center gap-2 animate-pulse cursor-pointer hover:bg-amber-500/20 transition-colors"
          onClick={() => {
            haptic('tap')
            const store = useSessionsStore.getState()
            if (store.selectedSessionId) store.openTab(store.selectedSessionId, 'tty')
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              haptic('tap')
              const store = useSessionsStore.getState()
              if (store.selectedSessionId) store.openTab(store.selectedSessionId, 'tty')
            }
          }}
        >
          <span className="text-amber-500 font-bold shrink-0">!</span>
          <span className="flex-1">
            {pendingAttention.type === 'permission' && (
              <>
                TTY needs permission for <span className="text-amber-200">{pendingAttention.toolName || 'tool'}</span>
                {pendingAttention.filePath && (
                  <>
                    {' '}
                    on <span className="text-amber-200">{pendingAttention.filePath.split('/').pop()}</span>
                  </>
                )}
              </>
            )}
            {pendingAttention.type === 'elicitation' && (
              <>
                TTY is asking a question
                {pendingAttention.question && (
                  <>
                    : <span className="text-amber-200">{pendingAttention.question.slice(0, 60)}</span>
                  </>
                )}
              </>
            )}
            {pendingAttention.type === 'ask' && <>TTY is waiting for your answer</>}
          </span>
          <span className="text-amber-500/60 shrink-0 text-[10px]">open terminal</span>
        </div>
      )}
      <div className="flex gap-2 items-stretch">
        <MarkdownInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSend}
          disabled={isSending}
          placeholder={isMobileViewport() ? 'Message...' : 'Enter to send, Shift+Enter for new line'}
          className="flex-1"
          autoFocus
        />
        <button
          type="button"
          onClick={() => {
            if (inputValue.trim() && !isSending) {
              handleSend()
            } else {
              // No input - focus the textarea instead (useful on mobile to avoid Siri zone)
              containerRef.current?.querySelector('textarea')?.focus()
            }
          }}
          disabled={isSending}
          className={cn(
            'shrink-0 px-4 py-2 text-xs font-bold font-mono border rounded transition-colors',
            inputValue.trim() && !isSending
              ? 'bg-accent text-accent-foreground border-accent hover:bg-accent/80'
              : 'bg-muted text-muted-foreground border-border cursor-not-allowed',
          )}
        >
          {isSending ? '...' : 'SEND'}
        </button>
      </div>
    </div>
  )
})

const EMPTY_EXPLORER = undefined

function ExplorerOverlay({ sessionId }: { sessionId: string }) {
  const pending = useSessionsStore(s => s.pendingExplorers[sessionId] || EMPTY_EXPLORER)
  const submitExplorer = useSessionsStore(s => s.submitExplorer)
  const dismissExplorer = useSessionsStore(s => s.dismissExplorer)
  const keepaliveExplorer = useSessionsStore(s => s.keepaliveExplorer)

  if (!pending) return null

  return (
    <ExplorerModal
      layout={pending.layout}
      onSubmit={result => submitExplorer(sessionId, pending.explorerId, result)}
      onCancel={() => dismissExplorer(sessionId, pending.explorerId)}
      onKeepalive={() => keepaliveExplorer(sessionId, pending.explorerId)}
    />
  )
}

export function SessionDetail() {
  const [activeTab, setActiveTab] = useState<Tab>('transcript')
  const [follow, setFollow] = useState(true)
  const showThinking = useSessionsStore(s => s.dashboardPrefs.showThinking)
  const [reviveState, setReviveState] = useState<'idle' | 'sending' | 'waiting' | 'error'>('idle')
  const [reviveError, setReviveError] = useState<string | null>(null)
  const [conversationTarget, setConversationTarget] = useState<{
    cwdA: string
    cwdB: string
    nameA: string
    nameB: string
  } | null>(null)
  const [reviveCountdown, setReviveCountdown] = useState(0)
  const disableFollow = useCallback(() => setFollow(false), [])
  const enableFollow = useCallback(() => setFollow(true), [])
  const reviveStartRef = useRef(0) // timestamp when revive started, to ignore pre-existing sessions
  const [infoExpanded, setInfoExpanded] = useState(false)
  const showTerminal = useSessionsStore(state => state.showTerminal)
  const terminalWrapperId = useSessionsStore(state => state.terminalWrapperId)
  const setShowTerminal = useSessionsStore(state => state.setShowTerminal)
  const requestedTab = useSessionsStore(state => state.requestedTab)
  const requestedTabSeq = useSessionsStore(state => state.requestedTabSeq)
  const selectedSessionId = useSessionsStore(state => state.selectedSessionId)
  const expandAll = useSessionsStore(state => state.expandAll)

  // Reset follow + revive state on session switch
  useEffect(() => {
    setFollow(true)
    setReviveState('idle')
    setReviveError(null)
    setReviveCountdown(0)
    reviveStartRef.current = 0
    setConversationTarget(null)
  }, [selectedSessionId])

  // Apply requested tab - fires on selectSession (always 'transcript'), openTab, and badge clicks
  // requestedTabSeq ensures re-clicks on the same session still trigger
  useEffect(() => {
    if (requestedTab) {
      setActiveTab(requestedTab as Tab)
    }
  }, [requestedTab, requestedTabSeq])

  const session = useSessionsStore(state => state.sessions.find(s => s.id === state.selectedSessionId))
  const { canAdmin, canChat, canReadTerminal, canReadFiles } = useSessionsStore(
    s => (s.selectedSessionId && s.sessionPermissions[s.selectedSessionId]) || s.permissions,
  )

  // Track activeTab in a ref so selectors can skip updates when data isn't visible.
  // This prevents transcript/event updates from re-rendering the file editor and vice versa.
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab

  const events = useSessionsStore(state => {
    const tab = activeTabRef.current
    if (tab !== 'events' && tab !== 'transcript' && tab !== 'tty') return EMPTY_EVENTS
    return selectedSessionId ? state.events[selectedSessionId] || EMPTY_EVENTS : EMPTY_EVENTS
  })
  const transcript = useSessionsStore(state => {
    const tab = activeTabRef.current
    if (tab !== 'transcript' && tab !== 'tty') return EMPTY_TRANSCRIPT
    return selectedSessionId ? state.transcripts[selectedSessionId] || EMPTY_TRANSCRIPT : EMPTY_TRANSCRIPT
  })
  const agentConnected = useSessionsStore(state => state.agentConnected)
  const projectSettings = useSessionsStore(state => (session?.cwd ? state.projectSettings[session.cwd] : undefined))
  const selectedSubagentId = useSessionsStore(state => state.selectedSubagentId)
  const selectSubagent = useSessionsStore(state => state.selectSubagent)

  // Subagent transcript: store (live WS push) + initial HTTP fetch
  const subagentKey = selectedSessionId && selectedSubagentId ? `${selectedSessionId}:${selectedSubagentId}` : ''
  const subagentTranscriptRaw = useSessionsStore(state =>
    subagentKey ? state.subagentTranscripts[subagentKey] : undefined,
  )
  const subagentTranscript = subagentTranscriptRaw || EMPTY_TRANSCRIPT
  const [subagentLoading, setSubagentLoading] = useState(false)

  // Fetch initial subagent transcript via HTTP, seed into store
  useEffect(() => {
    if (!selectedSessionId || !selectedSubagentId) return
    let cancelled = false
    setSubagentLoading(true)
    fetchSubagentTranscript(selectedSessionId, selectedSubagentId).then(entries => {
      if (cancelled) return
      setSubagentLoading(false)
      if (entries.length > 0) {
        const key = `${selectedSessionId}:${selectedSubagentId}`
        useSessionsStore.setState(state => ({
          subagentTranscripts: { ...state.subagentTranscripts, [key]: entries },
        }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [selectedSessionId, selectedSubagentId])

  // HOOKS MUST BE BEFORE EARLY RETURNS - React rules!

  // Countdown timer while waiting for revived session
  useEffect(() => {
    if (reviveState !== 'waiting') return
    if (reviveCountdown <= 0) {
      setReviveState('error')
      setReviveError('Timed out - no session connected within 30s')
      return
    }
    const t = setTimeout(() => setReviveCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [reviveState, reviveCountdown])

  // Watch for new session connecting in same cwd (revive success)
  const reviveCwd = session?.cwd
  const reviveSessionId = session?.id
  useEffect(() => {
    if (reviveState !== 'waiting' || !reviveCwd || !reviveSessionId) return
    return useSessionsStore.subscribe(state => {
      const reviveTime = reviveStartRef.current
      if (reviveTime === 0) return
      const newSession = state.sessions.find(
        s => s.id !== reviveSessionId && s.cwd === reviveCwd && s.status !== 'ended' && s.startedAt > reviveTime,
      )
      if (newSession) {
        setReviveState('idle')
        setReviveCountdown(0)
        reviveStartRef.current = 0
        useSessionsStore.getState().selectSession(newSession.id)
      }
    })
  }, [reviveState, reviveCwd, reviveSessionId])

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <pre className="text-xs" style={{ lineHeight: 0.95 }}>
          {`
┌───────────────────────────┐
│                           │
│   Select a session to     │
│   view details            │
│                           │
│   _                       │
│                           │
└───────────────────────────┘
`.trim()}
        </pre>
      </div>
    )
  }

  const model = (events.find(e => e.hookEvent === 'SessionStart')?.data as { model?: string } | undefined)?.model

  const canSendInput = session != null && session.status !== 'ended' && canChat
  const hasTerminal = session ? canTerminal(session) : false
  const canRevive = session?.status === 'ended' && agentConnected

  function handleRevive() {
    if (!selectedSessionId || reviveState !== 'idle') return
    setReviveState('sending')
    setReviveError(null)
    const sent = reviveSession(selectedSessionId)
    if (!sent) {
      setReviveError('WebSocket not connected')
      setReviveState('error')
      return
    }
    // Signal sent - now wait for new session to connect
    reviveStartRef.current = Date.now()
    setReviveState('waiting')
    setReviveCountdown(30)
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
      {/* Link Request Banners */}
      <LinkRequestBanners />
      {/* Permission Relay Banners */}
      <PermissionBanners />
      {/* AskUserQuestion Banners */}
      <AskQuestionBanners />
      {/* Clipboard Capture Banners */}
      <ClipboardBanners />
      {/* Share banner - always visible when shares active (admin only) */}
      {canAdmin && session && <ShareBanner sessionCwd={session.cwd} />}
      {/* Explorer Modal */}
      {selectedSessionId && <ExplorerOverlay sessionId={selectedSessionId} />}
      {/* Session Info - Collapsible */}
      <div className="shrink-0 border-b border-border max-h-[30vh] overflow-y-auto">
        <button
          type="button"
          onClick={() => setInfoExpanded(!infoExpanded)}
          className="w-full p-3 sm:p-4 flex items-center gap-2 hover:bg-muted/30 transition-colors"
        >
          {infoExpanded ? (
            <>
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Session Info</span>
            </>
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
          )}
          {!infoExpanded &&
            (() => {
              const ps = projectSettings
              return (
                <span className="inline-flex items-center gap-1.5">
                  {ps?.icon && (
                    <span style={ps?.color ? { color: ps.color } : undefined}>
                      {renderProjectIcon(ps.icon, 'w-3.5 h-3.5')}
                    </span>
                  )}
                  <span className="text-sm font-bold truncate" style={ps?.color ? { color: ps.color } : undefined}>
                    {session.title || ps?.label || session.cwd.split('/').slice(-2).join('/')}
                  </span>
                  <span>
                    {' · '}
                    {formatModel(model || session.model)}
                    {session.effortLevel &&
                      (() => {
                        const effort = formatEffort(session.effortLevel)
                        return effort ? (
                          <span className="text-muted-foreground ml-1" title={`effort: ${effort.label}`}>
                            {effort.symbol}
                          </span>
                        ) : null
                      })()}
                  </span>
                  {session.tokenUsage &&
                    (() => {
                      const { input, cacheCreation, cacheRead } = session.tokenUsage
                      const total = input + cacheCreation + cacheRead
                      const maxTokens = contextWindowSize(model || session.model)
                      const pct = Math.min(100, Math.round((total / maxTokens) * 100))
                      const totalK = Math.round(total / 1000)
                      return (
                        <span className="inline-flex items-center gap-1 ml-1">
                          <span className="text-muted-foreground">·</span>
                          <span className="inline-block w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                            <span
                              className={cn(
                                'block h-full rounded-full',
                                pct < 60 ? 'bg-emerald-400' : pct < 85 ? 'bg-amber-400' : 'bg-red-400',
                              )}
                              style={{ width: `${pct}%` }}
                            />
                          </span>
                          <span
                            className={cn(
                              'text-[10px] font-mono',
                              pct < 60 ? 'text-emerald-400/70' : pct < 85 ? 'text-amber-400/70' : 'text-red-400/70',
                            )}
                          >
                            {totalK}K ({pct}%)
                          </span>
                        </span>
                      )
                    })()}
                </span>
              )
            })()}
        </button>
        {infoExpanded &&
          (() => {
            const s = session.stats
            const tu = session.tokenUsage
            const contextTotal = tu ? tu.input + tu.cacheCreation + tu.cacheRead : 0
            const ctxWindow = contextWindowSize(model || session.model)
            const contextPct = tu ? Math.min(100, Math.round((contextTotal / ctxWindow) * 100)) : 0

            // Cost estimation (per 1M tokens, Opus pricing)
            const inputCostPer1M = 15
            const outputCostPer1M = 75
            const cacheCostPer1M = 1.875 // cache read
            const cacheWriteCostPer1M = 18.75 // cache creation
            const estimatedCost = s
              ? ((s.totalInputTokens - s.totalCacheCreation - s.totalCacheRead) * inputCostPer1M +
                  s.totalOutputTokens * outputCostPer1M +
                  s.totalCacheRead * cacheCostPer1M +
                  s.totalCacheCreation * cacheWriteCostPer1M) /
                1_000_000
              : 0

            return (
              <div className="px-3 sm:px-4 pb-3 sm:pb-4 text-xs font-mono space-y-3">
                {/* Row 1: Status + Git + Model */}
                <div className="flex items-center gap-3 flex-wrap">
                  <span
                    className={cn(
                      'px-2 py-0.5 text-[10px] uppercase font-bold',
                      session.status === 'active' && 'bg-active text-background',
                      session.status === 'idle' && 'bg-idle text-background',
                      session.status === 'starting' && 'bg-idle/50 text-background animate-pulse',
                      session.status === 'ended' && 'bg-ended text-foreground',
                    )}
                  >
                    {session.status}
                  </span>
                  <span className="text-foreground">
                    {formatModel(model || session.model)}
                    {session.effortLevel &&
                      (() => {
                        const effort = formatEffort(session.effortLevel)
                        return effort ? (
                          <span className="text-muted-foreground ml-1">
                            {effort.symbol} {effort.label}
                          </span>
                        ) : null
                      })()}
                  </span>
                  {session.claudeVersion && (
                    <span className="text-muted-foreground text-[10px]">cc/{session.claudeVersion}</span>
                  )}
                  {session.claudeAuth?.email && (
                    <span className="text-cyan-400/70 text-[10px]">
                      {session.claudeAuth.email.split('@')[0]}
                      {session.claudeAuth.orgName ? ` / ${session.claudeAuth.orgName}` : ''}
                      {session.claudeAuth.subscriptionType ? (
                        <span className="text-muted-foreground ml-1">[{session.claudeAuth.subscriptionType}]</span>
                      ) : null}
                    </span>
                  )}
                  {session.gitBranch && (
                    <span className="text-purple-400 text-[10px]">
                      <span className="text-muted-foreground">branch:</span> {session.gitBranch}
                    </span>
                  )}
                  <span className="text-muted-foreground text-[10px]">{session.id.slice(0, 8)}</span>
                  {session.capabilities &&
                    session.capabilities.length > 0 &&
                    session.capabilities.map(cap => (
                      <span
                        key={cap}
                        className={cn(
                          'px-1.5 py-0.5 text-[9px] uppercase font-bold',
                          cap === 'channel' ? 'bg-teal-400/20 text-teal-400' : 'bg-sky-400/20 text-sky-400',
                        )}
                      >
                        {cap}
                      </span>
                    ))}
                </div>

                {/* Row 2: Context window bar */}
                {tu && (
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-[10px] w-16">context</span>
                      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all',
                            contextPct < 60 ? 'bg-emerald-400' : contextPct < 85 ? 'bg-amber-400' : 'bg-red-400',
                          )}
                          style={{ width: `${contextPct}%` }}
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-16" />
                      <span
                        className={cn(
                          'text-[10px] font-mono',
                          contextPct < 60
                            ? 'text-emerald-400/70'
                            : contextPct < 85
                              ? 'text-amber-400/70'
                              : 'text-red-400/70',
                        )}
                      >
                        {Math.round(contextTotal / 1000)}K / {Math.round(ctxWindow / 1000)}K ({contextPct}%)
                      </span>
                    </div>
                  </div>
                )}

                {/* Row 3: Token stats */}
                {s && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[10px]">
                    <div>
                      <span className="text-muted-foreground">in </span>
                      <span className="text-cyan-400">{(s.totalInputTokens / 1000).toFixed(0)}K</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">out </span>
                      <span className="text-orange-400">{(s.totalOutputTokens / 1000).toFixed(0)}K</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">cache r/w </span>
                      <span className="text-blue-400">{(s.totalCacheRead / 1000).toFixed(0)}K</span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-purple-400">{(s.totalCacheCreation / 1000).toFixed(0)}K</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">cost </span>
                      <span className="text-emerald-400">${estimatedCost.toFixed(2)}</span>
                    </div>
                  </div>
                )}

                {/* Row 4: Session stats */}
                <div className="flex items-center gap-4 text-[10px] flex-wrap">
                  {s && s.turnCount > 0 && (
                    <span>
                      <span className="text-muted-foreground">turns </span>
                      <span className="text-foreground">{s.turnCount}</span>
                    </span>
                  )}
                  {s && s.toolCallCount > 0 && (
                    <span>
                      <span className="text-muted-foreground">tools </span>
                      <span className="text-foreground">{s.toolCallCount}</span>
                    </span>
                  )}
                  {session.totalSubagentCount > 0 && (
                    <span>
                      <span className="text-muted-foreground">agents </span>
                      <span className="text-foreground">{session.totalSubagentCount}</span>
                    </span>
                  )}
                  {s && s.compactionCount > 0 && (
                    <span>
                      <span className="text-muted-foreground">compactions </span>
                      <span className="text-amber-400">{s.compactionCount}</span>
                    </span>
                  )}
                  <span>
                    <span className="text-muted-foreground">started </span>
                    <span className="text-foreground">
                      {new Date(session.startedAt).toLocaleTimeString('en-US', { hour12: false })}
                    </span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">last </span>
                    <span className="text-foreground">{formatAge(session.lastActivity)}</span>
                  </span>
                </div>

                {/* Error banner */}
                {session.lastError && (
                  <div className="px-2 py-1.5 bg-destructive/15 border border-destructive/40 text-[10px] font-mono space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-destructive font-bold uppercase">API Error</span>
                      {session.lastError.errorType && (
                        <span className="text-destructive/80">{session.lastError.errorType}</span>
                      )}
                      <span className="text-muted-foreground ml-auto">
                        {new Date(session.lastError.timestamp).toLocaleTimeString('en-US', { hour12: false })}
                      </span>
                    </div>
                    {session.lastError.errorMessage && (
                      <div className="text-destructive/70">{session.lastError.errorMessage}</div>
                    )}
                    {session.lastError.stopReason && (
                      <div className="text-muted-foreground">reason: {session.lastError.stopReason}</div>
                    )}
                  </div>
                )}

                {/* CWD */}
                <div className="flex items-center gap-1 group/cwd">
                  <span className="text-[10px] text-muted-foreground truncate">{session.cwd}</span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(session.cwd)
                      haptic('tap')
                    }}
                    className="shrink-0 text-muted-foreground/30 hover:text-muted-foreground [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/cwd:opacity-100 transition-opacity"
                    title="Copy path"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
                {session.summary && (
                  <div className="text-[10px] text-muted-foreground/70 truncate" title={session.summary}>
                    {session.summary}
                  </div>
                )}
                {session.prLinks && session.prLinks.length > 0 && (
                  <div className="flex items-center gap-2 mt-0.5">
                    {session.prLinks.map(pr => (
                      <a
                        key={pr.prUrl}
                        href={pr.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] font-mono text-sky-400 hover:text-sky-300 hover:underline transition-colors"
                      >
                        {pr.prRepository.split('/').pop()}#{pr.prNumber}
                      </a>
                    ))}
                  </div>
                )}
                {projectSettings?.trustLevel && projectSettings.trustLevel !== 'default' && (
                  <div className="mt-1">
                    <span
                      className={cn(
                        'px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border rounded',
                        projectSettings.trustLevel === 'open'
                          ? 'bg-green-400/15 text-green-400 border-green-400/30'
                          : 'bg-amber-400/15 text-amber-400 border-amber-400/30',
                      )}
                    >
                      {projectSettings.trustLevel === 'open' ? '🔓 Open' : '🤝 Benevolent'}
                    </span>
                  </div>
                )}
                {session.linkedSessions && session.linkedSessions.length > 0 && (
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className="text-[10px] text-teal-400/60">linked:</span>
                    {session.linkedSessions.map(ls => (
                      <span key={ls.id} className="inline-flex items-center gap-1 text-[10px] font-mono">
                        <button
                          type="button"
                          className="text-teal-400 hover:text-teal-300 hover:underline cursor-pointer"
                          onClick={() => {
                            haptic('tap')
                            const myName =
                              session.title ||
                              projectSettings?.label ||
                              session.cwd.split('/').pop() ||
                              session.id.slice(0, 8)
                            setConversationTarget({
                              cwdA: session.cwd,
                              cwdB: ls.cwd,
                              nameA: myName,
                              nameB: ls.name,
                            })
                          }}
                          title={`View conversation with ${ls.name}`}
                        >
                          {ls.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            haptic('error')
                            wsSend('channel_unlink', { sessionA: session.id, sessionB: ls.id })
                          }}
                          className="text-red-400/40 hover:text-red-400 transition-colors"
                          title={`Sever link to ${ls.name}`}
                        >
                          x
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}
      </div>

      {/* Subagent Detail View - replaces entire panel content */}
      {selectedSubagentId &&
        (() => {
          const agent = session.subagents.find(a => a.agentId === selectedSubagentId)
          return (
            <>
              <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border bg-pink-400/5">
                <button
                  type="button"
                  onClick={() => selectSubagent(null)}
                  className="flex items-center gap-1 text-xs text-pink-400 hover:text-pink-300 transition-colors"
                >
                  <ArrowLeft className="w-3 h-3" />
                  Back
                </button>
                <div className="w-px h-4 bg-border" />
                <span className="text-xs text-pink-400 font-bold">
                  {agent?.description || agent?.agentType || 'agent'}
                </span>
                <span className="text-[10px] text-pink-400/50 font-mono">{selectedSubagentId.slice(0, 8)}</span>
                {agent && (
                  <span
                    className={cn(
                      'ml-auto px-1.5 py-0.5 text-[10px] uppercase font-bold',
                      agent.status === 'running' ? 'bg-active text-background' : 'bg-ended text-foreground',
                    )}
                  >
                    {agent.status}
                  </span>
                )}
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                {subagentLoading && subagentTranscript.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
                    Loading transcript...
                  </div>
                ) : subagentTranscript.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
                    No transcript entries yet
                  </div>
                ) : (
                  <TranscriptView
                    entries={subagentTranscript}
                    follow={follow}
                    showThinking={showThinking}
                    onUserScroll={disableFollow}
                  />
                )}
              </div>
            </>
          )
        })()}

      {/* Normal session view */}
      {!selectedSubagentId && (
        <>
          {/* Tabs with follow checkbox */}
          <div className="shrink-0 flex items-center border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            <button
              type="button"
              onClick={() => {
                haptic('tick')
                setActiveTab('transcript')
              }}
              className={cn(
                'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                activeTab === 'transcript'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              Transcript
            </button>
            {hasTerminal && canReadTerminal && (
              <button
                type="button"
                onClick={e => {
                  if (e.shiftKey) {
                    const wid = session?.wrapperIds?.[0]
                    if (wid)
                      window.open(`/#popout-terminal/${wid}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no')
                  } else {
                    haptic('tick')
                    setActiveTab(activeTab === 'tty' ? 'transcript' : 'tty')
                  }
                }}
                className={cn(
                  'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors flex items-center gap-1',
                  activeTab === 'tty'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
                title="Terminal (Shift+click to pop out)"
              >
                <Terminal className="w-3 h-3" />
                TTY
              </button>
            )}
            {canAdmin && (
              <button
                type="button"
                onClick={() => {
                  haptic('tick')
                  setActiveTab('events')
                }}
                className={cn(
                  'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                  activeTab === 'events'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                Events
              </button>
            )}
            {canAdmin &&
              (session.totalSubagentCount > 0 || session.activeSubagentCount > 0 || session.bgTasks.length > 0) && (
                <button
                  type="button"
                  onClick={() => {
                    haptic('tick')
                    setActiveTab('agents')
                  }}
                  className={cn(
                    'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                    activeTab === 'agents'
                      ? 'border-accent text-accent'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  Agents
                  {(session.activeSubagentCount > 0 || session.runningBgTaskCount > 0) && (
                    <span className="ml-1.5 px-1.5 py-0.5 bg-active/20 text-active text-[10px] font-bold">
                      {session.activeSubagentCount + session.runningBgTaskCount}
                    </span>
                  )}
                </button>
              )}
            {(session.taskCount > 0 || (session.archivedTaskCount ?? 0) > 0) && (
              <button
                type="button"
                onClick={() => {
                  haptic('tick')
                  setActiveTab('tasks')
                }}
                className={cn(
                  'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                  activeTab === 'tasks'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                Tasks
                {session.pendingTaskCount > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 bg-amber-500/20 text-amber-400 text-[10px] font-bold">
                    {session.pendingTaskCount}
                  </span>
                )}
              </button>
            )}
            {canReadFiles && session.status !== 'ended' && (
              <button
                type="button"
                onClick={() => {
                  haptic('tick')
                  setActiveTab('files')
                }}
                className={cn(
                  'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                  activeTab === 'files'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                Files
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                haptic('tick')
                setActiveTab('notes')
              }}
              className={cn(
                'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                activeTab === 'notes'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              Notes
            </button>
            <button
              type="button"
              onClick={() => {
                haptic('tick')
                setActiveTab('shared')
              }}
              className={cn(
                'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                activeTab === 'shared'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              Shared
            </button>
            {canAdmin && (
              <button
                type="button"
                onClick={() => {
                  haptic('tick')
                  setActiveTab('diag')
                }}
                className={cn(
                  'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                  activeTab === 'diag'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                Diag
              </button>
            )}
            {/* Follow/verbose - pushed to right */}
            <div className="ml-auto pr-3 flex items-center gap-2">
              <div className="w-px h-4 bg-border" />
            </div>
            {canAdmin && (
              <div className="pr-3 hidden sm:flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <Checkbox
                    id="verbose"
                    checked={expandAll}
                    onCheckedChange={checked => {
                      if (checked !== expandAll) useSessionsStore.getState().toggleExpandAll()
                    }}
                    className="h-3.5 w-3.5"
                  />
                  <label htmlFor="verbose" className="text-[10px] text-muted-foreground cursor-pointer select-none">
                    verbose
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Conversation view overlay - replaces content when viewing inter-session messages */}
          {conversationTarget && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <ConversationView
                cwdA={conversationTarget.cwdA}
                cwdB={conversationTarget.cwdB}
                nameA={conversationTarget.nameA}
                nameB={conversationTarget.nameB}
                onBack={() => setConversationTarget(null)}
              />
            </div>
          )}

          {!conversationTarget && (activeTab === 'transcript' || (activeTab === 'tty' && !hasTerminal)) && (
            <div className="flex-1 min-h-0 overflow-hidden relative">
              <TranscriptView
                key={selectedSessionId}
                entries={transcript}
                follow={follow}
                showThinking={showThinking}
                onUserScroll={disableFollow}
                onReachedBottom={enableFollow}
              />
              {!follow && transcript.length > 0 && <ScrollToBottomButton onClick={enableFollow} direction="down" />}
            </div>
          )}
          {activeTab === 'tty' && hasTerminal && !showTerminal && session.wrapperIds?.[0] && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <InlineTerminal wrapperId={session.wrapperIds[0]} />
            </div>
          )}
          {!conversationTarget && activeTab === 'events' && (
            <div className="flex-1 min-h-0 overflow-hidden relative">
              <EventsView
                key={selectedSessionId}
                events={events}
                follow={follow}
                onUserScroll={disableFollow}
                onReachedTop={enableFollow}
              />
              {!follow && events.length > 0 && <ScrollToBottomButton onClick={enableFollow} direction="up" />}
            </div>
          )}
          {!conversationTarget && activeTab === 'agents' && selectedSessionId && (
            <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 space-y-4">
              <SubagentView sessionId={selectedSessionId} />
              {session.bgTasks.length > 0 && (
                <>
                  <div className="border-t border-border pt-3">
                    <h3 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider mb-2">
                      Background Tasks
                    </h3>
                  </div>
                  <BgTasksView sessionId={selectedSessionId} />
                </>
              )}
            </div>
          )}
          {!conversationTarget && activeTab === 'tasks' && selectedSessionId && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <TasksView sessionId={selectedSessionId} pendingCount={session.pendingTaskCount} />
            </div>
          )}
          {!conversationTarget && activeTab === 'files' && selectedSessionId && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <FileEditor sessionId={selectedSessionId} />
            </div>
          )}
          {!conversationTarget && activeTab === 'notes' && selectedSessionId && (
            <TaskBoard sessionId={selectedSessionId} />
          )}
          {!conversationTarget && activeTab === 'shared' && session && <SharedView cwd={session.cwd} />}
          {!conversationTarget && activeTab === 'diag' && selectedSessionId && (
            <DiagView sessionId={selectedSessionId} />
          )}
        </>
      )}

      {/* Input box - isolated to prevent transcript rerenders on typing */}
      {!conversationTarget &&
        canSendInput &&
        (activeTab === 'transcript' || (activeTab === 'tty' && !hasTerminal)) &&
        !selectedSubagentId &&
        selectedSessionId && <InputBar sessionId={selectedSessionId} />}

      {/* Terminal overlay - routed by wrapperId (physical PTY) */}
      {showTerminal && terminalWrapperId && (
        <Suspense
          fallback={
            <div className="absolute inset-0 flex items-center justify-center bg-background text-muted-foreground">
              Loading terminal...
            </div>
          }
        >
          <WebTerminal
            wrapperId={terminalWrapperId}
            onClose={() => {
              setShowTerminal(false)
              const store = useSessionsStore.getState()
              if (store.selectedSessionId) store.openTab(store.selectedSessionId, 'transcript')
            }}
          />
        </Suspense>
      )}

      {/* Revive button for ended sessions */}
      {session?.status === 'ended' && (
        <div className="shrink-0 p-3 border-t border-border">
          {canRevive ? (
            <div>
              <Button
                onClick={
                  reviveState === 'error'
                    ? () => {
                        setReviveState('idle')
                        setReviveError(null)
                      }
                    : handleRevive
                }
                disabled={reviveState === 'sending' || reviveState === 'waiting'}
                size="sm"
                className={cn(
                  'w-full text-xs border',
                  reviveState === 'waiting'
                    ? 'bg-amber-400/20 text-amber-400 border-amber-400/50'
                    : reviveState === 'error'
                      ? 'bg-red-400/20 text-red-400 border-red-400/50 hover:bg-red-400/30'
                      : 'bg-active/20 text-active border-active/50 hover:bg-active/30',
                )}
              >
                {reviveState === 'sending' && 'Sending signal...'}
                {reviveState === 'waiting' && `Waiting for connection... ${reviveCountdown}s`}
                {reviveState === 'error' && 'Retry'}
                {reviveState === 'idle' && 'Revive Session'}
              </Button>
              {reviveError && <p className="text-[10px] text-red-400 mt-1">{reviveError}</p>}
              {reviveState === 'idle' && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  Spawns new rclaude in tmux at {session.cwd.split('/').slice(-2).join('/')}
                </p>
              )}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground text-center">
              {agentConnected ? 'Session ended' : 'No host agent connected -- revive unavailable'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
