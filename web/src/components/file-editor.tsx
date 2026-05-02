/**
 * File Editor - CodeMirror-based markdown file editor
 * Shows in the "Files" tab of session detail
 */

import {
  AlertTriangle,
  ChevronLeft,
  Clock,
  Eye,
  FileText,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  RefreshCw,
  Save,
} from 'lucide-react'
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { type FileInfo, useFileEditor } from '@/hooks/use-file-editor'
import { useKeyLayer } from '@/lib/key-layers'
import { cn, haptic } from '@/lib/utils'
import { Markdown } from './markdown'

// CodeMirror + language packs are heavy -- lazy chunk, shown under Suspense.
const FileEditorPane = lazy(() => import('./file-editor-pane'))

function FileList({
  files,
  activeFile,
  dirty,
  onSelect,
  onRefresh,
  loading,
}: {
  files: FileInfo[]
  activeFile: string | null
  dirty: boolean
  onSelect: (path: string) => void
  onRefresh: () => void
  loading: boolean
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border">
        <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">Files</span>
        <button
          type="button"
          onClick={onRefresh}
          className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
          title="Refresh file list"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {files.length === 0 && !loading && (
          <div className="px-2 py-4 text-[10px] text-muted-foreground text-center">No .md files found</div>
        )}
        {files.map(f => (
          <button
            key={f.path}
            type="button"
            onClick={() => onSelect(f.path)}
            title={f.path}
            className={cn(
              'w-full text-left px-2 py-1 text-xs font-mono flex items-center gap-1.5 transition-colors',
              f.path === activeFile
                ? 'bg-accent/20 text-accent'
                : 'text-foreground/80 hover:bg-muted/50 hover:text-foreground',
            )}
          >
            <FileText className="w-3 h-3 shrink-0" />
            <span className="truncate">{f.path}</span>
            {f.path === activeFile && dirty && <span className="ml-auto text-amber-400 font-bold text-[10px]">*</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

function HistoryPanel({
  history,
  onRestore,
  onClose,
}: {
  history: Array<{ version: number; timestamp: number; size: number; source: string }>
  onRestore: (version: number) => void
  onClose: () => void
}) {
  return (
    <div className="absolute right-0 top-0 bottom-0 w-64 bg-background border-l border-border z-20 flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-bold text-foreground">Version History</span>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs">
          Close
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {history.length === 0 && (
          <div className="px-3 py-4 text-[10px] text-muted-foreground text-center">No history available</div>
        )}
        {history.map(v => (
          <div key={v.version} className="px-3 py-2 border-b border-border/50 hover:bg-muted/30">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-foreground">v{v.version}</span>
              <button
                type="button"
                onClick={() => onRestore(v.version)}
                className="text-[10px] text-accent hover:text-accent/80"
              >
                Restore
              </button>
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {new Date(v.timestamp).toLocaleTimeString('en-US', { hour12: false })}
              {' - '}
              {v.source === 'disk' ? 'disk change' : 'user save'}
              {' - '}
              {v.size}B
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function EditorPane({
  content,
  onChange,
  filePath,
}: {
  content: string
  onChange: (value: string) => void
  filePath?: string
}) {
  return (
    <Suspense fallback={<div className="flex-1 min-h-0 bg-[#1a1b26]" />}>
      <FileEditorPane content={content} onChange={onChange} filePath={filePath} />
    </Suspense>
  )
}

export const FileEditor = memo(function FileEditor({ conversationId }: { conversationId: string }) {
  const {
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
  } = useFileEditor(conversationId)

  const [showHistory, setShowHistory] = useState(false)
  const [previewMode, setPreviewMode] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)

  useKeyLayer({ Escape: () => setFullscreen(false) }, { id: 'file-editor-fullscreen', enabled: fullscreen })

  // Load file list on mount
  useEffect(() => {
    loadFileList()
  }, [loadFileList])

  // Auto-open file from Ctrl+K file picker
  const pendingFilePath = useConversationsStore(state => state.pendingFilePath)
  useEffect(() => {
    if (pendingFilePath && files.length > 0) {
      const match = files.find(f => f.path === pendingFilePath)
      if (match) {
        openFile(match.path)
      }
      useConversationsStore.getState().setPendingFilePath(null)
    }
  }, [pendingFilePath, files, openFile])

  const handleOpenFile = useCallback(
    (path: string) => {
      if (activeFile === path) return
      if (activeFile) closeFile()
      setPreviewMode(true)
      haptic('tap')
      openFile(path)
    },
    [activeFile, closeFile, openFile],
  )

  const handleShowHistory = useCallback(async () => {
    if (!activeFile) return
    await loadHistory(activeFile)
    setShowHistory(true)
  }, [activeFile, loadHistory])

  const handleRestore = useCallback(
    async (ver: number) => {
      if (!activeFile) return
      await restoreVersion(activeFile, ver)
      setShowHistory(false)
    },
    [activeFile, restoreVersion],
  )

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('file-editor-sidebar-width')
    return saved ? Number.parseInt(saved, 10) : 176 // 44 * 4 = 176px (w-44)
  })
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!dragRef.current) return
      const delta = e.clientX - dragRef.current.startX
      const newWidth = Math.max(120, Math.min(400, dragRef.current.startWidth + delta))
      setSidebarWidth(newWidth)
    }
    function handleMouseUp() {
      if (dragRef.current) {
        localStorage.setItem('file-editor-sidebar-width', String(sidebarWidth))
        dragRef.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [sidebarWidth])

  return (
    <div className="flex h-full">
      {/* File list sidebar */}
      <div className="shrink-0 border-r border-border" style={{ width: sidebarWidth }}>
        <FileList
          files={files}
          activeFile={activeFile}
          dirty={dirty}
          onSelect={handleOpenFile}
          onRefresh={loadFileList}
          loading={loading}
        />
      </div>

      {/* Draggable resize handle */}
      <div
        role="separator"
        tabIndex={0}
        aria-valuenow={sidebarWidth}
        className="w-1 shrink-0 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors"
        onMouseDown={e => {
          e.preventDefault()
          dragRef.current = { startX: e.clientX, startWidth: sidebarWidth }
          document.body.style.cursor = 'col-resize'
          document.body.style.userSelect = 'none'
        }}
      />

      {/* Editor area */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Conflict banner */}
        {conflict && (
          <div className="shrink-0 px-3 py-2 bg-amber-500/20 border-b border-amber-500/50 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="text-xs text-amber-200">
              File changed on disk while you had unsaved edits. Review the updated content.
            </span>
            <button
              type="button"
              onClick={() => resolveConflict(conflict)}
              className="ml-auto px-2 py-0.5 text-[10px] font-bold bg-amber-500/30 text-amber-200 hover:bg-amber-500/50 transition-colors"
            >
              Accept disk version
            </button>
          </div>
        )}

        {/* Status bar */}
        {activeFile && (
          <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b border-border text-[10px] font-mono text-muted-foreground">
            <button
              type="button"
              onClick={() => closeFile()}
              className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              <ChevronLeft className="w-3 h-3" />
            </button>
            <span className="text-foreground">{activeFile}</span>
            {dirty && (
              <span className="text-amber-400 flex items-center gap-1">
                <Save className="w-3 h-3" />
                unsaved
              </span>
            )}
            {saving && (
              <span className="text-accent flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                saving
              </span>
            )}
            {!dirty && !saving && version > 0 && <span className="text-emerald-400">v{version} saved</span>}
            <div className="ml-auto flex items-center gap-2">
              <div className="flex items-center border border-border rounded-sm overflow-hidden">
                <button
                  type="button"
                  onClick={() => setPreviewMode(false)}
                  className={cn(
                    'px-1.5 py-0.5 text-[10px] flex items-center gap-1 transition-colors',
                    !previewMode ? 'bg-accent/20 text-accent' : 'text-muted-foreground hover:text-foreground',
                  )}
                  title="Edit"
                >
                  <Pencil className="w-2.5 h-2.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewMode(true)}
                  className={cn(
                    'px-1.5 py-0.5 text-[10px] flex items-center gap-1 transition-colors',
                    previewMode ? 'bg-accent/20 text-accent' : 'text-muted-foreground hover:text-foreground',
                  )}
                  title="Preview"
                >
                  <Eye className="w-2.5 h-2.5" />
                </button>
              </div>
              {previewMode && (
                <button
                  type="button"
                  onClick={() => setFullscreen(!fullscreen)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  title={fullscreen ? 'Exit fullscreen' : 'Fullscreen preview'}
                >
                  {fullscreen ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
                </button>
              )}
              <button
                type="button"
                onClick={handleShowHistory}
                className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
              >
                <Clock className="w-3 h-3" />
                History
              </button>
              <button
                type="button"
                onClick={saveFile}
                disabled={!dirty || saving}
                className={cn(
                  'px-2 py-0.5 text-[10px] font-bold transition-colors',
                  dirty && !saving
                    ? 'bg-accent/20 text-accent hover:bg-accent/30'
                    : 'text-muted-foreground cursor-not-allowed',
                )}
              >
                Save
              </button>
            </div>
          </div>
        )}

        {/* Editor / Preview content */}
        {activeFile ? (
          previewMode && fullscreen ? (
            <div className="fixed inset-0 z-[998] bg-background flex flex-col">
              <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-border">
                <span className="text-xs font-mono text-muted-foreground">{activeFile}</span>
                <button
                  type="button"
                  onClick={() => setFullscreen(false)}
                  className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 text-xs"
                >
                  <Minimize2 className="w-3 h-3" /> ESC
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-6 max-w-4xl mx-auto w-full">
                <Markdown>{content}</Markdown>
              </div>
            </div>
          ) : previewMode ? (
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              <Markdown>{content}</Markdown>
            </div>
          ) : (
            <EditorPane
              key={activeFile}
              content={content}
              onChange={updateContent}
              filePath={activeFile ?? undefined}
            />
          )
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">
            Select a file to edit
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="shrink-0 px-3 py-1.5 bg-red-500/10 border-t border-red-500/30 text-[10px] text-red-400">
            {error}
          </div>
        )}

        {/* History panel overlay */}
        {showHistory && (
          <HistoryPanel history={history} onRestore={handleRestore} onClose={() => setShowHistory(false)} />
        )}
      </div>
    </div>
  )
})
