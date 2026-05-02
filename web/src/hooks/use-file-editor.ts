/**
 * File editor state management hook
 * Handles request/response correlation, file state, autosave
 */

import type { FileInfo } from '@shared/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConversationsStore } from './use-conversations'

export type { FileInfo } from '@shared/protocol'

interface VersionInfo {
  version: number
  timestamp: number
  size: number
  source: 'user' | 'disk'
  diffFromPrev?: string
}

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 10_000

export function useFileEditor(conversationId: string | null) {
  const [files, setFiles] = useState<FileInfo[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [version, setVersion] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const [history, setHistory] = useState<VersionInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pendingRequests = useRef<Map<string, PendingRequest>>(new Map())
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentRef = useRef(content)
  const versionRef = useRef(version)
  const activeFileRef = useRef(activeFile)
  contentRef.current = content
  versionRef.current = version
  activeFileRef.current = activeFile

  const sendWsMessage = useConversationsStore(state => state.sendWsMessage)

  function sendRequest(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.current.delete(requestId)
        reject(new Error('Request timed out'))
      }, REQUEST_TIMEOUT_MS)
      pendingRequests.current.set(requestId, { resolve, reject, timeout })
      sendWsMessage({ ...msg, requestId })
    })
  }

  // Handle incoming WS messages for file editor
  const handleMessage = useCallback(
    (msg: Record<string, unknown>) => {
      // Resolve pending requests by requestId
      const requestId = msg.requestId as string | undefined
      if (requestId) {
        const pending = pendingRequests.current.get(requestId)
        if (pending) {
          clearTimeout(pending.timeout)
          pendingRequests.current.delete(requestId)
          if (msg.error) {
            pending.reject(new Error(msg.error as string))
          } else {
            pending.resolve(msg)
          }
          return
        }
      }

      // Handle file_changed broadcasts (no requestId)
      if (msg.type === 'file_changed' && msg.conversationId === conversationId) {
        if (msg.path === activeFileRef.current) {
          if (dirty) {
            // User has unsaved changes - show conflict
            setConflict(msg.content as string)
          } else {
            // No local changes - update content directly
            setContent(msg.content as string)
            setVersion(msg.version as number)
          }
        }
      }
    },
    [conversationId, dirty],
  )

  // Register handler with the websocket store
  useEffect(() => {
    useConversationsStore.setState({ fileHandler: handleMessage })
    return () => {
      useConversationsStore.setState({ fileHandler: null })
    }
  }, [handleMessage])

  // Load file list
  // biome-ignore lint/correctness/useExhaustiveDependencies: sendRequest is recreated each render but intentionally omitted - conversationId is the real trigger
  const loadFileList = useCallback(async () => {
    if (!conversationId) return
    setLoading(true)
    setError(null)
    try {
      const response = await sendRequest({
        type: 'file_list_request',
        conversationId,
      })
      setFiles((response.files as FileInfo[] | undefined) || [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  // Open a file
  // biome-ignore lint/correctness/useExhaustiveDependencies: sendRequest is recreated each render but intentionally omitted - conversationId/sendWsMessage are the real triggers
  const openFile = useCallback(
    async (path: string) => {
      if (!conversationId) return
      setLoading(true)
      setError(null)
      setConflict(null)
      setDirty(false)
      try {
        const response = await sendRequest({
          type: 'file_content_request',
          conversationId,
          path,
        })
        setActiveFile(path)
        setContent(response.content as string)
        setVersion(response.version as number)
        // Start watching for disk changes
        sendWsMessage({ type: 'file_watch', conversationId, path })
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [conversationId, sendWsMessage],
  )

  // Close current file
  const closeFile = useCallback(() => {
    if (conversationId && activeFile) {
      sendWsMessage({ type: 'file_unwatch', conversationId, path: activeFile })
    }
    setActiveFile(null)
    setContent('')
    setVersion(0)
    setDirty(false)
    setConflict(null)
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current)
      autosaveTimer.current = null
    }
  }, [conversationId, activeFile, sendWsMessage])

  // Save file
  // biome-ignore lint/correctness/useExhaustiveDependencies: sendRequest is recreated each render but intentionally omitted - conversationId/dirty are the real triggers
  const saveFile = useCallback(async () => {
    if (!conversationId || !activeFileRef.current || !dirty) return
    setSaving(true)
    setError(null)
    try {
      const response = await sendRequest({
        type: 'file_save',
        conversationId,
        path: activeFileRef.current,
        content: contentRef.current,
        diff: '', // computed server-side from content
        baseVersion: versionRef.current,
      })
      if (response.conflict) {
        setConflict((response.mergedContent as string | undefined) || null)
      } else {
        setVersion(response.version as number)
        setDirty(false)
        setConflict(null)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [conversationId, dirty])

  // Update content (from editor changes)
  const updateContent = useCallback(
    (newContent: string) => {
      setContent(newContent)
      setDirty(true)
      // Debounced autosave
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
      autosaveTimer.current = setTimeout(() => {
        saveFile()
      }, 2500)
    },
    [saveFile],
  )

  // Accept conflict resolution
  const resolveConflict = useCallback(
    (resolvedContent: string) => {
      setContent(resolvedContent)
      setConflict(null)
      setDirty(true)
      // Save immediately after conflict resolution
      setTimeout(() => saveFile(), 100)
    },
    [saveFile],
  )

  // Load history
  // biome-ignore lint/correctness/useExhaustiveDependencies: sendRequest is recreated each render but intentionally omitted - conversationId is the real trigger
  const loadHistory = useCallback(
    async (path: string) => {
      if (!conversationId) return
      try {
        const response = await sendRequest({
          type: 'file_history_request',
          conversationId,
          path,
        })
        setHistory((response.versions as VersionInfo[] | undefined) || [])
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [conversationId],
  )

  // Restore version
  // biome-ignore lint/correctness/useExhaustiveDependencies: sendRequest is recreated each render but intentionally omitted - conversationId is the real trigger
  const restoreVersion = useCallback(
    async (path: string, ver: number) => {
      if (!conversationId) return
      try {
        const response = await sendRequest({
          type: 'file_restore',
          conversationId,
          path,
          version: ver,
        })
        setContent((response.content as string | undefined) || contentRef.current)
        setVersion((response.version as number | undefined) || ver)
        setDirty(false)
        setConflict(null)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [conversationId],
  )

  // Quick note append
  // biome-ignore lint/correctness/useExhaustiveDependencies: sendRequest is recreated each render but intentionally omitted - conversationId is the real trigger
  const appendQuickNote = useCallback(
    async (text: string) => {
      if (!conversationId) return
      try {
        await sendRequest({
          type: 'project_quick_add',
          conversationId,
          text,
        })
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [conversationId],
  )

  // Cleanup on session change
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is intentionally used as cleanup trigger even though not read in the effect body
  useEffect(() => {
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
      for (const [, req] of pendingRequests.current) {
        clearTimeout(req.timeout)
      }
      pendingRequests.current.clear()
    }
  }, [conversationId])

  return {
    files,
    activeFile,
    content,
    version,
    dirty,
    conflict,
    history,
    loading,
    saving,
    error,
    loadFileList,
    openFile,
    closeFile,
    saveFile,
    updateContent,
    resolveConflict,
    loadHistory,
    restoreVersion,
    appendQuickNote,
  }
}
