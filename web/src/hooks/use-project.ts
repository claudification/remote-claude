/**
 * useProject - Hook for project board task CRUD via WS relay to wrapper
 */

import type { TaskStatus } from '@shared/task-statuses'
import { useCallback, useEffect, useState } from 'react'
import { useConversationsStore } from './use-sessions'

export type { TaskStatus } from '@shared/task-statuses'

export interface ProjectTaskMeta {
  slug: string
  status: TaskStatus
  title: string
  priority?: 'low' | 'medium' | 'high'
  tags: string[]
  refs: string[]
  created: string
  bodyPreview: string
}

export interface ProjectTask extends ProjectTaskMeta {
  body: string
}

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 10_000

// Shared across all useProject instances so any hook can receive any response.
const sharedPendingRequests = new Map<string, PendingRequest>()
const changeListeners = new Set<(tasks: ProjectTaskMeta[]) => void>()
let handlerInstalled = false

function installSharedHandler() {
  if (handlerInstalled) return
  handlerInstalled = true
  useConversationsStore.setState({
    projectHandler: (msg: Record<string, unknown>) => {
      if (msg.type === 'project_changed' && msg.notes) {
        for (const listener of changeListeners) listener(msg.notes as ProjectTaskMeta[])
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

export function useProject(sessionId: string | null) {
  const [tasks, setTasks] = useState<ProjectTaskMeta[]>([])
  const [loading, setLoading] = useState(false)
  const sendWsMessage = useConversationsStore(state => state.sendWsMessage)

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

  useEffect(() => {
    installSharedHandler()
    changeListeners.add(setTasks)
    return () => {
      changeListeners.delete(setTasks)
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: sendRequest is recreated each render but is intentionally not in deps - sessionId is the real trigger
  const refresh = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      const resp = await sendRequest({ type: 'project_list' })
      setTasks((resp.notes as ProjectTaskMeta[]) || [])
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    refresh()
  }, [refresh])

  // biome-ignore lint/correctness/useExhaustiveDependencies: sendRequest is recreated each render but intentionally omitted - sessionId is the real trigger
  const createTask = useCallback(
    async (input: { title?: string; body: string; priority?: string; tags?: string[] }) => {
      if (!sessionId) return null
      const resp = await sendRequest({ type: 'project_create', ...input })
      const task = resp.note as ProjectTaskMeta
      setTasks(prev => [task, ...prev])
      return task
    },
    [sessionId],
  )

  /** Returns the (possibly renamed) slug on success, or false on failure. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: sendRequest is recreated each render but intentionally omitted - sessionId is the real trigger
  const moveTask = useCallback(
    async (slug: string, from: TaskStatus, to: TaskStatus): Promise<string | false> => {
      if (!sessionId) return false
      const resp = await sendRequest({ type: 'project_move', slug, from, to })
      if (resp.ok) {
        const newSlug = (resp.slug as string) || slug
        setTasks(prev => prev.map(n => (n.slug === slug ? { ...n, slug: newSlug, status: to } : n)))
        return newSlug
      }
      return false
    },
    [sessionId],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: sendRequest is recreated each render but intentionally omitted - sessionId is the real trigger
  const deleteTask = useCallback(
    async (slug: string, status: TaskStatus) => {
      if (!sessionId) return false
      const resp = await sendRequest({ type: 'project_delete', slug, status })
      if (resp.ok) {
        setTasks(prev => prev.filter(n => n.slug !== slug))
      }
      return !!resp.ok
    },
    [sessionId],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: sendRequest is recreated each render but intentionally omitted - sessionId is the real trigger
  const readTask = useCallback(
    async (slug: string, status: TaskStatus): Promise<ProjectTask | null> => {
      if (!sessionId) return null
      const resp = await sendRequest({ type: 'project_read', slug, status })
      return (resp.note as ProjectTask) || null
    },
    [sessionId],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: sendRequest is recreated each render but intentionally omitted - sessionId is the real trigger
  const updateTask = useCallback(
    async (
      slug: string,
      status: TaskStatus,
      patch: { title?: string; body?: string; priority?: string; tags?: string[] },
    ) => {
      if (!sessionId) return null
      const resp = await sendRequest({ type: 'project_update', slug, status, ...patch })
      const task = resp.note as ProjectTask | null
      if (task) {
        setTasks(prev => prev.map(n => (n.slug === slug ? { ...n, ...task } : n)))
      }
      return task
    },
    [sessionId],
  )

  return {
    tasks,
    loading,
    refresh,
    createTask,
    moveTask,
    deleteTask,
    readTask,
    updateTask,
  }
}
