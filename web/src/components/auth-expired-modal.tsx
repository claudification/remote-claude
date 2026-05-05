import { useConversationsStore } from '@/hooks/use-conversations'

export function AuthExpiredModal() {
  const authExpired = useConversationsStore(s => s.authExpired)
  if (!authExpired) return null

  function handleSignOut() {
    fetch('/auth/logout', { method: 'POST' }).finally(() => {
      window.location.reload()
    })
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center p-4">
      <div className="w-full max-w-sm border border-destructive/50 bg-background p-6 font-mono text-center space-y-4">
        <div className="text-destructive text-lg font-bold tracking-wider">SESSION EXPIRED</div>
        <div className="text-sm text-muted-foreground">
          Your authentication session has expired or was revoked. Sign in again to continue.
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          className="w-full px-4 py-3 bg-destructive text-destructive-foreground font-bold text-sm hover:bg-destructive/80 transition-colors"
        >
          SIGN IN AGAIN
        </button>
      </div>
    </div>
  )
}
