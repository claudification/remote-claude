/**
 * Shift+? keyboard shortcut help overlay
 * Shows all available shortcuts in a demoscene-aesthetic modal
 */

import { useMemo, useState } from 'react'
import { formatShortcut, getCommandGeneration, getCommands, useCommand } from '@/lib/commands'
import { useKeyLayer } from '@/lib/key-layers'

const INPUT_SHORTCUTS = [
  { keys: 'Enter', action: 'Send message' },
  { keys: 'Shift+Enter', action: 'New line' },
  { keys: 'Ctrl+V / Paste', action: 'Paste text or images' },
  { keys: 'Drag+Drop', action: 'Attach files' },
]

export function ShortcutHelp() {
  const [open, setOpen] = useState(false)

  useCommand('shortcut-help', () => setOpen(v => !v), {
    label: 'Keyboard shortcuts',
    shortcut: 'shift+?',
    group: 'Help',
  })
  useKeyLayer({ Escape: () => setOpen(false) }, { id: 'shortcut-help', enabled: open })

  const _gen = getCommandGeneration()
  // biome-ignore lint/correctness/useExhaustiveDependencies: _gen is a generation counter dep key that invalidates memoized command list when registry changes
  const shortcuts = useMemo(
    () =>
      getCommands()
        .filter(c => c.shortcut)
        .map(c => ({ keys: formatShortcut(c.shortcut ?? ''), action: c.label })),
    [_gen],
  )

  if (!open) return null

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay closes on click
    <div
      role="presentation"
      className="fixed inset-0 z-[70] flex items-center justify-center"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        className="w-full max-w-md bg-[#16161e] border border-[#33467c] shadow-2xl font-mono p-6"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        <pre className="text-[#7aa2f7] text-[10px] leading-tight mb-4 select-none">
          {`┌──────────────────────────────────────┐
│  ██╗  ██╗███████╗██╗   ██╗███████╗  │
│  ██║ ██╔╝██╔════╝╚██╗ ██╔╝██╔════╝  │
│  █████╔╝ █████╗   ╚████╔╝ ███████╗  │
│  ██╔═██╗ ██╔══╝    ╚██╔╝  ╚════██║  │
│  ██║  ██╗███████╗   ██║   ███████║  │
│  ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚══════╝  │
└──────────────────────────────────────┘`}
        </pre>

        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Global</div>
          {shortcuts.map(s => (
            <div key={s.keys} className="flex items-center justify-between py-1 border-b border-[#33467c]/30">
              <kbd className="px-1.5 py-0.5 bg-[#33467c]/40 text-[#7aa2f7] text-[11px]">{s.keys}</kbd>
              <span className="text-[11px] text-[#a9b1d6]">{s.action}</span>
            </div>
          ))}
        </div>

        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-wider text-[#565f89] mb-2">Input Bar</div>
          {INPUT_SHORTCUTS.map(s => (
            <div key={s.keys} className="flex items-center justify-between py-1 border-b border-[#33467c]/30">
              <kbd className="px-1.5 py-0.5 bg-[#33467c]/40 text-[#7aa2f7] text-[11px]">{s.keys}</kbd>
              <span className="text-[11px] text-[#a9b1d6]">{s.action}</span>
            </div>
          ))}
        </div>

        <div className="text-center text-[10px] text-[#565f89]">
          Press <kbd className="px-1 py-0.5 bg-[#33467c]/30 text-[#7aa2f7]">Esc</kbd> or{' '}
          <kbd className="px-1 py-0.5 bg-[#33467c]/30 text-[#7aa2f7]">Shift+?</kbd> to close
        </div>
      </div>
    </div>
  )
}
