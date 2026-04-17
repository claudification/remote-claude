import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const CODE_LABELS: Record<string, string> = {
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  MetaLeft: 'Left Cmd',
  MetaRight: 'Right Cmd',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Backspace: 'Backspace',
  Delete: 'Del',
  Insert: 'Ins',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  PrintScreen: 'PrtSc',
  ScrollLock: 'ScrLk',
  Pause: 'Pause',
  NumLock: 'NumLk',
  ContextMenu: 'Menu',
  Space: 'Space',
  CapsLock: 'Caps',
  Enter: 'Enter',
  Tab: 'Tab',
}

export function formatKeyCode(code: string): string {
  if (code in CODE_LABELS) return CODE_LABELS[code]
  const fKey = code.match(/^F(\d{1,2})$/)
  if (fKey) return `F${fKey[1]}`
  const numpad = code.match(/^Numpad(.+)$/)
  if (numpad) return `Num ${numpad[1]}`
  const letter = code.match(/^Key([A-Z])$/)
  if (letter) return letter[1]
  const digit = code.match(/^Digit(\d)$/)
  if (digit) return digit[1]
  return code
}

// Disallowed: keys that conflict with normal usage
const DISALLOWED_KEYS = new Set(['Escape', 'Tab', 'Enter', 'Backspace', 'Delete'])

export function KeyCapture({ value, onChange }: { value: string | null; onChange: (code: string | null) => void }) {
  const [capturing, setCapturing] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const handleCapture = useCallback(() => setCapturing(true), [])

  useEffect(() => {
    if (!capturing) return

    function handleKeyDown(e: KeyboardEvent) {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') {
        setCapturing(false)
        return
      }
      if (DISALLOWED_KEYS.has(e.code)) return
      onChange(e.code)
      setCapturing(false)
    }

    function handleClickOutside(e: MouseEvent) {
      if (!buttonRef.current?.contains(e.target as Node)) setCapturing(false)
    }

    // Small delay so the click that opened capture doesn't immediately fire
    const t = setTimeout(() => {
      window.addEventListener('keydown', handleKeyDown, { capture: true })
      window.addEventListener('mousedown', handleClickOutside)
    }, 100)

    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
      window.removeEventListener('mousedown', handleClickOutside)
    }
  }, [capturing, onChange])

  return (
    <div className="flex items-center gap-2">
      <button
        ref={buttonRef}
        type="button"
        onClick={capturing ? () => setCapturing(false) : handleCapture}
        className={cn(
          'px-3 py-1 text-xs font-mono border rounded transition-all min-w-[100px] text-center',
          capturing
            ? 'border-blue-500 bg-blue-500/20 text-blue-400 animate-pulse'
            : value
              ? 'border-border bg-muted text-foreground'
              : 'border-border/50 bg-muted/50 text-muted-foreground',
        )}
      >
        {capturing ? 'Press a key...' : value ? formatKeyCode(value) : 'Not set'}
      </button>
      {value && !capturing && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-[10px] text-muted-foreground hover:text-destructive"
        >
          clear
        </button>
      )}
    </div>
  )
}
