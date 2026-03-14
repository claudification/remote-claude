/**
 * CopyMenu - Copy button with format options.
 * Short tap/click: copy as markdown (default).
 * Long-press (mobile) / right-click (desktop): show format picker via Radix ContextMenu.
 */

import { Check, Copy } from 'lucide-react'
import { Marked } from 'marked'
import { ContextMenu } from 'radix-ui'
import { useState } from 'react'
import { cn, haptic } from '@/lib/utils'

const marked = new Marked()

type CopyFormat = 'rich' | 'markdown' | 'plain'

const FORMAT_OPTIONS: Array<{ key: CopyFormat; label: string; desc: string }> = [
  { key: 'rich', label: 'Rich Text', desc: 'Bold, bullets, links' },
  { key: 'markdown', label: 'Markdown', desc: 'Raw source' },
  { key: 'plain', label: 'Plain Text', desc: 'No formatting' },
]

function stripHtml(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || div.innerText || ''
}

function markdownToHtml(md: string): string {
  return marked.parse(md, { async: false }) as string
}

async function copyAs(text: string, format: CopyFormat) {
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

interface CopyMenuProps {
  text: string
  className?: string
  iconClassName?: string
}

export function CopyMenu({ text, className, iconClassName = 'w-3 h-3' }: CopyMenuProps) {
  const [copied, setCopied] = useState(false)

  function flashCopied() {
    setCopied(true)
    haptic('success')
    setTimeout(() => setCopied(false), 1500)
  }

  function handleShortTap(e: React.MouseEvent) {
    // Radix ContextMenu may fire click after long-press dismissal on some
    // platforms. The `detail` property is 0 for synthetic/keyboard clicks
    // vs 1+ for real pointer clicks - but we allow both here since short
    // tap is always safe (idempotent copy).
    e.stopPropagation()
    haptic('tap')
    navigator.clipboard.writeText(text).then(flashCopied)
  }

  function handleSelect(format: CopyFormat) {
    haptic('tap')
    copyAs(text, format).then(flashCopied)
  }

  return (
    <ContextMenu.Root
      onOpenChange={open => {
        if (open) haptic('double')
      }}
    >
      <ContextMenu.Trigger asChild>
        <button
          type="button"
          className={cn('text-muted-foreground/40 hover:text-muted-foreground transition-colors p-0.5', className)}
          title="Copy (right-click or long-press for options)"
          onClick={handleShortTap}
        >
          {copied ? <Check className={cn(iconClassName, 'text-emerald-400')} /> : <Copy className={iconClassName} />}
        </button>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content
          className="min-w-[170px] bg-popover border border-border rounded-lg shadow-xl py-1 z-[100] animate-in fade-in zoom-in-95 duration-100"
          alignOffset={5}
        >
          <ContextMenu.Label className="px-3 py-1.5 text-[10px] text-muted-foreground uppercase tracking-wider font-bold">
            Copy as
          </ContextMenu.Label>
          <ContextMenu.Separator className="h-px bg-border my-1" />
          {FORMAT_OPTIONS.map(opt => (
            <ContextMenu.Item
              key={opt.key}
              className="px-3 py-2.5 sm:py-2 hover:bg-accent/50 active:bg-accent focus:bg-accent/50 outline-none transition-colors cursor-pointer flex flex-col gap-0.5"
              onSelect={() => handleSelect(opt.key)}
            >
              <span className="text-sm sm:text-xs font-medium text-foreground">{opt.label}</span>
              <span className="text-[11px] sm:text-[10px] text-muted-foreground">{opt.desc}</span>
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
