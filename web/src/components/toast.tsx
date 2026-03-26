import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { haptic } from '@/lib/utils'

interface Toast {
  id: number
  title: string
  body: string
  sessionId?: string
}

let nextId = 0

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    function handleToast(e: Event) {
      const { title, body, sessionId } = (e as CustomEvent).detail
      const id = nextId++
      haptic('double')
      setToasts(prev => [...prev, { id, title, body, sessionId }])
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 8000)
    }
    window.addEventListener('rclaude-toast', handleToast)
    return () => window.removeEventListener('rclaude-toast', handleToast)
  }, [])

  function dismiss(id: number) {
    setToasts(prev => prev.filter(x => x.id !== id))
  }

  function handleClick(toast: Toast) {
    if (toast.sessionId) {
      useSessionsStore.getState().selectSession(toast.sessionId)
    }
    dismiss(toast.id)
  }

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`bg-background border border-accent/50 rounded-lg shadow-lg p-3 animate-in slide-in-from-right-5 fade-in duration-200 ${t.sessionId ? 'cursor-pointer hover:border-accent' : ''}`}
          onClick={() => handleClick(t)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleClick(t)
          }}
          role="button"
          tabIndex={0}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-bold text-accent uppercase tracking-wider">{t.title}</div>
              <div className="text-sm text-foreground mt-1">{t.body}</div>
            </div>
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                dismiss(t.id)
              }}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
