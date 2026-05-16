import { Fzf } from 'fzf'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { FileInfo } from '@/hooks/use-file-editor'

export interface FileModeState {
  filteredFiles: FileInfo[]
  filesLoading: boolean
}

/**
 * File-mode (`f:` prefix) derivations. Lazily fetches the project's file list
 * over WS the first time the user enters file mode for an active conversation,
 * caches it in component state, and exposes Fzf-filtered results. Resets the
 * cache when the user leaves file mode so a re-entry triggers a fresh fetch.
 */
export function useFileMode(filter: string, isFileMode: boolean): FileModeState {
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const conversationsById = useConversationsStore(state => state.conversationsById)
  const sendWsMessage = useConversationsStore(state => state.sendWsMessage)

  const fileFilter = isFileMode ? filter.slice(2).trim().toLowerCase() : ''
  const [files, setFiles] = useState<FileInfo[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const filesFetched = useRef(false)

  const fileFzf = useMemo(
    () => new Fzf(files, { selector: (f: FileInfo) => `${f.name} ${f.path}`, casing: 'case-insensitive' }),
    [files],
  )
  const filteredFiles = fileFilter ? fileFzf.find(fileFilter).map(r => r.item) : files

  useEffect(() => {
    if (!isFileMode || filesFetched.current) return
    if (!selectedConversationId) return
    const conversation = conversationsById[selectedConversationId]
    if (!conversation || (conversation.status !== 'active' && conversation.status !== 'idle')) return

    filesFetched.current = true
    setFilesLoading(true)

    const requestId = crypto.randomUUID()
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.requestId === requestId && msg.type === 'file_list_response') {
          setFiles(msg.files || [])
          setFilesLoading(false)
        }
      } catch {}
    }

    const ws = useConversationsStore.getState().ws
    if (ws) {
      ws.addEventListener('message', handler)
      sendWsMessage({ type: 'file_list_request', conversationId: selectedConversationId, requestId })
      const timeout = setTimeout(() => {
        ws.removeEventListener('message', handler)
        setFilesLoading(false)
      }, 5000)
      return () => {
        ws.removeEventListener('message', handler)
        clearTimeout(timeout)
      }
    }
    setFilesLoading(false)
  }, [isFileMode, selectedConversationId, conversationsById, sendWsMessage])

  useEffect(() => {
    if (!isFileMode) {
      filesFetched.current = false
      setFiles([])
    }
  }, [isFileMode])

  return { filteredFiles, filesLoading }
}
