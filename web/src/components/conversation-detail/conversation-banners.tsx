import { type ReactNode, useEffect, useState } from 'react'
import { BannerButton, BannerStack, ConversationBanner } from '@/components/ui/conversation-banner'
import { useConversationsStore } from '@/hooks/use-conversations'
import { projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'

// ---------------------------------------------------------------------------
// LinkRequestBanners
// ---------------------------------------------------------------------------

export function LinkRequestBanners() {
  const requests = useConversationsStore(s => s.pendingProjectLinks)
  const respond = useConversationsStore(s => s.respondToProjectLink)
  const selectedConversation = useConversationsStore(s => s.selectedConversationId)
  // Only surface requests whose target is the currently-viewed session. Rendered
  // inline at the transcript bottom (see TranscriptView) as a blocking UI gate,
  // same pattern as PermissionBanners. Without this filter we'd leak other
  // sessions' pending links into whichever session the user happens to be on.
  const relevant = requests.filter(r => r.toSession === selectedConversation)
  return (
    <BannerStack
      items={relevant}
      render={req => (
        <ConversationBanner
          key={`${req.fromSession}:${req.toSession}`}
          accent="teal"
          label="LINK"
          layout="row"
          title={
            <>
              <span className="text-teal-300">{req.fromProject}</span>
              {' -> '}
              <span className="text-teal-300">{req.toProject}</span>
            </>
          }
          actions={
            <>
              <BannerButton
                accent="emerald"
                label="ALLOW"
                size="sm"
                onClick={() => {
                  haptic('success')
                  respond(req.fromSession, req.toSession, 'approve')
                }}
              />
              <BannerButton
                accent="red"
                label="BLOCK"
                size="sm"
                onClick={() => {
                  haptic('error')
                  respond(req.fromSession, req.toSession, 'block')
                }}
              />
            </>
          }
        />
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// formatPermissionInput (helper used only by PermissionBanners)
// ---------------------------------------------------------------------------

function formatPermissionInput(toolName: string, inputPreview: string, root?: string): ReactNode {
  const relativize = (p: string) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p)
  try {
    const input = JSON.parse(inputPreview)

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
          const display = typeof v === 'string' && root ? relativize(val) : val
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

// ---------------------------------------------------------------------------
// PermissionBanners
// ---------------------------------------------------------------------------

export function PermissionBanners() {
  const permissions = useConversationsStore(s => s.pendingPermissions)
  const respond = useConversationsStore(s => s.respondToPermission)
  const sendRule = useConversationsStore(s => s.sendPermissionRule)
  const selectedConversation = useConversationsStore(s => s.selectedConversationId)
  const sessionPath = useConversationsStore(s =>
    s.selectedConversationId ? projectPath(s.sessionsById[s.selectedConversationId]?.project ?? '') : undefined,
  )
  const relevant = permissions.filter(p => p.conversationId === selectedConversation)
  return (
    <BannerStack
      items={relevant}
      render={perm => (
        <ConversationBanner
          key={perm.requestId}
          accent="amber"
          label="PERMISSION"
          title={<span className="font-bold">{perm.toolName}</span>}
          meta={perm.requestId}
          actions={
            <>
              <BannerButton
                accent="emerald"
                label="ALLOW"
                onClick={() => {
                  haptic('success')
                  respond(perm.conversationId, perm.requestId, 'allow')
                }}
              />
              <BannerButton
                accent="blue"
                label="ALWAYS"
                onClick={() => {
                  haptic('double')
                  respond(perm.conversationId, perm.requestId, 'allow')
                  sendRule(perm.conversationId, perm.toolName, 'allow')
                }}
              />
              <BannerButton
                accent="red"
                label="DENY"
                onClick={() => {
                  haptic('error')
                  respond(perm.conversationId, perm.requestId, 'deny')
                }}
              />
            </>
          }
        >
          {perm.description && <div className="text-foreground/70 text-[11px]">{perm.description}</div>}
          {perm.inputPreview && formatPermissionInput(perm.toolName, perm.inputPreview, sessionPath)}
        </ConversationBanner>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// ClipboardBanners
// ---------------------------------------------------------------------------

export function ClipboardBanners() {
  const captures = useConversationsStore(s => s.clipboardCaptures)
  const dismiss = useConversationsStore(s => s.dismissClipboard)
  const selectedConversation = useConversationsStore(s => s.selectedConversationId)
  const relevant = captures.filter(c => c.conversationId === selectedConversation)

  return (
    <BannerStack
      items={relevant}
      render={cap => (
        <ConversationBanner
          key={cap.id}
          accent="cyan"
          label="CLIPBOARD"
          title={<span className="text-muted-foreground text-[10px]">{cap.contentType}</span>}
          meta={new Date(cap.timestamp).toLocaleTimeString()}
          actions={
            <div className="flex items-center gap-2 relative z-10">
              <BannerButton
                accent="cyan"
                label="COPY"
                size="lg"
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
              />
              <BannerButton
                accent="muted"
                label="DISMISS"
                size="lg"
                onClick={() => {
                  haptic('tick')
                  dismiss(cap.id)
                }}
              />
            </div>
          }
        >
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
        </ConversationBanner>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// AskQuestionBanners + AskQuestionCard
// ---------------------------------------------------------------------------

export function AskQuestionBanners() {
  const questions = useConversationsStore(s => s.pendingAskQuestions)
  const respond = useConversationsStore(s => s.respondToAskQuestion)
  const selectedConversation = useConversationsStore(s => s.selectedConversationId)
  const relevant = questions.filter(q => q.conversationId === selectedConversation)

  return (
    <BannerStack
      items={relevant}
      gap="loose"
      render={askReq => <AskQuestionCard key={askReq.toolUseId} request={askReq} onRespond={respond} />}
    />
  )
}

function AskQuestionCard({
  request,
  onRespond,
}: {
  request: {
    conversationId: string
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
    conversationId: string,
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
    onRespond(request.conversationId, request.toolUseId, answers, hasAnnotations ? annots : undefined)
  }

  function handleSkip() {
    haptic('tick')
    onRespond(request.conversationId, request.toolUseId, undefined, undefined, true)
  }

  const allAnswered = request.questions.every(q => {
    const selected = selections[q.question]
    return selected && selected.size > 0
  })

  return (
    <ConversationBanner
      accent="violet"
      label="QUESTION"
      meta={
        <span className={cn('tabular-nums', isExpiring && 'text-red-400 font-bold animate-pulse')}>{timeLeft}s</span>
      }
      className="gap-2 py-2.5"
      actions={
        <>
          <BannerButton
            accent="violet"
            label="SUBMIT"
            onClick={handleSubmit}
            disabled={!allAnswered}
            className="px-4 py-1.5"
          />
          <BannerButton accent="muted" label="SKIP TO TERMINAL" onClick={handleSkip} className="px-3 py-1.5" />
        </>
      }
    >
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
    </ConversationBanner>
  )
}
