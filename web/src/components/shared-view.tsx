/**
 * Shared files + clipboard copy history view (per-CWD, server-side)
 * Shows uploads via share_file MCP tool and clipboard captures from OSC 52
 */

import { useEffect, useState } from 'react'
import { cn, haptic } from '@/lib/utils'

const API_BASE = ''

interface SharedFileEntry {
  type: 'file' | 'clipboard'
  hash: string
  filename: string
  mediaType: string
  projectPath?: string
  conversationId?: string
  size: number
  url: string
  text?: string
  createdAt: number
}

function isImage(mediaType: string): boolean {
  return mediaType.startsWith('image/')
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays === 0) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function copyText(text: string) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;left:-9999px;top:0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  document.execCommand('copy')
  document.body.removeChild(ta)
}

export function SharedView({ projectPath }: { projectPath: string }) {
  const [files, setFiles] = useState<SharedFileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [seq, setSeq] = useState(0) // bump to re-fetch after delete

  // biome-ignore lint/correctness/useExhaustiveDependencies: seq is a counter dep key used to trigger re-fetch after delete; not accessed in the body
  useEffect(() => {
    setLoading(true)
    fetch(`${API_BASE}/api/shared-files?project=${encodeURIComponent(projectPath)}`)
      .then(r => r.json())
      .then((data: { files: SharedFileEntry[] }) => setFiles(data.files || []))
      .catch(() => setFiles([]))
      .finally(() => setLoading(false))
  }, [projectPath, seq])

  function handleDelete(hash: string) {
    haptic('tick')
    fetch(`${API_BASE}/api/shared-files/${hash}`, { method: 'DELETE' })
      .then(() => setSeq(s => s + 1))
      .catch(() => {})
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs font-mono">loading...</div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs font-mono">
        No shared files or clipboard copies yet
      </div>
    )
  }

  function handleClearAll() {
    if (!files.length) return
    haptic('error')
    Promise.all(files.map(f => fetch(`${API_BASE}/api/shared-files/${f.hash}`, { method: 'DELETE' })))
      .then(() => setSeq(s => s + 1))
      .catch(() => {})
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 space-y-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-muted-foreground/50 font-mono">{files.length} items</span>
        <button
          type="button"
          onClick={handleClearAll}
          className="text-[10px] font-mono text-muted-foreground/50 hover:text-destructive transition-colors"
        >
          Clear all
        </button>
      </div>
      {files.map(f => (
        <div
          key={f.hash}
          className={cn(
            'flex items-start gap-3 p-2.5 border rounded',
            f.type === 'clipboard'
              ? 'border-cyan-500/20 bg-cyan-500/5'
              : 'border-border hover:bg-muted/20 transition-colors',
          )}
        >
          {/* Thumbnail / icon */}
          {f.type === 'file' && isImage(f.mediaType) ? (
            <a href={f.url} target="_blank" rel="noopener noreferrer">
              <img
                src={f.url}
                alt={f.filename}
                className="w-16 h-16 object-cover rounded border border-border/30 shrink-0"
              />
            </a>
          ) : (
            <div
              className={cn(
                'w-16 h-16 flex items-center justify-center rounded border shrink-0',
                f.type === 'clipboard' ? 'bg-cyan-500/10 border-cyan-500/20' : 'bg-muted/30 border-border/30',
              )}
            >
              <span className="text-lg">{f.type === 'clipboard' ? '\uD83D\uDCCB' : '\uD83D\uDCC4'}</span>
            </div>
          )}

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'px-1.5 py-0.5 text-[9px] font-bold uppercase',
                  f.type === 'clipboard' ? 'bg-cyan-500/20 text-cyan-400' : 'bg-emerald-500/20 text-emerald-400',
                )}
              >
                {f.type === 'clipboard' ? 'copy' : 'shared'}
              </span>
              <span className="text-[10px] text-muted-foreground">{formatTime(f.createdAt)}</span>
              {f.type === 'file' && <span className="text-[10px] text-muted-foreground/50">{formatSize(f.size)}</span>}
            </div>

            {f.type === 'file' && (
              <div className="text-xs font-mono text-foreground/80 truncate mt-0.5" title={f.filename}>
                {f.filename}
              </div>
            )}

            {f.type === 'clipboard' && f.text && (
              <pre className="text-[10px] text-foreground/70 font-mono truncate mt-0.5 max-w-full overflow-hidden whitespace-pre-wrap max-h-16">
                {f.text.length > 200 ? `${f.text.slice(0, 200)}...` : f.text}
              </pre>
            )}

            <div className="flex items-center gap-1.5 mt-1.5">
              {f.type === 'file' && f.url && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      haptic('tap')
                      copyText(f.url)
                    }}
                    className="px-2 py-0.5 text-[10px] font-bold bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/25 transition-colors"
                  >
                    COPY URL
                  </button>
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2 py-0.5 text-[10px] font-bold bg-muted/20 text-muted-foreground border border-border/30 hover:bg-muted/30 transition-colors"
                  >
                    OPEN
                  </a>
                </>
              )}
              {f.type === 'clipboard' && f.text && (
                <button
                  type="button"
                  onClick={() => {
                    haptic('tap')
                    copyText(f.text || '')
                  }}
                  className="px-2 py-0.5 text-[10px] font-bold bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/25 transition-colors"
                >
                  COPY
                </button>
              )}
              <button
                type="button"
                onClick={() => handleDelete(f.hash)}
                className="px-2 py-0.5 text-[10px] font-bold bg-muted/10 text-muted-foreground/50 border border-border/20 hover:text-destructive hover:border-destructive/30 transition-colors"
              >
                DELETE
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
