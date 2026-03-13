/**
 * File editor state management hook
 * Handles request/response correlation, file state, autosave
 */

import type { FileInfo } from '@shared/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionsStore } from './use-sessions'

export type { FileInfo } from '@shared/protocol'

export interface VersionInfo {
  version: number
  timestamp: number
  size: number
  source: 'user' | 'disk'
  diffFromPrev?: string
}

interface PendingRequest {
  resolve: (data: any) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 10_000

export function useFileEditor(sessionId: string | null) {
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

  const sendWsMessage = useSessionsStore(state => state.sendWsMessage)

  function sendRequest(msg: Record<string, unknown>): Promise<any> {
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
    (msg: any) => {
      // Resolve pending requests by requestId
      if (msg.requestId) {
        const pending = pendingRequests.current.get(msg.requestId)
        if (pending) {
          clearTimeout(pending.timeout)
          pendingRequests.current.delete(msg.requestId)
          if (msg.error) {
            pending.reject(new Error(msg.error))
          } else {
            pending.resolve(msg)
          }
          return
        }
      }

      // Handle file_changed broadcasts (no requestId)
      if (msg.type === 'file_changed' && msg.sessionId === sessionId) {
        if (msg.path === activeFileRef.current) {
          if (dirty) {
            // User has unsaved changes - show conflict
            setConflict(msg.content)
          } else {
            // No local changes - update content directly
            setContent(msg.content)
            setVersion(msg.version)
          }
        }
      }
    },
    [sessionId, dirty],
  )

  // Register handler with the websocket store
  useEffect(() => {
    useSessionsStore.setState({ fileHandler: handleMessage })
    return () => {
      useSessionsStore.setState({ fileHandler: null })
    }
  }, [handleMessage])

  // Load file list
  const loadFileList = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    setError(null)
    try {
      const response = await sendRequest({
        type: 'file_list_request',
        sessionId,
      })
      setFiles(response.files || [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  // Open a file
  const openFile = useCallback(
    async (path: string) => {
      if (!sessionId) return
      setLoading(true)
      setError(null)
      setConflict(null)
      setDirty(false)
      try {
        const response = await sendRequest({
          type: 'file_content_request',
          sessionId,
          path,
        })
        setActiveFile(path)
        setContent(response.content)
        setVersion(response.version)
        // Start watching for disk changes
        sendWsMessage({ type: 'file_watch', sessionId, path })
      } catch (err: any) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    },
    [sessionId, sendWsMessage],
  )

  // Close current file
  const closeFile = useCallback(() => {
    if (sessionId && activeFile) {
      sendWsMessage({ type: 'file_unwatch', sessionId, path: activeFile })
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
  }, [sessionId, activeFile, sendWsMessage])

  // Save file
  const saveFile = useCallback(async () => {
    if (!sessionId || !activeFileRef.current || !dirty) return
    setSaving(true)
    setError(null)
    try {
      const response = await sendRequest({
        type: 'file_save',
        sessionId,
        path: activeFileRef.current,
        content: contentRef.current,
        diff: '', // computed server-side from content
        baseVersion: versionRef.current,
      })
      if (response.conflict) {
        setConflict(response.mergedContent || null)
      } else {
        setVersion(response.version)
        setDirty(false)
        setConflict(null)
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }, [sessionId, dirty])

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
  const loadHistory = useCallback(
    async (path: string) => {
      if (!sessionId) return
      try {
        const response = await sendRequest({
          type: 'file_history_request',
          sessionId,
          path,
        })
        setHistory(response.versions || [])
      } catch (err: any) {
        setError(err.message)
      }
    },
    [sessionId],
  )

  // Restore version
  const restoreVersion = useCallback(
    async (path: string, ver: number) => {
      if (!sessionId) return
      try {
        const response = await sendRequest({
          type: 'file_restore',
          sessionId,
          path,
          version: ver,
        })
        setContent(response.content || contentRef.current)
        setVersion(response.version || ver)
        setDirty(false)
        setConflict(null)
      } catch (err: any) {
        setError(err.message)
      }
    },
    [sessionId],
  )

  // Quick note append
  const appendQuickNote = useCallback(
    async (text: string) => {
      if (!sessionId) return
      try {
        await sendRequest({
          type: 'quick_note_append',
          sessionId,
          text,
        })
      } catch (err: any) {
        setError(err.message)
      }
    },
    [sessionId],
  )

  // Cleanup on session change
  useEffect(() => {
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
      for (const [, req] of pendingRequests.current) {
        clearTimeout(req.timeout)
      }
      pendingRequests.current.clear()
    }
  }, [sessionId])

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
