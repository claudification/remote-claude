/**
 * Auth Gate - WebAuthn passkey login/registration
 *
 * Wraps the entire app. Shows login when unauthenticated.
 * Registration only via invite links.
 */

import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { type ReactNode, useCallback, useEffect, useState } from 'react'

const API_BASE = `${window.location.protocol}//${window.location.host}`

interface AuthStatus {
  authenticated: boolean
  name: string | null
  hasUsers: boolean
}

async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${API_BASE}/auth/status`)
  return res.json()
}

function InviteRegistration({ token, onSuccess }: { token: string; onSuccess: (name: string) => void }) {
  const [status, setStatus] = useState<'validating' | 'ready' | 'registering' | 'error'>('validating')
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`${API_BASE}/auth/invite/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.valid) {
          setName(data.name)
          setStatus('ready')
        } else {
          setError(data.error || 'Invalid invite')
          setStatus('error')
        }
      })
      .catch(() => {
        setError('Failed to validate invite')
        setStatus('error')
      })
  }, [token])

  async function handleRegister() {
    setStatus('registering')
    setError('')

    try {
      // Get registration options
      const optionsRes = await fetch(`${API_BASE}/auth/register/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const options = await optionsRes.json()

      if (options.error) {
        setError(options.error)
        setStatus('ready')
        return
      }

      // Start WebAuthn registration
      const response = await startRegistration({ optionsJSON: options })

      // Verify with server
      const verifyRes = await fetch(`${API_BASE}/auth/register/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, response }),
      })
      const result = await verifyRes.json()

      if (result.verified) {
        onSuccess(result.name)
      } else {
        setError(result.error || 'Registration failed')
        setStatus('ready')
      }
    } catch (err) {
      setError(`Registration error: ${err}`)
      setStatus('ready')
    }
  }

  if (status === 'validating') {
    return <div className="text-muted-foreground">Validating invite...</div>
  }

  if (status === 'error') {
    return (
      <div className="space-y-4">
        <pre className="text-destructive text-xs">{error}</pre>
        <div className="text-muted-foreground text-xs">This invite may be expired or already used.</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="text-xs">
        <span className="text-muted-foreground">Registering passkey for: </span>
        <span className="text-accent font-bold">{name}</span>
      </div>
      <button
        type="button"
        onClick={handleRegister}
        disabled={status === 'registering'}
        className="w-full px-4 py-3 bg-accent text-background font-bold text-sm hover:bg-accent/80 disabled:opacity-50 transition-colors"
      >
        {status === 'registering' ? 'REGISTERING...' : 'REGISTER PASSKEY'}
      </button>
      {error && <pre className="text-destructive text-xs">{error}</pre>}
    </div>
  )
}

function InviteInput({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const input = value.trim()
    if (!input) return
    // Extract token from full URL or bare token
    const urlMatch = input.match(/[#?/]invite[/=](.+?)(?:[&#]|$)/)
    onSubmit(urlMatch ? urlMatch[1] : input)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <label htmlFor="invite-input" className="text-muted-foreground text-[10px] uppercase tracking-wider">
        Have an invite?
      </label>
      <div className="flex gap-2">
        <input
          id="invite-input"
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="Paste invite URL or code"
          className="flex-1 bg-muted/30 border border-border px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={!value.trim()}
          className="px-3 py-2 bg-muted/50 border border-border text-xs font-bold text-primary hover:bg-muted disabled:opacity-30 transition-colors"
        >
          GO
        </button>
      </div>
    </form>
  )
}

function LoginView({ onSuccess }: { onSuccess: (name: string) => void }) {
  const [status, setStatus] = useState<'idle' | 'authenticating' | 'error'>('idle')
  const [error, setError] = useState('')

  const handleLogin = useCallback(async () => {
    setStatus('authenticating')
    setError('')

    try {
      // Get authentication options
      const optionsRes = await fetch(`${API_BASE}/auth/login/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const options = await optionsRes.json()
      const { challengeKey, ...authOptions } = options

      // Start WebAuthn authentication
      const response = await startAuthentication({ optionsJSON: authOptions })

      // Verify with server
      const verifyRes = await fetch(`${API_BASE}/auth/login/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeKey, response }),
      })
      const result = await verifyRes.json()

      if (result.verified) {
        onSuccess(result.name)
      } else {
        setError(result.error || 'Authentication failed')
        setStatus('idle')
      }
    } catch (err) {
      setError(`Auth error: ${err}`)
      setStatus('idle')
    }
  }, [onSuccess])

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={handleLogin}
        disabled={status === 'authenticating'}
        className="w-full px-4 py-3 bg-accent text-background font-bold text-sm hover:bg-accent/80 disabled:opacity-50 transition-colors"
      >
        {status === 'authenticating' ? 'AUTHENTICATING...' : 'LOGIN WITH PASSKEY'}
      </button>
      {error && <pre className="text-destructive text-xs mt-2">{error}</pre>}
    </div>
  )
}

function extractInviteToken(): string | null {
  // Check hash: #/invite/TOKEN
  const hashMatch = window.location.hash.match(/^#\/invite\/(.+)$/)
  if (hashMatch) return hashMatch[1]
  // Check query param: ?invite=TOKEN
  const params = new URLSearchParams(window.location.search)
  const qToken = params.get('invite')
  if (qToken) return qToken
  return null
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [inviteToken, setInviteToken] = useState<string | null>(extractInviteToken)

  // Listen for hash changes (user pastes invite URL while page is open)
  useEffect(() => {
    function onHashChange() {
      const token = extractInviteToken()
      if (token) setInviteToken(token)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    fetchAuthStatus()
      .then(setAuthStatus)
      .finally(() => setLoading(false))
  }, [])

  function handleAuthSuccess(name: string) {
    // Clear invite hash/params if present
    if (inviteToken) {
      window.location.hash = ''
      setInviteToken(null)
    }
    setAuthStatus({ authenticated: true, name, hasUsers: true })
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center font-mono text-muted-foreground text-xs">
        Initializing...
      </div>
    )
  }

  // No users registered AND no invite = show setup instructions
  if (authStatus && !authStatus.hasUsers && !inviteToken) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md border border-border p-6 font-mono">
          <pre className="text-accent text-xs mb-6">{'> FIRST TIME SETUP'}</pre>
          <div className="space-y-4 text-xs text-muted-foreground">
            <p>No passkeys registered. Create an invite via CLI:</p>
            <pre className="bg-muted/30 p-3 text-foreground overflow-x-auto">
              {'concentrator-cli create-invite --name yourname'}
            </pre>
            <p>Then open the invite link, or paste it below:</p>
          </div>
          <div className="mt-4">
            <InviteInput onSubmit={setInviteToken} />
          </div>
        </div>
      </div>
    )
  }

  // Show invite registration
  if (inviteToken) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md border border-border p-6 font-mono">
          <pre className="text-accent text-xs mb-6">{'> PASSKEY REGISTRATION'}</pre>
          <InviteRegistration token={inviteToken} onSuccess={handleAuthSuccess} />
        </div>
      </div>
    )
  }

  // Authenticated - render app
  if (authStatus?.authenticated) {
    return <>{children}</>
  }

  // Show login
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md border border-border p-6 font-mono">
        <pre className="text-primary text-xs leading-tight mb-6 whitespace-pre">
          {` ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝`}
        </pre>
        <LoginView onSuccess={handleAuthSuccess} />
        <div className="mt-6 pt-4 border-t border-border">
          <InviteInput onSubmit={setInviteToken} />
        </div>
      </div>
    </div>
  )
}
