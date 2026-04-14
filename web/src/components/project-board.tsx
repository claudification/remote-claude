/**
 * Project Board - Kanban-style view for project tasks
 * Three columns: Open | In Progress | Done, plus collapsible Archive
 */

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLaunchChannel } from '@/hooks/use-launch-channel'
import type { ProjectTask } from '@/hooks/use-project'
import { type ProjectTaskMeta, type TaskStatus, useProject } from '@/hooks/use-project'
import { sendInput, useSessionsStore } from '@/hooks/use-sessions'
import { useKeyLayer } from '@/lib/key-layers'
import { cn, haptic } from '@/lib/utils'
import { Markdown } from './markdown'
import { MarkdownInput } from './markdown-input'

function taskAge(created: string): string {
  if (!created) return ''
  const ms = Date.now() - new Date(created).getTime()
  if (ms < 0) return ''
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d`
  return `${Math.floor(days / 30)}mo`
}

const COLUMNS: { status: TaskStatus; label: string; color: string }[] = [
  { status: 'inbox', label: 'Inbox', color: 'text-[#bb9af7]' },
  { status: 'open', label: 'Open', color: 'text-[#7aa2f7]' },
  { status: 'in-progress', label: 'In Progress', color: 'text-[#e0af68]' },
  { status: 'in-review', label: 'In Review', color: 'text-[#2ac3de]' },
  { status: 'done', label: 'Done', color: 'text-[#9ece6a]' },
]

const NEXT_STATUS: Record<string, TaskStatus> = {
  inbox: 'open',
  open: 'in-progress',
  'in-progress': 'in-review',
  'in-review': 'done',
}
const PREV_STATUS: Record<string, TaskStatus> = {
  open: 'inbox',
  'in-progress': 'open',
  'in-review': 'in-progress',
  done: 'in-review',
}

// Rotating tag pill colors
const TAG_COLORS = [
  'bg-[#7aa2f7]/20 text-[#7aa2f7] border-[#7aa2f7]/30',
  'bg-[#bb9af7]/20 text-[#bb9af7] border-[#bb9af7]/30',
  'bg-[#2ac3de]/20 text-[#2ac3de] border-[#2ac3de]/30',
  'bg-[#9ece6a]/20 text-[#9ece6a] border-[#9ece6a]/30',
  'bg-[#e0af68]/20 text-[#e0af68] border-[#e0af68]/30',
  'bg-[#f7768e]/20 text-[#f7768e] border-[#f7768e]/30',
]

function tagColor(tag: string): string {
  let hash = 0
  for (const ch of tag) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length]
}

const PRIORITY_COLORS: Record<string, string> = {
  high: 'bg-red-500/20 text-red-400 border-red-500/30',
  medium: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  low: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
}

function matchesTextFilter(query: string, task: ProjectTaskMeta): boolean {
  if (!query) return true
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const title = task.title.toLowerCase()
  return terms.every(term => title.includes(term))
}

/** Get unique tags from all tasks, sorted by frequency (descending) */
function getTagFrequencies(tasks: ProjectTaskMeta[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    for (const tag of task.tags) {
      counts.set(tag, (counts.get(tag) || 0) + 1)
    }
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
}

export function TaskEditor({
  task,
  sessionId,
  onSave,
  onMove,
  onRun,
  onClose,
}: {
  task: ProjectTask
  sessionId: string
  onSave: (
    slug: string,
    status: TaskStatus,
    patch: { title?: string; body?: string; priority?: string; tags?: string[] },
  ) => Promise<unknown>
  onMove: (slug: string, from: TaskStatus, to: TaskStatus) => Promise<boolean>
  onRun: (task: ProjectTask) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(task.title)
  const [body, setBody] = useState(task.body)
  const [status, setStatus] = useState<TaskStatus>(task.status)
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>(task.priority || 'medium')
  const [tags, setTags] = useState<string[]>(task.tags || [])
  const [tagInput, setTagInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(!body.trim())
  const [dragOver, setDragOver] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  useKeyLayer({ Escape: () => onClose() }, { id: 'task-editor' })

  async function uploadFile(file: File) {
    const ta = bodyRef.current
    const pos = ta?.selectionStart ?? body.length
    const placeholder = `![uploading ${file.name || 'file'}...]`
    const before = body.slice(0, pos)
    const after = body.slice(pos)
    setBody(before + placeholder + after)
    try {
      const formData = new FormData()
      formData.append('file', file, file.name || 'paste.png')
      const res = await fetch('/api/files', { method: 'POST', body: formData })
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
      const { url, filename } = await res.json()
      const current = bodyRef.current?.value ?? ''
      setBody(current.replace(placeholder, `![${filename}](${url})`))
    } catch {
      const current = bodyRef.current?.value ?? ''
      setBody(current.replace(placeholder, '![upload failed]'))
    }
  }

  function handleBodyPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) uploadFile(file)
        return
      }
    }
  }

  function handleBodyDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (!files?.length) return
    for (const file of files) uploadFile(file)
  }

  function addTag() {
    const t = tagInput.trim().toLowerCase()
    if (t && !tags.includes(t)) {
      setTags([...tags, t])
    }
    setTagInput('')
  }

  async function handleSave() {
    setSaving(true)
    await onSave(task.slug, status, { title, body, priority, tags })
    setSaving(false)
    haptic('success')
    onClose()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop
    <div role="presentation" className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        className="relative w-full max-w-2xl bg-[#1a1b26] border border-[#33467c] shadow-2xl flex flex-col max-h-[80vh]"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#33467c]/50 shrink-0">
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="flex-1 bg-transparent text-sm font-mono text-foreground outline-none placeholder:text-muted-foreground/30"
            placeholder="Title..."
          />
          <select
            value={status}
            onChange={e => {
              const newStatus = e.target.value as TaskStatus
              if (newStatus === status) return
              const oldStatus = status
              setStatus(newStatus)
              haptic('tap')
              // Immediately move the file on disk and update the board UI
              onMove(task.slug, oldStatus, newStatus)
            }}
            className={cn(
              'text-[10px] font-mono bg-transparent border px-1 py-0.5 outline-none',
              status === 'inbox' && 'border-[#bb9af7]/50 text-[#bb9af7]',
              status === 'open' && 'border-[#7aa2f7]/50 text-[#7aa2f7]',
              status === 'in-progress' && 'border-[#e0af68]/50 text-[#e0af68]',
              status === 'in-review' && 'border-[#2ac3de]/50 text-[#2ac3de]',
              status === 'done' && 'border-emerald-500/50 text-emerald-400',
              status === 'archived' && 'border-[#33467c]/50 text-muted-foreground',
            )}
          >
            <option value="inbox">inbox</option>
            <option value="open">open</option>
            <option value="in-progress">in-progress</option>
            <option value="in-review">in-review</option>
            <option value="done">done</option>
            <option value="archived">archived</option>
          </select>
          <select
            value={priority}
            onChange={e => setPriority(e.target.value as 'low' | 'medium' | 'high')}
            className="text-[10px] font-mono bg-transparent border border-[#33467c]/50 text-muted-foreground px-1 py-0.5 outline-none"
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
          <span className="text-[9px] text-muted-foreground/40 font-mono">{taskAge(task.created)}</span>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground ml-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tags */}
        <div className="flex items-center gap-1 px-4 py-1.5 border-b border-[#33467c]/30 flex-wrap shrink-0">
          {tags.map(tag => (
            <span
              key={tag}
              className={cn('text-[9px] px-1.5 py-0.5 border font-mono flex items-center gap-1', tagColor(tag))}
            >
              {tag}
              <button type="button" className="hover:opacity-60" onClick={() => setTags(tags.filter(t => t !== tag))}>
                x
              </button>
            </span>
          ))}
          <input
            type="text"
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTag()
              }
              if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
                setTags(tags.slice(0, -1))
              }
            }}
            placeholder="add tag..."
            className="text-[10px] bg-transparent text-muted-foreground outline-none w-16 font-mono placeholder:text-muted-foreground/20"
          />
        </div>

        {/* Body - toggle between markdown view and edit */}
        <div className="flex items-center justify-between px-4 py-1 border-b border-[#33467c]/20 shrink-0">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono transition-colors',
                !editing ? 'text-accent' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Eye className="w-3 h-3" /> View
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono transition-colors',
                editing ? 'text-accent' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Pencil className="w-3 h-3" /> Edit
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {editing ? (
            <div className="relative w-full h-full min-h-[200px]">
              <textarea
                ref={bodyRef}
                value={body}
                onChange={e => setBody(e.target.value)}
                onPaste={handleBodyPaste}
                onDrop={handleBodyDrop}
                onDragOver={e => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                className="w-full h-full min-h-[200px] bg-transparent text-sm font-mono text-foreground outline-none resize-none placeholder:text-muted-foreground/30 leading-relaxed"
                placeholder="Task body (markdown)... Paste images or drop files"
              />
              {dragOver && (
                <div className="absolute inset-0 border-2 border-dashed border-accent/60 bg-accent/5 pointer-events-none flex items-center justify-center">
                  <span className="text-xs font-mono text-accent/80">Drop file here</span>
                </div>
              )}
            </div>
          ) : body.trim() ? (
            <div
              role="button"
              tabIndex={0}
              className="text-sm text-foreground prose prose-invert prose-sm max-w-none cursor-text"
              onClick={() => setEditing(true)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') setEditing(true)
              }}
            >
              <Markdown>{body}</Markdown>
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              className="text-sm text-muted-foreground/30 font-mono cursor-text min-h-[200px]"
              onClick={() => setEditing(true)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') setEditing(true)
              }}
            >
              Click to add content...
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[#33467c]/50 shrink-0">
          <div className="flex items-center justify-between px-4 py-2">
            <div className="flex items-center gap-3">
              {/* Context-aware actions based on task status */}
              {(status === 'inbox' || status === 'open' || status === 'in-progress' || status === 'in-review') && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      const tagAttrs = [
                        `id="${task.slug}"`,
                        `title="${title.replace(/"/g, '&quot;')}"`,
                        priority !== 'medium' ? `priority="${priority}"` : '',
                        `status="${status}"`,
                        tags.length ? `tags="${tags.join(',')}"` : '',
                      ]
                        .filter(Boolean)
                        .join(' ')
                      const instructions = `Set status to in-progress when you start, in-review when complete. Use mcp__rclaude__project_set_status with id="${task.slug}".`
                      const prompt = `<project-task ${tagAttrs}>\n${body.trim() || title}\n\n${instructions}\n</project-task>`
                      sendInput(sessionId, prompt)
                      haptic('success')
                      onClose()
                    }}
                    className="whitespace-nowrap px-3 py-1 text-[11px] font-bold font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                  >
                    Work on this
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      haptic('tap')
                      onRun({ ...task, title, body, status, priority, tags })
                    }}
                    className="flex items-center gap-1 whitespace-nowrap px-3 py-1 text-[11px] font-bold font-mono bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors"
                  >
                    <Zap className="w-3 h-3" />
                    Run
                  </button>
                </>
              )}
              {status === 'in-review' && (
                <button
                  type="button"
                  onClick={() => {
                    setStatus('done')
                    onMove(task.slug, status, 'done')
                    haptic('success')
                  }}
                  className="whitespace-nowrap px-3 py-1 text-[11px] font-bold font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                >
                  Approve
                </button>
              )}
              {status === 'done' && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setStatus('in-review')
                      onMove(task.slug, status, 'in-review')
                      haptic('tap')
                    }}
                    className="whitespace-nowrap px-3 py-1 text-[11px] font-bold font-mono bg-[#2ac3de]/15 text-[#2ac3de] border border-[#2ac3de]/30 hover:bg-[#2ac3de]/25 transition-colors"
                  >
                    Reopen
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStatus('archived')
                      onMove(task.slug, status, 'archived')
                      haptic('tap')
                    }}
                    className="flex items-center gap-1 whitespace-nowrap px-3 py-1 text-[11px] font-bold font-mono bg-[#33467c]/30 text-muted-foreground border border-[#33467c]/50 hover:bg-[#33467c]/50 transition-colors"
                  >
                    <Archive className="w-3 h-3" />
                    Archive
                  </button>
                </>
              )}
              {status === 'archived' && (
                <button
                  type="button"
                  onClick={() => {
                    setStatus('open')
                    onMove(task.slug, status, 'open')
                    haptic('tap')
                  }}
                  className="whitespace-nowrap px-3 py-1 text-[11px] font-bold font-mono bg-[#7aa2f7]/15 text-[#7aa2f7] border border-[#7aa2f7]/30 hover:bg-[#7aa2f7]/25 transition-colors"
                >
                  Reopen
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1 text-xs font-bold font-mono bg-accent/20 text-accent hover:bg-accent/30 transition-colors disabled:opacity-50"
              >
                {saving ? '...' : 'Save'}
              </button>
            </div>
          </div>
          <div className="px-4 pb-1.5">
            <span className="text-[10px] text-muted-foreground/30 font-mono">{task.slug}.md</span>
          </div>
        </div>
      </div>
    </div>
  )
}

