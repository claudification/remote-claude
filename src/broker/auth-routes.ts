/**
 * WebAuthn Authentication Routes
 *
 * Registration: invite token -> challenge -> passkey creation -> session cookie
 * Authentication: challenge -> passkey assertion -> session cookie
 */

import { timingSafeEqual } from 'node:crypto'
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import {
  addCredential,
  consumeInvite,
  createAuthToken,
  createUser,
  findUserByCredentialId,
  getChallenge,
  getExpectedOrigins,
  getRpId,
  getRpName,
  getUser,
  hasAnyUsers,
  renewSessionIfNeeded,
  revokeSession,
  SESSION_MAX_AGE_MS,
  type StoredCredential,
  storeChallenge,
  updateCredentialCounter,
  validateInvite,
  validateSession,
} from './auth'

import type { SentinelRegistry } from './sentinel-registry'
import { isSentinelSecret } from './sentinel-registry'

let rclaudeSecret: string | undefined
let validateShareFn: ((token: string) => boolean) | undefined
let sentinelRegistryRef: SentinelRegistry | undefined

export function setRclaudeSecret(secret: string): void {
  rclaudeSecret = secret
}

export function setShareValidator(fn: (token: string) => boolean): void {
  validateShareFn = fn
}

export function setSentinelRegistry(registry: SentinelRegistry): void {
  sentinelRegistryRef = registry
}

export type AuthResult = { role: 'admin' } | { role: 'sentinel'; sentinelId: string; alias: string } | { role: 'none' }

export function resolveAuth(secret: string): AuthResult {
  if (rclaudeSecret && safeStringEqual(secret, rclaudeSecret)) {
    return { role: 'admin' }
  }
  if (sentinelRegistryRef && isSentinelSecret(secret)) {
    const sentinel = sentinelRegistryRef.findBySecret(secret)
    if (sentinel) {
      return { role: 'sentinel', sentinelId: sentinel.sentinelId, alias: sentinel.aliases[0] }
    }
  }
  return { role: 'none' }
}

function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

const SESSION_COOKIE_NAME = 'cw-session'
const SESSION_MAX_AGE_S = SESSION_MAX_AGE_MS / 1000

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function setCookie(signedToken: string): string {
  const secure = getExpectedOrigins().some(o => o.startsWith('https://'))
  return `${SESSION_COOKIE_NAME}=${signedToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}${secure ? '; Secure' : ''}`
}

function clearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

function getCookieValue(req: Request): string | null {
  const cookieHeader = req.headers.get('cookie')
  if (!cookieHeader) return null
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))
  return match ? match[1] : null
}

/**
 * Check if a request is authenticated.
 * Returns the user name or null.
 */
export function getAuthenticatedUser(req: Request): string | null {
  const token = getCookieValue(req)
  if (!token) return null
  const session = validateSession(token)
  return session?.name ?? null
}

/**
 * Routes that are ALWAYS accessible without authentication.
 * Everything else requires a valid, non-revoked passkey session.
 */
const PUBLIC_AUTH_ROUTES = new Set([
  '/auth/status',
  '/auth/invite/validate',
  '/auth/register/options',
  '/auth/register/verify',
  '/auth/login/options',
  '/auth/login/verify',
])

/**
 * Auth middleware check. Returns null if authenticated, or a Response to send.
 * Skips auth if no users exist yet (first-time setup).
 *
 * DENY BY DEFAULT. Only explicitly listed routes are public.
 */
export function requireAuth(req: Request): Response | null {
  // No users registered yet = open access (must use invite to register first)
  if (!hasAnyUsers()) return null

  const url = new URL(req.url)

  // Health check always accessible (for Docker healthcheck / monitoring)
  if (url.pathname === '/health') return null

  // Crash reports are public (errors can happen before/during auth)
  if (url.pathname === '/api/crash') return null

  // Static assets must be public - SPA handles auth UI client-side
  if (
    url.pathname === '/manifest.json' ||
    url.pathname === '/favicon.ico' ||
    url.pathname === '/sw.js' ||
    url.pathname.startsWith('/icon-') ||
    url.pathname === '/apple-touch-icon.png' ||
    url.pathname.startsWith('/assets/')
  )
    return null

  // Uploaded files are public (Claude needs to fetch them without auth)
  if (url.pathname.startsWith('/file/')) return null

  // Specific auth routes needed for login/registration flow (no cookie yet)
  if (PUBLIC_AUTH_ROUTES.has(url.pathname)) return null

  // WebSocket: rclaude authenticates with shared secret or per-sentinel secret, dashboard with session cookie/token
  if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const secret = url.searchParams.get('secret')
    if (secret) {
      const auth = resolveAuth(secret)
      if (auth.role !== 'none') return null
    }
    if (getAuthenticatedUser(req)) return null
    const token = url.searchParams.get('token')
    if (token && validateSession(token)) return null
    return new Response('Unauthorized', { status: 401 })
  }

  // Everything else requires authentication (cookie or Bearer token)
  const isAuthenticated = getAuthenticatedUser(req)
  if (isAuthenticated) return null

  // Allow Bearer token auth with admin secret or sentinel secret (for API calls from scripts)
  const authHeader = req.headers.get('authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (bearerToken) {
    const auth = resolveAuth(bearerToken)
    if (auth.role !== 'none') return null
  }

  // Share token auth (guest access via link)
  const shareToken = url.searchParams.get('share')
  if (shareToken && validateShareFn?.(shareToken)) return null

  // Not authenticated - only allow SPA HTML navigation for non-API paths
  // API paths (/sessions, /file, etc.) must NEVER fall through without auth
  const accept = req.headers.get('accept') || ''
  const isApiPath =
    url.pathname.startsWith('/conversations') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')
  if (accept.includes('text/html') && !isApiPath) {
    return null // SPA handles showing login screen
  }

  return jsonResponse({ error: 'Unauthorized' }, 401)
}

