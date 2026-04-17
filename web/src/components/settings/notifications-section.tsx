import { Bell, BellOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getPushStatus, subscribeToPush } from '@/hooks/use-sessions'

export function NotificationsSection() {
  const [pushState, setPushState] = useState<
    'loading' | 'unsupported' | 'prompt' | 'subscribing' | 'subscribed' | 'denied'
  >('loading')

  useEffect(() => {
    getPushStatus().then(status => {
      if (!status.supported) setPushState('unsupported')
      else if (status.subscribed) setPushState('subscribed')
      else if (status.permission === 'denied') setPushState('denied')
      else setPushState('prompt')
    })
  }, [])

  async function handlePushToggle() {
    if (pushState === 'subscribing') return
    setPushState('subscribing')
    const result = await subscribeToPush()
    setPushState(result.success ? 'subscribed' : 'denied')
  }

  async function handleReRegister() {
    if (pushState === 'subscribing') return
    setPushState('subscribing')
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js')
      if (reg) {
        const sub = await reg.pushManager.getSubscription()
        if (sub) await sub.unsubscribe()
      }
    } catch {}
    const result = await subscribeToPush()
    setPushState(result.success ? 'subscribed' : 'denied')
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-foreground">Push notifications</div>
          <div className="text-[10px] text-muted-foreground">Get notified when Claude needs input</div>
        </div>
        <button
          type="button"
          onClick={handlePushToggle}
          disabled={pushState === 'unsupported' || pushState === 'loading'}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border transition-colors ${
            pushState === 'subscribed'
              ? 'bg-active/20 text-active border-active/50'
              : pushState === 'denied'
                ? 'bg-red-400/20 text-red-400 border-red-400/50'
                : pushState === 'unsupported'
                  ? 'bg-muted text-muted-foreground border-border cursor-not-allowed'
                  : 'bg-transparent text-foreground border-border hover:border-primary'
          }`}
        >
          {pushState === 'subscribed' ? <Bell className="w-3 h-3" /> : <BellOff className="w-3 h-3" />}
          {pushState === 'loading' && '...'}
          {pushState === 'unsupported' && 'Not supported'}
          {pushState === 'subscribing' && 'Enabling...'}
          {pushState === 'subscribed' && 'Enabled'}
          {pushState === 'denied' && 'Denied'}
          {pushState === 'prompt' && 'Enable'}
        </button>
      </div>
      {pushState === 'subscribed' && (
        <button
          type="button"
          onClick={handleReRegister}
          className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
        >
          Re-register push (use after VAPID key change)
        </button>
      )}
    </div>
  )
}
