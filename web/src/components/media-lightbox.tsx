/**
 * MediaLightbox - full-screen image/video viewer.
 *
 * Rendered once at the app root so it survives virtualizer remounts, same
 * pattern as JsonInspectorDialog. Opens via openMediaLightbox() from anywhere
 * (markdown click delegation, attachment chips, etc.) without passing refs or
 * dialog state through the tree.
 *
 * Why this exists: when a conversation embeds `![alt](url.png)` or `[clip](url.mp4)`
 * in a transcript message, inlining the media can blow up the virtualized row
 * height and shove the whole transcript around. The markdown renderer emits a
 * bounded thumbnail chip and clicking it pops the full asset into this
 * overlay -- layout-stable, Escape/outside-click to close.
 */

import { Copy, Download, ExternalLink } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { cn, haptic } from '@/lib/utils'

export type MediaKind = 'image' | 'video'

interface MediaLightboxState {
  open: boolean
  src: string
  kind: MediaKind
  alt?: string
  show: (src: string, kind: MediaKind, alt?: string) => void
  close: () => void
}

const useMediaLightbox = create<MediaLightboxState>(set => ({
  open: false,
  src: '',
  kind: 'image',
  alt: undefined,
  show: (src, kind, alt) => set({ open: true, src, kind, alt }),
  close: () => set({ open: false }),
}))

export function openMediaLightbox(src: string, kind: MediaKind, alt?: string) {
  useMediaLightbox.getState().show(src, kind, alt)
}

export function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url, 'https://x.invalid')
    const parts = u.pathname.split('/')
    return parts[parts.length - 1] || url
  } catch {
    return url
  }
}

export function MediaLightbox() {
  const { open, src, kind, alt, close } = useMediaLightbox()
  const [copied, setCopied] = useState(false)

  // Reset copy-state when the dialog closes so it's fresh on next open.
  useEffect(() => {
    if (!open) setCopied(false)
  }, [open])

  async function handleCopyUrl() {
    try {
      await navigator.clipboard.writeText(src)
      haptic('success')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      haptic('error')
    }
  }

  function handleDownload() {
    // Anchor-with-download attr is the only cross-browser no-popup path. Some
    // servers (including CF-backed public URLs) ignore `download=filename`
    // unless same-origin, but the browser still prompts Save-As -- good
    // enough. Keeping `target=_blank` as a fallback isn't needed; the click
    // triggers the download synchronously.
    haptic('tap')
    const a = document.createElement('a')
    a.href = src
    a.download = filenameFromUrl(src)
    a.rel = 'noopener noreferrer'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const filename = filenameFromUrl(src)
  // Display label: markdown-provided alt wins, URL filename is the fallback.
  // Keeps the real filename visible via `title` so the user can still see it
  // on hover when a custom alt is shown.
  const displayLabel = alt && alt !== filename ? alt : filename

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={v => {
        if (!v) close()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-[100] bg-black/90',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-0 z-[100] flex flex-col items-center justify-center p-4 gap-3',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'focus:outline-none',
          )}
          onClick={e => {
            // Click on the backdrop area (not on the media/toolbar) closes.
            if (e.target === e.currentTarget) close()
          }}
        >
          <DialogPrimitive.Title className="sr-only">{displayLabel}</DialogPrimitive.Title>

          {/* Media display. Bounded to viewport so it never overflows.
              No stopPropagation needed: the Content-level onClick uses
              `e.target === e.currentTarget` so bubbled clicks from here
              don't trigger close. */}
          <div className="flex items-center justify-center max-w-[92vw] max-h-[calc(100vh-7rem)]">
            {open && kind === 'image' && (
              <img
                src={src}
                alt={displayLabel}
                className="max-w-[92vw] max-h-[calc(100vh-7rem)] object-contain rounded border border-border/30 shadow-2xl"
              />
            )}
            {open && kind === 'video' && (
              // biome-ignore lint/a11y/useMediaCaption: user-supplied media, captions not available
              <video
                src={src}
                controls
                autoPlay
                playsInline
                className="max-w-[92vw] max-h-[calc(100vh-7rem)] rounded border border-border/30 shadow-2xl bg-black"
              />
            )}
          </div>

          {/* Toolbar: filename + action buttons */}
          <div
            className={cn(
              'flex items-center gap-2 px-3 py-2 rounded',
              'bg-background/80 backdrop-blur border border-border/50',
              'font-mono text-[11px]',
            )}
          >
            <span className="text-muted-foreground truncate max-w-[40vw]" title={`${filename}\n${src}`}>
              {displayLabel}
            </span>
            <div className="h-4 w-px bg-border/60" />
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-2 py-1 text-foreground/80 hover:text-foreground hover:bg-muted/50 rounded transition-colors"
              title="Download"
            >
              <Download className="h-3.5 w-3.5" />
              <span>DOWNLOAD</span>
            </button>
            <button
              type="button"
              onClick={handleCopyUrl}
              className="flex items-center gap-1.5 px-2 py-1 text-foreground/80 hover:text-foreground hover:bg-muted/50 rounded transition-colors"
              title="Copy URL"
            >
              <Copy className="h-3.5 w-3.5" />
              <span>{copied ? 'COPIED' : 'COPY URL'}</span>
            </button>
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-2 py-1 text-foreground/80 hover:text-foreground hover:bg-muted/50 rounded transition-colors"
              title="Open in new tab"
              onClick={() => haptic('tick')}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>OPEN</span>
            </a>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