type LaunchStep = {
  label: string
  status: 'pending' | 'active' | 'done' | 'error'
  detail?: string
  ts?: number
}

export function RunTaskDialog({
  task,
  sessionId,
  onClose,
}: {
  task: ProjectTask
  sessionId: string
  onClose: () => void
}) {
  const cwd = useSessionsStore(state => state.sessionsById[sessionId]?.cwd || '')
  const projectSettings = useSessionsStore(state => state.projectSettings[cwd])
  const [model, setModel] = useState(projectSettings?.defaultModel || '')
  const [effort, setEffort] = useState<string>(projectSettings?.defaultEffort || 'default')
  const [useWorktree, setUseWorktree] = useState(true)
  const [branchName, setBranchName] = useState(task.slug)
  const [autoCommit, setAutoCommit] = useState(true)
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('')
  const [timeout, setTimeout_] = useState('30')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Launch monitor state
  const [phase, setPhase] = useState<'config' | 'launching'>('config')
  const [wrapperId, setWrapperId] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [steps, setSteps] = useState<LaunchStep[]>([])
  const [launchSessionId, setLaunchSessionId] = useState<string | null>(null)
  const startTimeRef = useRef(0)

  // Launch channel - request-scoped events from agent
  const launch = useLaunchChannel(jobId)

  useKeyLayer({ Escape: onClose })

  // Watch for the spawned session appearing in the sessions store
  const spawnedSession = useSessionsStore(
    useCallback(
      state => {
        const wid = launch.wrapperId || wrapperId
        if (!wid) return null
        return state.sessions.find(s => s.wrapperIds?.includes(wid)) || null
      },
      [launch.wrapperId, wrapperId],
    ),
  )

  // Insert agent events as steps in the launch monitor
  useEffect(() => {
    if (launch.events.length === 0 || phase !== 'launching') return
    setSteps(prev => {
      const updated = [...prev]
      const existingLabels = new Set(updated.map(s => s.label))
      // Insert agent events before "Waiting for session..."
      const waitIdx = updated.findIndex(s => s.label === 'Waiting for session...')
      const insertAt = waitIdx >= 0 ? waitIdx : updated.length
      let inserted = 0
      for (const evt of launch.events) {
        if (!existingLabels.has(evt.step)) {
          updated.splice(insertAt + inserted, 0, {
            label: evt.step,
            status: evt.status === 'ok' ? 'done' : evt.status === 'error' ? 'error' : 'active',
            detail: evt.detail,
            ts: evt.t,
          })
          existingLabels.add(evt.step)
          inserted++
        }
      }
      return updated
    })
  }, [launch.events, phase])

  // Handle job completion from launch channel
  useEffect(() => {
    if (launch.completed && !launchSessionId) {
      setLaunchSessionId(launch.sessionId)
    }
  }, [launch.completed, launch.sessionId, launchSessionId])

  // Handle job failure from launch channel
  useEffect(() => {
    if (launch.failed) {
      setError(launch.error || 'Launch failed')
      setSteps(prev =>
        prev.map(s =>
          s.status === 'active' ? { ...s, status: 'error' as const, detail: launch.error || 'failed' } : s,
        ),
      )
    }
  }, [launch.failed, launch.error])

  // Track session lifecycle in the launch monitor
  useEffect(() => {
    if (!wrapperId || phase !== 'launching') return

    if (spawnedSession && !launchSessionId) {
      // Session appeared -- wrapper connected to concentrator
      setLaunchSessionId(spawnedSession.id)
      const elapsed = Date.now() - startTimeRef.current
      setSteps(prev => [
        ...prev.map(s =>
          s.label === 'Waiting for session...' ? { ...s, status: 'done' as const, detail: `${elapsed}ms` } : s,
        ),
        { label: 'Session connected', status: 'done', ts: Date.now(), detail: spawnedSession.id.slice(0, 8) },
        { label: 'Waiting for prompt submission...', status: 'active', ts: Date.now() },
      ])
    }

    if (spawnedSession && launchSessionId) {
      const isActive = spawnedSession.status === 'active' || spawnedSession.status === 'idle'
      const isEnded = spawnedSession.status === 'ended'

      setSteps(prev => {
        const updated = [...prev]
        const promptStep = updated.find(s => s.label === 'Waiting for prompt submission...')
        if (promptStep && isActive && promptStep.status !== 'done') {
          promptStep.status = 'done'
          promptStep.detail = spawnedSession.lastEvent?.hookEvent || 'active'
          updated.push({
            label: isEnded ? 'Task complete' : 'Running...',
            status: isEnded ? 'done' : 'active',
            ts: Date.now(),
            detail: `${spawnedSession.eventCount || 0} events`,
          })
        }
        // Update running step event count
        const runningStep = updated.find(s => s.label === 'Running...')
        if (runningStep && !isEnded) {
          runningStep.detail = `${spawnedSession.eventCount || 0} events`
        }
        // Mark complete
        if (isEnded && runningStep) {
          runningStep.status = 'done'
          runningStep.label = 'Task complete'
          const totalElapsed = Math.round((Date.now() - startTimeRef.current) / 1000)
          runningStep.detail = `${totalElapsed}s, ${spawnedSession.eventCount || 0} events`
        }
        return updated
      })
    }
  }, [wrapperId, phase, spawnedSession, launchSessionId])

  // Timeout watchdog
  useEffect(() => {
    if (phase !== 'launching' || !startTimeRef.current) return
    const timer = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current
      if (elapsed > 30000 && !launchSessionId) {
        setSteps(prev => [
          ...prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: 'Timed out (30s)' } : s)),
        ])
        setError('Session failed to connect within 30s')
        clearInterval(timer)
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [phase, launchSessionId])

  async function handleRun() {
    if (phase !== 'config' || !cwd) return
    setPhase('launching')
    setError(null)
    startTimeRef.current = Date.now()
    haptic('tap')

    // Generate jobId and subscribe BEFORE making the HTTP request
    const newJobId = crypto.randomUUID()
    setJobId(newJobId)

    setSteps([{ label: 'Sending spawn request...', status: 'active', ts: Date.now() }])

    // Build the prompt from the task
    const tagAttrs = [
      `id="${task.slug}"`,
      `title="${task.title.replace(/"/g, '&quot;')}"`,
      task.priority !== 'medium' ? `priority="${task.priority}"` : '',
      `status="${task.status}"`,
      task.tags.length ? `tags="${task.tags.join(',')}"` : '',
    ]
      .filter(Boolean)
      .join(' ')
    const instructions = `Set status to in-progress when you start, in-review when complete. Use mcp__rclaude__project_set_status with id="${task.slug}".`
    const commitLine = autoCommit ? '\n\nWhen you are done, commit all changes with a descriptive commit message.' : ''
    const worktreeMerge = useWorktree
      ? '\n\nIMPORTANT - WORKTREE MERGE-BACK:\nYou are working in a git worktree (isolated branch). Before finishing:\n1. Commit all changes\n2. Merge back to main: run `git rebase main && git fetch . HEAD:main`\n3. If rebase conflicts occur, resolve them and run `git rebase --continue`, then `git fetch . HEAD:main`\n4. Verify: `git log --oneline main -5`\nThis merges your work back to main so it is not stranded on a dead branch.'
      : ''
    const prompt = `<project-task ${tagAttrs}>\n${task.body.trim() || task.title}\n\n${instructions}${commitLine}${worktreeMerge}\n</project-task>`

    try {
      const res = await fetch('/api/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          adHoc: true,
          adHocTaskId: task.slug,
          prompt,
          headless: true,
          model: model || undefined,
          effort: effort !== 'default' ? effort : undefined,
          worktree: useWorktree ? branchName : undefined,
          name: task.title.replace(/['"]/g, '').slice(0, 60),
          maxBudgetUsd: maxBudgetUsd ? Number(maxBudgetUsd) : undefined,
          jobId: newJobId,
        }),
      })
      const data = await res.json()
      if (data.success) {
        haptic('success')
        const wid = data.wrapperId as string
        setWrapperId(wid)
        setSteps(prev => [
          ...prev.map(s =>
            s.status === 'active' ? { ...s, status: 'done' as const, detail: `wrapper=${wid.slice(0, 8)}` } : s,
          ),
          { label: 'Waiting for session...', status: 'active', ts: Date.now() },
        ])
      } else {
        setError(data.error || 'Spawn failed')
        setSteps(prev =>
          prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: data.error } : s)),
        )
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Network error'
      setError(msg)
      setSteps(prev => prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: msg } : s)))
    }
  }

  function handleViewSession() {
    if (launchSessionId) {
      useSessionsStore.getState().selectSession(launchSessionId)
      onClose()
    }
  }

  async function handleCopyDiagnostics() {
    const elapsed = startTimeRef.current ? Math.round((Date.now() - startTimeRef.current) / 1000) : 0
    const diag = {
      type: 'run_task_diagnostics',
      time: new Date().toISOString(),
      task: { slug: task.slug, title: task.title, status: task.status, priority: task.priority, tags: task.tags },
      cwd,
      jobId,
      wrapperId: wrapperId || launch.wrapperId || null,
      sessionId: launchSessionId || launch.sessionId || null,
      elapsed: `${elapsed}s`,
      error: error || launch.error || null,
      config: {
        model: model || null,
        effort,
        worktree: useWorktree ? branchName : null,
        autoCommit,
        maxBudgetUsd: maxBudgetUsd || null,
        timeout,
      },
      steps: steps.map(s => ({
        label: s.label,
        status: s.status,
        detail: s.detail || null,
        ts: s.ts || null,
      })),
      launchEvents: launch.events.map(e => ({
        step: e.step,
        status: e.status,
        detail: e.detail || null,
        t: e.t,
      })),
      launchState: { completed: launch.completed, failed: launch.failed },
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(diag, null, 2))
      setCopied(true)
      haptic('success')
      globalThis.setTimeout(() => setCopied(false), 2000)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = JSON.stringify(diag, null, 2)
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      haptic('success')
      globalThis.setTimeout(() => setCopied(false), 2000)
    }
  }

  const stepIcon = (status: LaunchStep['status']) => {
    switch (status) {
      case 'pending':
        return <span className="w-2 h-2 rounded-full bg-[#33467c]/50 inline-block" />
      case 'active':
        return <span className="w-2 h-2 rounded-full bg-amber-400 inline-block animate-pulse" />
      case 'done':
        return <span className="text-[10px] text-emerald-400">&#x2713;</span>
      case 'error':
        return <span className="text-[10px] text-red-400">&#x2717;</span>
    }
  }

  const isComplete = spawnedSession?.status === 'ended'
  const isRunning = spawnedSession && !isComplete

  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label="Close dialog"
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      onClick={onClose}
      onKeyDown={e => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        className="relative w-full max-w-md bg-[#1a1b26] border border-amber-500/30 shadow-2xl"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-500/20">
          <Zap className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-mono font-bold text-amber-400">
            {phase === 'config' ? 'Run Task' : isComplete ? 'Task Complete' : 'Launching...'}
          </span>
          <button type="button" onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Task title */}
        <div className="px-4 py-3 border-b border-[#33467c]/30">
          <div className="text-xs font-mono text-foreground truncate">{task.title}</div>
          {phase === 'config' && task.body && (
            <div className="text-[10px] text-muted-foreground mt-1 line-clamp-2">{task.body.slice(0, 200)}</div>
          )}
        </div>

        {/* Phase 1: Config form */}
        {phase === 'config' && (
          <>
            <div className="px-4 py-3 space-y-3">
              <div className="flex items-center justify-between">
                <label htmlFor="run-task-model" className="text-[10px] font-mono text-muted-foreground">
                  Model
                </label>
                <select
                  id="run-task-model"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  className="text-[10px] font-mono bg-[#1a1b26] border border-[#33467c]/50 text-foreground px-2 py-1 outline-none"
                >
                  <option value="">default</option>
                  <option value="opus">opus</option>
                  <option value="sonnet">sonnet</option>
                  <option value="haiku">haiku</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <label htmlFor="run-task-effort" className="text-[10px] font-mono text-muted-foreground">
                  Effort
                </label>
                <select
                  id="run-task-effort"
                  value={effort}
                  onChange={e => setEffort(e.target.value)}
                  className="text-[10px] font-mono bg-[#1a1b26] border border-[#33467c]/50 text-foreground px-2 py-1 outline-none"
                >
                  <option value="default">default</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useWorktree}
                    onChange={e => setUseWorktree(e.target.checked)}
                    className="accent-amber-400"
                  />
                  <span className="text-[10px] font-mono text-muted-foreground">
                    Use git worktree (isolated branch)
                  </span>
                </label>
                {useWorktree && (
                  <input
                    type="text"
                    value={branchName}
                    onChange={e => setBranchName(e.target.value)}
                    className="w-full text-[10px] font-mono bg-[#1a1b26] border border-[#33467c]/50 text-foreground px-2 py-1 outline-none"
                    placeholder="Branch name..."
                  />
                )}
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoCommit}
                  onChange={e => setAutoCommit(e.target.checked)}
                  className="accent-amber-400"
                />
                <span className="text-[10px] font-mono text-muted-foreground">Auto-commit changes on completion</span>
              </label>
              <div className="flex items-center justify-between">
                <label htmlFor="run-task-budget" className="text-[10px] font-mono text-muted-foreground">
                  Max budget
                </label>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-[#565f89]">$</span>
                  <input
                    id="run-task-budget"
                    type="number"
                    min={0.01}
                    step={0.01}
                    placeholder="none"
                    value={maxBudgetUsd}
                    onChange={e => setMaxBudgetUsd(e.target.value)}
                    className="w-16 text-[10px] font-mono bg-[#1a1b26] border border-[#33467c]/50 text-foreground px-2 py-1 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <label htmlFor="run-task-timeout" className="text-[10px] font-mono text-muted-foreground">
                  Timeout
                </label>
                <select
                  id="run-task-timeout"
                  value={timeout}
                  onChange={e => setTimeout_(e.target.value)}
                  className="text-[10px] font-mono bg-[#1a1b26] border border-[#33467c]/50 text-foreground px-2 py-1 outline-none"
                >
                  <option value="5">5 min</option>
                  <option value="10">10 min</option>
                  <option value="15">15 min</option>
                  <option value="30">30 min</option>
                  <option value="0">unlimited</option>
                </select>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[#33467c]/30">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1 text-xs font-mono text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRun}
                disabled={!cwd}
                className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold font-mono bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors disabled:opacity-50"
              >
                <Zap className="w-3 h-3" />
                Run
              </button>
            </div>
          </>
        )}

        {/* Phase 2: Launch monitor */}
        {phase === 'launching' && (
          <>
            <div className="px-4 py-3 space-y-2">
              {steps.map((step, i) => (
                <div key={i} className="flex items-start gap-2 font-mono">
                  <span className="mt-0.5 w-3 flex-shrink-0 text-center">{stepIcon(step.status)}</span>
                  <div className="min-w-0">
                    <span
                      className={cn(
                        'text-[11px]',
                        step.status === 'error'
                          ? 'text-red-400'
                          : step.status === 'done'
                            ? 'text-muted-foreground'
                            : 'text-foreground',
                      )}
                    >
                      {step.label}
                    </span>
                    {step.detail && <span className="text-[10px] text-muted-foreground/60 ml-2">{step.detail}</span>}
                  </div>
                </div>
              ))}
            </div>

            {error && (
              <div className="px-4 py-2 text-[10px] font-mono text-red-400 border-t border-red-500/20 bg-red-500/5">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[#33467c]/30">
              {isRunning && (
                <button
                  type="button"
                  onClick={handleViewSession}
                  className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                >
                  View Session
                </button>
              )}
              {isComplete && (
                <button
                  type="button"
                  onClick={handleViewSession}
                  className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                >
                  View Result
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1 text-xs font-mono text-muted-foreground hover:text-foreground"
              >
                {isComplete || error ? 'Close' : 'Background'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ProjectCard({
  task,
  onMove,
  onDelete,
  onArchive,
  onEdit,
}: {
  task: ProjectTaskMeta
  onMove: (slug: string, from: TaskStatus, to: TaskStatus) => void
  onDelete: (slug: string, status: TaskStatus) => void
  onArchive: (slug: string, from: TaskStatus) => void
  onEdit: (task: ProjectTaskMeta) => void
}) {
  const [showActions, setShowActions] = useState(false)
  const canMoveRight = task.status in NEXT_STATUS
  const canMoveLeft = task.status in PREV_STATUS

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${task.status}/${task.slug}`,
    data: { slug: task.slug, status: task.status },
  })

  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group px-3 py-2 bg-[#1a1b26] border border-[#33467c]/30 hover:border-[#33467c]/60 transition-colors cursor-pointer',
        isDragging && 'opacity-50 z-50',
      )}
      onClick={() => !isDragging && onEdit(task)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') onEdit(task)
      }}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-mono text-foreground truncate flex items-center gap-1.5">
            <span className="truncate">{task.title}</span>
            {task.created && (
              <span className="text-[9px] text-muted-foreground/40 shrink-0">{taskAge(task.created)}</span>
            )}
          </div>
          {task.bodyPreview && (
            <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{task.bodyPreview}</div>
          )}
          <div className="flex items-center gap-1 mt-1 flex-wrap">
            {task.priority && (
              <span className={cn('text-[9px] px-1 py-0.5 border font-mono', PRIORITY_COLORS[task.priority])}>
                {task.priority}
              </span>
            )}
            {task.tags.map(tag => (
              <span key={tag} className={cn('text-[9px] px-1 py-0.5 border font-mono', tagColor(tag))}>
                {tag}
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 p-0.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
          onClick={e => {
            e.stopPropagation()
            haptic('tap')
            setShowActions(!showActions)
          }}
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>

      {showActions && (
        <div
          role="toolbar"
          className="flex items-center gap-0.5 mt-2 pt-2 border-t border-[#33467c]/20"
          onClick={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          {canMoveLeft && (
            <button
              type="button"
              title={`Move to ${PREV_STATUS[task.status]}`}
              className="p-1 text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => {
                haptic('tap')
                onMove(task.slug, task.status, PREV_STATUS[task.status])
                setShowActions(false)
              }}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
          )}
          {canMoveRight && (
            <button
              type="button"
              title={`Move to ${NEXT_STATUS[task.status]}`}
              className="p-1 text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => {
                haptic('tap')
                onMove(task.slug, task.status, NEXT_STATUS[task.status])
                setShowActions(false)
              }}
            >
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
          {task.status !== 'archived' && (
            <button
              type="button"
              title="Archive"
              className="p-1 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
              onClick={() => {
                haptic('tap')
                onArchive(task.slug, task.status)
                setShowActions(false)
              }}
            >
              <Archive className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            title="Delete"
            className="ml-auto p-1 text-red-400/60 hover:text-red-400 transition-colors"
            onClick={() => {
              haptic('error')
              onDelete(task.slug, task.status)
              setShowActions(false)
            }}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

function InlineAdd({ onAdd }: { onAdd: (text: string) => void }) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')

  if (!adding) {
    return (
      <button
        type="button"
        className="w-full px-3 py-1.5 text-[10px] text-muted-foreground/40 hover:text-muted-foreground hover:bg-[#1a1b26]/50 transition-colors font-mono text-left"
        onClick={() => {
          haptic('tap')
          setAdding(true)
        }}
      >
        + Add...
      </button>
    )
  }

  return (
    <div className="px-2 py-1.5 border-t border-[#33467c]/20">
      <MarkdownInput
        value={text}
        onChange={setText}
        onSubmit={() => {
          if (text.trim()) {
            haptic('success')
            onAdd(text.trim())
            setText('')
            setAdding(false)
          }
        }}
        placeholder="Description..."
        autoFocus
        inline
      />
      <div className="flex items-center gap-2 mt-1">
        <button
          type="button"
          className="text-[10px] text-accent font-mono hover:text-accent/80"
          onClick={() => {
            if (text.trim()) {
              haptic('success')
              onAdd(text.trim())
              setText('')
              setAdding(false)
            }
          }}
        >
          Add
        </button>
        <button
          type="button"
          className="text-[10px] text-muted-foreground font-mono hover:text-foreground"
          onClick={() => {
            setAdding(false)
            setText('')
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function DroppableColumn({ status, children }: { status: TaskStatus; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex-1 min-w-[220px] w-[220px] flex flex-col border-r border-border last:border-r-0 transition-colors',
        isOver && 'bg-accent/5',
      )}
    >
      {children}
    </div>
  )
}

export const ProjectBoard = memo(function ProjectBoard({ sessionId }: { sessionId: string }) {
  const { tasks, loading, refresh, createTask, moveTask, deleteTask, readTask, updateTask } = useProject(sessionId)
  const [editingTask, setEditingTask] = useState<ProjectTask | null>(null)
  const [runTask, setRunTask] = useState<ProjectTask | null>(null)
  const [activeDragTask, setActiveDragTask] = useState<ProjectTaskMeta | null>(null)
  const [archiveExpanded, setArchiveExpanded] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
  const [selectedPriority, setSelectedPriority] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Deep link: listen for open-project-task events (from push notifications / hash routes)
  useEffect(() => {
    function handleOpenTask(e: Event) {
      const taskId = (e as CustomEvent<{ taskId: string }>).detail?.taskId
      if (!taskId) return
      // Find the task by slug and open its editor
      const meta = tasks.find(t => t.slug === taskId)
      if (meta) {
        readTask(meta.slug, meta.status).then(full => {
          if (full) setEditingTask(full)
        })
      }
    }
    window.addEventListener('open-project-task', handleOpenTask)
    return () => window.removeEventListener('open-project-task', handleOpenTask)
  }, [tasks, readTask])

  const tagFreqs = useMemo(() => getTagFrequencies(tasks), [tasks])
  const hasActiveFilters = searchQuery.trim() || selectedTags.size > 0 || selectedPriority

  const filteredTasks = useMemo(() => {
    return tasks.filter(task => {
      if (!matchesTextFilter(searchQuery, task)) return false
      if (selectedTags.size > 0 && !task.tags.some(t => selectedTags.has(t))) return false
      if (selectedPriority && task.priority !== selectedPriority) return false
      return true
    })
  }, [tasks, searchQuery, selectedTags, selectedPriority])

  function toggleTag(tag: string) {
    setSelectedTags(prev => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
    haptic('tap')
  }

  function togglePriority(p: string) {
    setSelectedPriority(prev => (prev === p ? null : p))
    haptic('tap')
  }

  function clearFilters() {
    setSearchQuery('')
    setSelectedTags(new Set())
    setSelectedPriority(null)
    haptic('tap')
  }

  // Ctrl+F / Cmd+F opens filter and focuses search input
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        requestAnimationFrame(() => searchRef.current?.focus())
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 5 } }),
  )

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { slug: string; status: TaskStatus } | undefined
    if (!data) return
    const task = tasks.find(n => n.slug === data.slug && n.status === data.status)
    if (task) setActiveDragTask(task)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragTask(null)
    const { active, over } = event
    if (!over) return
    const targetStatus = over.id as TaskStatus
    const sourceData = active.data.current as { slug: string; status: TaskStatus } | undefined
    if (!sourceData || sourceData.status === targetStatus) return
    haptic('tap')
    moveTask(sourceData.slug, sourceData.status, targetStatus)
  }

  const handleCreate = useCallback(
    async (text: string) => {
      const lines = text.split('\n')
      const title = lines[0]
      const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : text
      await createTask({ title, body })
    },
    [createTask],
  )

  const handleMove = useCallback(
    async (slug: string, from: TaskStatus, to: TaskStatus) => {
      await moveTask(slug, from, to)
    },
    [moveTask],
  )

  const handleDelete = useCallback(
    async (slug: string, status: TaskStatus) => {
      await deleteTask(slug, status)
    },
    [deleteTask],
  )

  const handleArchive = useCallback(
    async (slug: string, from: TaskStatus) => {
      await moveTask(slug, from, 'archived')
    },
    [moveTask],
  )

  const archivedTasks = filteredTasks.filter(n => n.status === 'archived')
  const activeTasks = filteredTasks.filter(n => n.status !== 'archived')

  if (loading && tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground/40 text-xs font-mono">Loading...</div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex flex-col border-b border-border shrink-0">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-bold text-foreground font-mono">Project</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={cn(
                'p-0.5 transition-colors',
                searchOpen ? 'text-accent' : 'text-muted-foreground/40 hover:text-muted-foreground',
              )}
              onClick={() => {
                haptic('tap')
                setSearchOpen(prev => {
                  if (!prev) {
                    requestAnimationFrame(() => searchRef.current?.focus())
                  } else {
                    setSearchQuery('')
                  }
                  return !prev
                })
              }}
            >
              <Search className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              className="text-[10px] text-muted-foreground hover:text-foreground font-mono"
              onClick={() => refresh()}
            >
              Refresh
            </button>
          </div>
        </div>
        <div className="px-3 pb-2 space-y-1.5">
          {/* Text search -- toggleable */}
          {searchOpen && (
            <div className="flex items-center gap-2">
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onFocus={() => haptic('tap')}
                placeholder="Filter by title..."
                className="flex-1 bg-[#1a1b26] border border-[#33467c]/40 px-2 py-1 text-xs font-mono text-foreground outline-none placeholder:text-muted-foreground/30 focus:border-accent/50"
              />
              {hasActiveFilters && (
                <button
                  type="button"
                  className="text-[9px] text-muted-foreground/60 hover:text-foreground font-mono shrink-0"
                  onClick={clearFilters}
                >
                  Clear
                </button>
              )}
            </div>
          )}

          {/* Priority + tag filters -- always visible */}
          <div className="flex items-center gap-1">
            {(['high', 'medium', 'low'] as const).map(p => (
              <button
                key={p}
                type="button"
                onClick={() => togglePriority(p)}
                className={cn(
                  'px-1.5 py-0.5 text-[9px] font-mono border rounded transition-colors',
                  selectedPriority === p
                    ? PRIORITY_COLORS[p]
                    : 'border-border/40 text-muted-foreground/60 hover:text-muted-foreground',
                )}
              >
                {p}
              </button>
            ))}
            <span className="w-px h-3 bg-border/30 mx-0.5" />
            {/* Tag pills */}
            <div className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0 scrollbar-none">
              {tagFreqs.map(({ tag, count }) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  className={cn(
                    'px-1.5 py-0.5 text-[9px] font-mono border rounded whitespace-nowrap shrink-0 transition-colors',
                    selectedTags.has(tag)
                      ? tagColor(tag)
                      : 'border-border/40 text-muted-foreground/60 hover:text-muted-foreground',
                  )}
                >
                  {tag}
                  <span className="ml-0.5 opacity-50">{count}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Kanban columns */}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
          <div className="flex gap-0 h-full min-w-max">
            {COLUMNS.map(col => {
              const colTasks = activeTasks.filter(n => n.status === col.status)
              return (
                <DroppableColumn key={col.status} status={col.status}>
                  {/* Column header */}
                  <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2 shrink-0">
                    <span className={cn('text-[11px] font-bold font-mono uppercase tracking-wider', col.color)}>
                      {col.label}
                    </span>
                    <span className="text-[10px] text-muted-foreground/40 font-mono">{colTasks.length}</span>
                  </div>

                  {/* Cards */}
                  <div className="flex-1 overflow-y-auto space-y-0 pb-4">
                    {colTasks.map(task => (
                      <ProjectCard
                        key={task.slug}
                        task={task}
                        onMove={handleMove}
                        onDelete={handleDelete}
                        onArchive={handleArchive}
                        onEdit={async meta => {
                          const full = await readTask(meta.slug, meta.status)
                          if (full) setEditingTask(full)
                        }}
                      />
                    ))}

                    {col.status === 'inbox' && <InlineAdd onAdd={handleCreate} />}
                  </div>
                </DroppableColumn>
              )
            })}
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {activeDragTask && (
            <div className="px-3 py-2 bg-[#1a1b26] border border-[#33467c]/60 shadow-xl opacity-90 max-w-[250px]">
              <div className="text-xs font-mono text-foreground truncate">{activeDragTask.title}</div>
              {activeDragTask.bodyPreview && (
                <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                  {activeDragTask.bodyPreview}
                </div>
              )}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Archived section - collapsible */}
      {archivedTasks.length > 0 && (
        <div className="border-t border-border shrink-0">
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-2 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            onClick={() => {
              haptic('tap')
              setArchiveExpanded(!archiveExpanded)
            }}
          >
            {archiveExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <Archive className="w-3 h-3" />
            <span className="text-[11px] font-mono uppercase tracking-wider">Archived</span>
            <span className="text-[10px] font-mono">{archivedTasks.length}</span>
          </button>
          {archiveExpanded && (
            <div className="max-h-[200px] overflow-y-auto border-t border-border/30">
              {archivedTasks.map(task => (
                <ProjectCard
                  key={task.slug}
                  task={task}
                  onMove={handleMove}
                  onDelete={handleDelete}
                  onArchive={handleArchive}
                  onEdit={async meta => {
                    const full = await readTask(meta.slug, meta.status)
                    if (full) setEditingTask(full)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Full-screen editor modal */}
      {editingTask && (
        <TaskEditor
          task={editingTask}
          sessionId={sessionId}
          onSave={async (slug, status, patch) => {
            await updateTask(slug, status, patch)
          }}
          onMove={async (slug, from, to) => {
            const result = await moveTask(slug, from, to)
            if (result) {
              // Update the editing task's slug + status so subsequent saves use the correct path
              setEditingTask(prev => (prev && prev.slug === slug ? { ...prev, slug: result, status: to } : prev))
            }
            return !!result
          }}
          onRun={task => {
            setEditingTask(null)
            setRunTask(task)
          }}
          onClose={() => setEditingTask(null)}
        />
      )}

      {/* Run task dialog (lifted out of TaskEditor so it persists after editor closes) */}
      {runTask && <RunTaskDialog task={runTask} sessionId={sessionId} onClose={() => setRunTask(null)} />}
    </div>
  )
})
