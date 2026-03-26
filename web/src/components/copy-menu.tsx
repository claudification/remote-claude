/**
 * CopyMenu - Copy button with format options.
 * Desktop: click = copy markdown, right-click = format picker (Radix ContextMenu).
 * Mobile: tap = format picker (Radix DropdownMenu).
 *
 * Formats: Rich Text, Markdown, Plain Text, Image (when captureRef provided).
 */

import { Check, Copy } from 'lucide-react'
import { Marked } from 'marked'
import { ContextMenu, DropdownMenu } from 'radix-ui'
import { useRef, useState } from 'react'
import { cn, haptic, isMobileViewport } from '@/lib/utils'

const marked = new Marked()

type CopyFormat = 'rich' | 'markdown' | 'plain' | 'image'

interface FormatOption {
  key: CopyFormat
  label: string
  desc: string
}

const TEXT_FORMATS: FormatOption[] = [
  { key: 'rich', label: 'Rich Text', desc: 'Bold, bullets, links' },
  { key: 'markdown', label: 'Markdown', desc: 'Raw source' },
  { key: 'plain', label: 'Plain Text', desc: 'No formatting' },
]

const IMAGE_FORMAT: FormatOption = { key: 'image', label: 'Image', desc: 'Copy as PNG' }

function stripHtml(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || div.innerText || ''
}

function markdownToHtml(md: string): string {
  return marked.parse(md, { async: false }) as string
}

async function copyAsText(text: string, format: 'rich' | 'markdown' | 'plain') {
  switch (format) {
    case 'markdown':
      await navigator.clipboard.writeText(text)
      break
    case 'plain': {
      const html = markdownToHtml(text)
      await navigator.clipboard.writeText(stripHtml(html))
      break
    }
    case 'rich': {
      const html = markdownToHtml(text)
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([stripHtml(html)], { type: 'text/plain' }),
          }),
        ])
      } catch {
        await navigator.clipboard.writeText(stripHtml(html))
      }
      break
    }
  }
}

// Pre-load html-to-image eagerly on first import - must be ready before user gesture
let toBlobFn: typeof import('html-to-image').toBlob | null = null
import('html-to-image').then(mod => {
  toBlobFn = mod.toBlob
})

async function copyAsImage(element: HTMLElement) {
  if (!toBlobFn) throw new Error('html-to-image not loaded yet')

  const bgColor = getComputedStyle(document.body).backgroundColor || '#0a0a0a'
  const pad = Math.round(parseFloat(getComputedStyle(element).fontSize) * 1.25)

  // Capture element as-is, then add padding via canvas post-processing.
  // All DOM manipulation approaches fail (clones lose styles, reparenting
  // breaks rendering, cssText gets ignored by html-to-image's clone).
  const blobPromise = toBlobFn(element, {
    pixelRatio: 2,
    backgroundColor: bgColor,
    filter: (node: HTMLElement) => {
      if (node.dataset?.copyMenu === 'true') return false
      if (node.classList?.contains('code-copy-btn')) return false
      if (node.classList?.contains('table-source')) return false
      return true
    },
  }).then(async blob => {
    if (!blob) throw new Error('toBlob returned null')

    // Add padding via canvas
    const img = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    const p = pad * 2 // pixelRatio already applied by toBlob
    canvas.width = img.width + p * 2
    canvas.height = img.height + p * 2
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    ctx.fillStyle = bgColor
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, p, p)
    img.close()

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('canvas toBlob failed'))), 'image/png')
    })
  })

  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })])
}

// Shared menu styling
const menuContentClass =
  'min-w-[170px] bg-popover border border-border rounded-lg shadow-xl py-1 z-[100] animate-in fade-in zoom-in-95 duration-100'
const menuLabelClass = 'px-3 py-1.5 text-[10px] text-muted-foreground uppercase tracking-wider font-bold'
const menuSepClass = 'h-px bg-border my-1'
const menuItemClass =
  'px-3 py-2.5 sm:py-2 hover:bg-accent/50 active:bg-accent focus:bg-accent/50 outline-none transition-colors cursor-pointer flex flex-col gap-0.5'

interface CopyMenuProps {
  text: string
  className?: string
  iconClassName?: string
  /** Enable "Copy as Image" - captures the button's parent element */
  copyAsImage?: boolean
}

export function CopyMenu({ text, className, iconClassName = 'w-3 h-3', copyAsImage: enableImage }: CopyMenuProps) {
  const [copied, setCopied] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const formats = enableImage ? [...TEXT_FORMATS, IMAGE_FORMAT] : TEXT_FORMATS

  function flashCopied() {
    setCopied(true)
    haptic('success')
    setTimeout(() => setCopied(false), 1500)
  }

  function handleSelect(format: CopyFormat) {
    haptic('tap')
    if (format === 'image') {
      const el = buttonRef.current?.parentElement
      if (el)
        copyAsImage(el)
          .then(flashCopied)
          .catch(() => haptic('error'))
    } else {
      copyAsText(text, format).then(flashCopied)
    }
  }

  function handleOpen() {
    haptic('double')
    window.getSelection()?.removeAllRanges()
  }

  const buttonClass = cn('text-muted-foreground/40 hover:text-muted-foreground transition-colors p-0.5', className)
  const icon = copied ? <Check className={cn(iconClassName, 'text-emerald-400')} /> : <Copy className={iconClassName} />

  // Mobile: tap opens dropdown menu with format options
  if (isMobileViewport()) {
    return (
      <DropdownMenu.Root onOpenChange={open => open && handleOpen()}>
        <DropdownMenu.Trigger asChild>
          <button ref={buttonRef} type="button" className={buttonClass} title="Copy options" data-copy-menu="true">
            {icon}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className={menuContentClass} align="end" sideOffset={5}>
            <DropdownMenu.Label className={menuLabelClass}>Copy as</DropdownMenu.Label>
            <DropdownMenu.Separator className={menuSepClass} />
            {formats.map(opt => (
              <DropdownMenu.Item key={opt.key} className={menuItemClass} onSelect={() => handleSelect(opt.key)}>
                <span className="text-sm font-medium text-foreground">{opt.label}</span>
                <span className="text-[11px] text-muted-foreground">{opt.desc}</span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    )
  }

  // Desktop: click = copy markdown, right-click = format picker
  return (
    <ContextMenu.Root onOpenChange={open => open && handleOpen()}>
      <ContextMenu.Trigger asChild>
        <button
          ref={buttonRef}
          type="button"
          className={buttonClass}
          title="Copy (right-click for options)"
          data-copy-menu="true"
          onClick={e => {
            e.stopPropagation()
            haptic('tap')
            navigator.clipboard.writeText(text).then(flashCopied)
          }}
        >
          {icon}
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContentClass} alignOffset={5}>
          <ContextMenu.Label className={menuLabelClass}>Copy as</ContextMenu.Label>
          <ContextMenu.Separator className={menuSepClass} />
          {formats.map(opt => (
            <ContextMenu.Item key={opt.key} className={menuItemClass} onSelect={() => handleSelect(opt.key)}>
              <span className="text-xs font-medium text-foreground">{opt.label}</span>
              <span className="text-[10px] text-muted-foreground">{opt.desc}</span>
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
