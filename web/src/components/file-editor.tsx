/**
 * File Editor - CodeMirror-based markdown file editor
 * Shows in the "Files" tab of session detail
 */

import { AlertTriangle, ChevronLeft, Clock, Eye, FileText, Loader2, Pencil, RefreshCw, Save } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { type FileInfo, useFileEditor } from '@/hooks/use-file-editor'
import { useSessionsStore } from '@/hooks/use-sessions'
import { cn, haptic } from '@/lib/utils'
import { Markdown } from './markdown'

// Lazy-load CodeMirror (heavy dependency)
let cmPromise: Promise<typeof import('./codemirror-setup')> | null = null
function loadCodeMirror() {
  if (!cmPromise) {
    cmPromise = import('./codemirror-setup')
  }
  return cmPromise
}

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
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<any>(null)
  const onChangeRef = useRef(onChange)
  const contentRef = useRef(content)
  onChangeRef.current = onChange
  contentRef.current = content

  useEffect(() => {
    if (!containerRef.current) return

    let destroyed = false
    loadCodeMirror().then(cm => {
      if (destroyed || !containerRef.current) return
      // Use contentRef to get latest content (avoids stale closure if content arrived while CM was loading)
      const view = cm.createEditorView(
        containerRef.current,
        contentRef.current,
        (value: string) => {
          onChangeRef.current(value)
        },
        filePath,
      )
      viewRef.current = view
    })

    return () => {
      destroyed = true
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
      }
    }
  }, [filePath]) // Remount on file change (different language)

  // Update content from external changes (disk change, file switch)
  useEffect(() => {
    if (viewRef.current) {
      const currentContent = viewRef.current.state.doc.toString()
      if (currentContent !== content) {
        viewRef.current.dispatch({
          changes: { from: 0, to: viewRef.current.state.doc.length, insert: content },
        })
      }
    }
  }, [content])

  return <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" />
}

export const FileEditor = memo(function FileEditor({ sessionId }: { sessionId: string }) {
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
  } = useFileEditor(sessionId)

  const [showHistory, setShowHistory] = useState(false)
  const [previewMode, setPreviewMode] = useState(true)

  // Load file list on mount
  useEffect(() => {
    loadFileList()
  }, [loadFileList])

  // Auto-open file from Ctrl+K file picker
  const pendingFilePath = useSessionsStore(state => state.pendingFilePath)
  useEffect(() => {
    if (pendingFilePath && files.length > 0) {
      const match = files.find(f => f.path === pendingFilePath)
      if (match) {
        openFile(match.path)
      }
      useSessionsStore.getState().setPendingFilePath(null)
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

  return (
    <div className="flex h-full">
      {/* File list sidebar */}
      <div className="w-44 shrink-0 border-r border-border">
        <FileList
          files={files}
          activeFile={activeFile}
          dirty={dirty}
          onSelect={handleOpenFile}
          onRefresh={loadFileList}
          loading={loading}
        />
      </div>

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
          previewMode ? (
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
