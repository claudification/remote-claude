/**
 * Inline launch toasts for profile runs.
 *
 * Module-level pubsub so runProfile() can fire toasts without prop-drilling.
 * Container component subscribes and renders.
 */

import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { openEditProfile } from './run-profile'

const LAUNCHING_TTL_MS = 3000
const BLOCKED_TTL_MS = 8000

export type ToastVariant = 'launching' | 'blocked' | 'failed'

export interface LaunchToastItem {
  id: number
  variant: ToastVariant
  title: string
  body: string
  conversationId?: string
  profileId?: string
  expiresAt: number
}

let nextId = 1
const listeners = new Set<(toasts: LaunchToastItem[]) => void>()
let toasts: LaunchToastItem[] = []

function publish() {
  for (const l of listeners) l(toasts)
}

export function pushLaunchToast(t: Omit<LaunchToastItem, 'id' | 'expiresAt'>): number {
  const ttl = t.variant === 'launching' ? LAUNCHING_TTL_MS : BLOCKED_TTL_MS
  const id = nextId++
  toasts = [...toasts, { ...t, id, expiresAt: Date.now() + ttl }]
  publish()
  return id
}

export function dismissLaunchToast(id: number) {
  toasts = toasts.filter(t => t.id !== id)
  publish()
}

export function LaunchToastContainer() {
  const [items, setItems] = useState<LaunchToastItem[]>(toasts)

  useEffect(() => {
    listeners.add(setItems)
    return () => {
      listeners.delete(setItems)
    }
  }, [])

  useEffect(() => {
    if (items.length === 0) return
    const next = Math.min(...items.map(t => t.expiresAt))
    const handle = window.setTimeout(
      () => {
        const now = Date.now()
        toasts = toasts.filter(t => t.expiresAt > now)
        publish()
      },
      Math.max(0, next - Date.now()),
    )
    return () => window.clearTimeout(handle)
  }, [items])

  if (items.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-[120] flex flex-col gap-2 max-w-sm">
      {items.map(t => (
        <LaunchToastRow key={t.id} toast={t} />
      ))}
    </div>
  )
}

function LaunchToastRow({ toast }: { toast: LaunchToastItem }) {
  const ringRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (toast.variant !== 'launching') return
    const el = ringRef.current
    if (!el) return
    const total = toast.expiresAt - Date.now()
    if (total <= 0) return
    el.style.transition = `width ${total}ms linear`
    requestAnimationFrame(() => {
      el.style.width = '0%'
    })
  }, [toast])

  return (
    <div className={`bg-background border shadow-lg p-3 font-mono text-xs ${borderForVariant(toast.variant)}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={`uppercase tracking-wider text-[10px] font-bold ${titleForVariant(toast.variant)}`}>
            {toast.title}
          </div>
          <div className="text-foreground mt-1 whitespace-pre-line">{toast.body}</div>
        </div>
        <button
          type="button"
          onClick={() => dismissLaunchToast(toast.id)}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <Actions toast={toast} />
      {toast.variant === 'launching' && (
        <div className="mt-2 h-0.5 bg-muted overflow-hidden">
          <div ref={ringRef} className="h-full bg-accent" style={{ width: '100%' }} />
        </div>
      )}
    </div>
  )
}

function Actions({ toast }: { toast: LaunchToastItem }) {
  if (toast.variant === 'launching' && toast.conversationId) {
    return (
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => {
            useConversationsStore.getState().terminateConversation(toast.conversationId!, 'dashboard-launch-toast')
            dismissLaunchToast(toast.id)
          }}
          className="text-[11px] text-destructive hover:underline"
        >
          Cancel launch
        </button>
      </div>
    )
  }
  if ((toast.variant === 'blocked' || toast.variant === 'failed') && toast.profileId) {
    return (
      <div className="mt-2 flex justify-end gap-3">
        <button
          type="button"
          onClick={() => {
            openEditProfile(toast.profileId!)
            dismissLaunchToast(toast.id)
          }}
          className="text-[11px] text-primary hover:underline"
        >
          Edit profile
        </button>
      </div>
    )
  }
  return null
}

function borderForVariant(v: ToastVariant): string {
  if (v === 'blocked') return 'border-warning/60'
  if (v === 'failed') return 'border-destructive/60'
  return 'border-accent/60'
}

function titleForVariant(v: ToastVariant): string {
  if (v === 'blocked') return 'text-warning'
  if (v === 'failed') return 'text-destructive'
  return 'text-accent'
}