/**
 * Handle auth API routes. Returns a Response or null if not an auth route.
 */
export async function handleAuthRoute(req: Request): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  // --- Status ---
  if (path === '/auth/status' && req.method === 'GET') {
    const userName = getAuthenticatedUser(req)
    const token = getCookieValue(req)
    const headers: Record<string, string> = {}
    // Silently renew session cookie if past halfway point
    if (userName && token && renewSessionIfNeeded(token)) {
      headers['Set-Cookie'] = setCookie(token)
    }
    const userObj = userName ? getUser(userName) : undefined
    return jsonResponse(
      {
        authenticated: !!userName,
        name: userName,
        hasUsers: hasAnyUsers(),
        grants: userObj?.grants,
      },
      200,
      headers,
    )
  }

  // --- Validate invite ---
  if (path === '/auth/invite/validate' && req.method === 'POST') {
    const { token } = (await req.json()) as { token: string }
    const invite = validateInvite(token)
    if (!invite) {
      return jsonResponse({ valid: false, error: 'Invalid or expired invite' }, 400)
    }
    return jsonResponse({ valid: true, name: invite.name })
  }

  // --- Registration: generate options ---
  if (path === '/auth/register/options' && req.method === 'POST') {
    const { token } = (await req.json()) as { token: string }
    const invite = validateInvite(token)
    if (!invite) {
      return jsonResponse({ error: 'Invalid or expired invite' }, 400)
    }

    const options = await generateRegistrationOptions({
      rpName: getRpName(),
      rpID: getRpId(),
      userName: invite.name,
      userDisplayName: invite.name,
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'discouraged',
      },
    })

    // Store challenge keyed by invite token
    storeChallenge(`reg:${token}`, options.challenge)

    return jsonResponse(options)
  }

  // --- Registration: verify ---
  if (path === '/auth/register/verify' && req.method === 'POST') {
    const { token, response } = (await req.json()) as { token: string; response: RegistrationResponseJSON }
    const invite = validateInvite(token)
    if (!invite) {
      return jsonResponse({ error: 'Invalid or expired invite' }, 400)
    }

    const expectedChallenge = getChallenge(`reg:${token}`)
    if (!expectedChallenge) {
      return jsonResponse({ error: 'Challenge expired. Try again.' }, 400)
    }

    try {
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedRPID: getRpId(),
        expectedOrigin: getExpectedOrigins(),
        requireUserVerification: false,
      })

      if (!verification.verified || !verification.registrationInfo) {
        return jsonResponse({ error: 'Verification failed' }, 400)
      }

      const { credential } = verification.registrationInfo

      // Create user + store credential (pass grants from invite)
      let user = getUser(invite.name)
      if (!user) {
        user = createUser(invite.name, invite.grants)
      }

      const storedCred: StoredCredential = {
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: response.response?.transports as AuthenticatorTransportFuture[] | undefined,
        registeredAt: Date.now(),
      }

      addCredential(invite.name, storedCred)
      consumeInvite(token)

      // Create session
      const sessionToken = createAuthToken(invite.name)

      return new Response(JSON.stringify({ verified: true, name: invite.name }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': setCookie(sessionToken),
        },
      })
    } catch (error) {
      return jsonResponse({ error: `Registration failed: ${error}` }, 400)
    }
  }

  // --- Authentication: generate options ---
  if (path === '/auth/login/options' && req.method === 'POST') {
    const options = await generateAuthenticationOptions({
      rpID: getRpId(),
      allowCredentials: [], // Empty = discoverable credentials mode (no QR code)
      userVerification: 'discouraged',
    })

    // Store challenge with a random key, return key to client
    const challengeKey = crypto.randomUUID()
    storeChallenge(`auth:${challengeKey}`, options.challenge)

    return jsonResponse({ ...options, challengeKey })
  }

  // --- Authentication: verify ---
  if (path === '/auth/login/verify' && req.method === 'POST') {
    const { challengeKey, response } = (await req.json()) as {
      challengeKey: string
      response: AuthenticationResponseJSON
    }

    const expectedChallenge = getChallenge(`auth:${challengeKey}`)
    if (!expectedChallenge) {
      return jsonResponse({ error: 'Challenge expired. Try again.' }, 400)
    }

    // Find the credential
    const credentialId = response.id
    const user = findUserByCredentialId(credentialId)
    if (!user) {
      return jsonResponse({ error: 'Unknown credential' }, 400)
    }

    const credential = user.credentials.find(c => c.credentialId === credentialId)
    if (!credential) {
      return jsonResponse({ error: 'Credential not found' }, 400)
    }

    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedRPID: getRpId(),
        expectedOrigin: getExpectedOrigins(),
        requireUserVerification: false,
        credential: {
          id: credentialId,
          publicKey: Buffer.from(credential.publicKey, 'base64url'),
          counter: credential.counter,
          transports: credential.transports,
        },
      })

      if (!verification.verified) {
        return jsonResponse({ error: 'Authentication failed' }, 400)
      }

      // Update counter
      updateCredentialCounter(credentialId, verification.authenticationInfo.newCounter)

      // Create session
      const sessionToken = createAuthToken(user.name)

      return new Response(JSON.stringify({ verified: true, name: user.name }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': setCookie(sessionToken),
        },
      })
    } catch (error) {
      return jsonResponse({ error: `Authentication failed: ${error}` }, 400)
    }
  }

  // --- Logout ---
  if (path === '/auth/logout' && req.method === 'POST') {
    const token = getCookieValue(req)
    if (token) revokeSession(token)

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': clearCookie(),
      },
    })
  }

  return null
}
