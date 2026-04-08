/**
 * useTaskNotes - Hook for task notes CRUD via WS relay to wrapper
 */

import { useCallback, useEffect, useState } from 'react'
import { useSessionsStore } from './use-sessions'

export type TaskStatus = 'open' | 'in-progress' | 'done' | 'archived'

export interface TaskNoteMeta {
  slug: string
  status: TaskStatus
  title: string
  priority?: 'low' | 'medium' | 'high'
  tags: string[]
  refs: string[]
  created: string
  bodyPreview: string
}

export interface TaskNote extends TaskNoteMeta {
  body: string
}

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 10_000

// Shared across all useTaskNotes instances so any hook can receive any response.
// Previously each instance had its own ref + tried to set a singleton handler,
// causing the last-mounted hook to steal responses from all others.
const sharedPendingRequests = new Map<string, PendingRequest>()
const changeListeners = new Set<(notes: TaskNoteMeta[]) => void>()
let handlerInstalled = false

function installSharedHandler() {
  if (handlerInstalled) return
  handlerInstalled = true
  useSessionsStore.setState({
    taskNotesHandler: (msg: Record<string, unknown>) => {
      if (msg.type === 'task_notes_changed' && msg.notes) {
        for (const listener of changeListeners) listener(msg.notes as TaskNoteMeta[])
        return
      }
      const requestId = msg.requestId as string | undefined
      if (requestId) {
        const pending = sharedPendingRequests.get(requestId)
        if (pending) {
          clearTimeout(pending.timeout)
          sharedPendingRequests.delete(requestId)
          if (msg.error) {
            pending.reject(new Error(msg.error as string))
          } else {
            pending.resolve(msg)
          }
        }
      }
    },
  })
}

export function useTaskNotes(sessionId: string | null) {
  const [notes, setNotes] = useState<TaskNoteMeta[]>([])
  const [loading, setLoading] = useState(false)
  const sendWsMessage = useSessionsStore(state => state.sendWsMessage)

  function sendRequest(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        sharedPendingRequests.delete(requestId)
        reject(new Error('Request timed out'))
      }, REQUEST_TIMEOUT_MS)
      sharedPendingRequests.set(requestId, { resolve, reject, timeout })
      sendWsMessage({ ...msg, requestId, sessionId })
    })
  }

  // Register for change notifications + ensure shared handler is installed
  useEffect(() => {
    installSharedHandler()
    changeListeners.add(setNotes)
    return () => {
      changeListeners.delete(setNotes)
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      const resp = await sendRequest({ type: 'task_notes_list' })
      setNotes((resp.notes as TaskNoteMeta[]) || [])
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  // Auto-load on session change
  useEffect(() => {
    refresh()
  }, [refresh])

  const createNote = useCallback(
    async (input: { title?: string; body: string; priority?: string; tags?: string[] }) => {
      if (!sessionId) return null
      const resp = await sendRequest({ type: 'task_notes_create', ...input })
      const note = resp.note as TaskNoteMeta
      setNotes(prev => [note, ...prev])
      return note
    },
    [sessionId],
  )

  const moveNote = useCallback(
    async (slug: string, from: TaskStatus, to: TaskStatus) => {
      if (!sessionId) return false
      const resp = await sendRequest({ type: 'task_notes_move', slug, from, to })
      if (resp.ok) {
        setNotes(prev => prev.map(n => (n.slug === slug ? { ...n, status: to } : n)))
      }
      return !!resp.ok
    },
    [sessionId],
  )

  const deleteNote = useCallback(
    async (slug: string, status: TaskStatus) => {
      if (!sessionId) return false
      const resp = await sendRequest({ type: 'task_notes_delete', slug, status })
      if (resp.ok) {
        setNotes(prev => prev.filter(n => n.slug !== slug))
      }
      return !!resp.ok
    },
    [sessionId],
  )

  const readNote = useCallback(
    async (slug: string, status: TaskStatus): Promise<TaskNote | null> => {
      if (!sessionId) return null
      const resp = await sendRequest({ type: 'task_notes_read', slug, status })
      return (resp.note as TaskNote) || null
    },
    [sessionId],
  )

  const updateNote = useCallback(
    async (
      slug: string,
      status: TaskStatus,
      patch: { title?: string; body?: string; priority?: string; tags?: string[] },
    ) => {
      if (!sessionId) return null
      const resp = await sendRequest({ type: 'task_notes_update', slug, status, ...patch })
      const note = resp.note as TaskNote | null
      if (note) {
        setNotes(prev => prev.map(n => (n.slug === slug ? { ...n, ...note } : n)))
      }
      return note
    },
    [sessionId],
  )

  return {
    notes,
    loading,
    refresh,
    createNote,
    moveNote,
    deleteNote,
    readNote,
    updateNote,
  }
}
