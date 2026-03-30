/**
 * Shared files + clipboard copy history view
 * Shows uploads via share_file MCP tool and clipboard captures from OSC 52
 */

import { useEffect, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { cn, haptic } from '@/lib/utils'

const API_BASE = ''

interface SharedFile {
  hash: string
  filename: string
  mediaType: string
  sessionId?: string
  size: number
  url: string
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

export function SharedView({ sessionId }: { sessionId: string }) {
  const [files, setFiles] = useState<SharedFile[]>([])
  const [loading, setLoading] = useState(true)
  const clipboardCaptures = useSessionsStore(s => s.clipboardCaptures)
  const sessionClips = clipboardCaptures.filter(c => c.sessionId === sessionId)

  useEffect(() => {
    setLoading(true)
    fetch(`${API_BASE}/api/shared-files?sessionId=${sessionId}`)
      .then(r => r.json())
      .then((data: { files: SharedFile[] }) => setFiles(data.files || []))
      .catch(() => setFiles([]))
      .finally(() => setLoading(false))
  }, [sessionId])

  // Merge files + clips into a unified timeline
  type Item = { kind: 'file'; file: SharedFile } | { kind: 'clip'; clip: (typeof sessionClips)[0] }

  const items: Item[] = [
    ...sessionClips.map(clip => ({ kind: 'clip' as const, clip })),
    ...files.map(file => ({ kind: 'file' as const, file })),
  ].sort((a, b) => {
    const ta = a.kind === 'file' ? a.file.createdAt : a.clip.timestamp
    const tb = b.kind === 'file' ? b.file.createdAt : b.clip.timestamp
    return tb - ta // newest first
  })

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs font-mono">loading...</div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs font-mono">
        No shared files or clipboard copies yet
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 space-y-2">
      {items.map(item => {
        if (item.kind === 'file') {
          const f = item.file
          return (
            <div
              key={f.hash}
              className="flex items-start gap-3 p-2.5 border border-border rounded hover:bg-muted/20 transition-colors"
            >
              {isImage(f.mediaType) ? (
                <a href={f.url} target="_blank" rel="noopener noreferrer">
                  <img
                    src={f.url}
                    alt={f.filename}
                    className="w-16 h-16 object-cover rounded border border-border/30 shrink-0"
                  />
                </a>
              ) : (
                <div className="w-16 h-16 flex items-center justify-center bg-muted/30 rounded border border-border/30 shrink-0">
                  <span className="text-[10px] text-muted-foreground font-mono uppercase">
                    {f.mediaType.split('/')[1]?.slice(0, 4) || 'file'}
                  </span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="px-1.5 py-0.5 text-[9px] font-bold bg-emerald-500/20 text-emerald-400 uppercase">
                    shared
                  </span>
                  <span className="text-[10px] text-muted-foreground">{formatTime(f.createdAt)}</span>
                  <span className="text-[10px] text-muted-foreground/50">{formatSize(f.size)}</span>
                </div>
                <div className="text-xs font-mono text-foreground/80 truncate mt-0.5" title={f.filename}>
                  {f.filename}
                </div>
                <div className="flex items-center gap-1.5 mt-1.5">
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
                </div>
              </div>
            </div>
          )
        }

        // Clipboard capture
        const c = item.clip
        return (
          <div key={c.id} className="flex items-start gap-3 p-2.5 border border-cyan-500/20 rounded bg-cyan-500/5">
            <div className="w-16 h-16 flex items-center justify-center bg-cyan-500/10 rounded border border-cyan-500/20 shrink-0">
              <span className="text-lg">{c.contentType === 'image' ? '\uD83D\uDDBC' : '\uD83D\uDCCB'}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="px-1.5 py-0.5 text-[9px] font-bold bg-cyan-500/20 text-cyan-400 uppercase">copy</span>
                <span className="text-[10px] text-muted-foreground">{formatTime(c.timestamp)}</span>
              </div>
              {c.contentType === 'text' && c.text && (
                <pre className="text-[10px] text-foreground/70 font-mono truncate mt-0.5 max-w-full overflow-hidden">
                  {c.text.length > 120 ? `${c.text.slice(0, 120)}...` : c.text}
                </pre>
              )}
              {c.contentType === 'image' && c.base64 && (
                <img
                  src={`data:${c.mimeType || 'image/png'};base64,${c.base64}`}
                  alt="clipboard"
                  className="max-h-16 rounded mt-0.5"
                />
              )}
              <div className="flex items-center gap-1.5 mt-1.5">
                <button
                  type="button"
                  onClick={() => {
                    haptic('tap')
                    if (c.text) copyText(c.text)
                  }}
                  className={cn(
                    'px-2 py-0.5 text-[10px] font-bold border transition-colors',
                    c.text
                      ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/25'
                      : 'bg-muted/10 text-muted-foreground/30 border-border/20 cursor-not-allowed',
                  )}
                  disabled={!c.text}
                >
                  COPY
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
