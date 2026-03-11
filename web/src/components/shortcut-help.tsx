/**
 * Shift+? keyboard shortcut help overlay
 * Shows all available shortcuts in a demoscene-aesthetic modal
 */

import { useEffect, useState } from 'react'

const SHORTCUTS = [
  { keys: 'Ctrl+K', action: 'Session switcher (fuzzy finder)' },
  { keys: 'Ctrl+K F:', action: 'File browser (in switcher)' },
  { keys: 'Ctrl+Shift+N', action: 'Quick note (append to NOTES.md)' },
  { keys: 'Ctrl+Shift+D', action: 'Toggle debug console' },
  { keys: 'Ctrl+Shift+T', action: 'Open terminal for current session' },
  { keys: 'Ctrl+O', action: 'Toggle verbose / expand all' },
  { keys: 'Shift+Click TTY', action: 'Popout terminal to new window' },
  { keys: 'Shift+?', action: 'This help screen' },
  { keys: 'Esc', action: 'Close modal / exit file picker' },
]

const INPUT_SHORTCUTS = [
  { keys: 'Enter', action: 'Send message' },
  { keys: 'Shift+Enter', action: 'New line' },
  { keys: 'Ctrl+V / Paste', action: 'Paste text or images' },
  { keys: 'Drag+Drop', action: 'Attach files' },
]

export function ShortcutHelp() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === '?' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        // Don't trigger when typing in inputs/textareas/contenteditable or terminal
        const el = e.target as HTMLElement
        const tag = el?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (el?.closest('.xterm') || el?.getAttribute('contenteditable')) return
        e.preventDefault()
        setOpen(v => !v)
      }
      if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" onClick={() => setOpen(false)}>
      <div
        className="w-full max-w-md bg-[#16161e] border border-[#33467c] shadow-2xl font-mono p-6"
        onClick={e => e.stopPropagation()}
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
          {SHORTCUTS.map(s => (
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
