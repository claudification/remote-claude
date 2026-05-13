import { Copy, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { haptic } from '@/lib/utils'

interface Toast {
  id: number
  title: string
  body: string
  conversationId?: string
  taskId?: string
  toastId?: string
  variant?: string
  /** When true, the toast does not auto-dismiss -- the user must close it. */
  persistent?: boolean
  /** When set, the toast renders a copy-to-clipboard button for this string. */
  copyText?: string
}

let nextId = 0

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    function handleToast(e: Event) {
      const { title, body, conversationId, taskId, toastId, variant, persistent, copyText } = (e as CustomEvent).detail
      const id = nextId++
      haptic('double')
      setToasts(prev => [...prev, { id, title, body, conversationId, taskId, toastId, variant, persistent, copyText }])
      if (!persistent) {
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 8000)
      }
    }
    window.addEventListener('rclaude-toast', handleToast)
    return () => window.removeEventListener('rclaude-toast', handleToast)
  }, [])

  function dismiss(id: number, toastId?: string) {
    if (toastId) {
      window.dispatchEvent(new CustomEvent(`toast-dismissed:${toastId}`))
    }
    setToasts(prev => prev.filter(x => x.id !== id))
  }

  function handleClick(toast: Toast) {
    if (toast.taskId) {
      window.dispatchEvent(new CustomEvent('open-project-task', { detail: { taskId: toast.taskId } }))
    } else if (toast.conversationId) {
      useConversationsStore.getState().selectConversation(toast.conversationId)
    }
    dismiss(toast.id, toast.toastId)
  }

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`bg-background border rounded-lg shadow-lg p-3 animate-in slide-in-from-right-5 fade-in duration-200 ${t.variant === 'warning' ? 'border-orange-500/50' : t.variant === 'success' ? 'border-amber-500/50' : 'border-accent/50'} ${t.conversationId || t.taskId ? 'cursor-pointer hover:border-accent' : ''}`}
          onClick={() => handleClick(t)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleClick(t)
          }}
          role="button"
          tabIndex={0}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div
                className={`text-xs font-bold uppercase tracking-wider ${t.variant === 'warning' ? 'text-orange-400' : 'text-accent'}`}
              >
                {t.title}
              </div>
              <div className="text-sm text-foreground mt-1 whitespace-pre-line">{t.body}</div>
              {t.copyText ? (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    navigator.clipboard?.writeText(t.copyText!).catch(() => {})
                    haptic('tap')
                  }}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded bg-muted hover:bg-muted/70 text-foreground"
                >
                  <Copy className="w-3 h-3" />
                  copy command
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                dismiss(t.id, t.toastId)
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
