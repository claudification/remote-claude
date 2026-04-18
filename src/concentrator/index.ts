#!/usr/bin/env bun
/**
 * Claude Code Session Concentrator
 * Aggregates sessions from multiple rclaude instances
 */

import { checkBunVersion } from '../shared/bun-version'

checkBunVersion()

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONCENTRATOR_PORT } from '../shared/protocol'
import { getOrAssign, initAddressBook, resolve } from './address-book'
import { closeAnalyticsStore, initAnalyticsStore } from './analytics-store'
import { getUser, initAuth, reloadState, validateSession } from './auth'
import { getAuthenticatedUser, requireAuth, setRclaudeSecret, setShareValidator } from './auth-routes'
import { closeCostStore, initCostStore } from './cost-store'
import { type ContextDeps, createContext } from './create-context'
import { initGlobalSettings } from './global-settings'
import type { WsData } from './handler-context'
import { registerAllHandlers } from './handlers'
import { appendMessage, initInterSessionLog } from './inter-session-log'
import { drain, enqueue, getQueueSize, initMessageQueue } from './message-queue'
import { routeMessage } from './message-router'
import { initModelPricing } from './model-pricing'
import { addAllowedRoot, addPathMapping, getAllowedRoots } from './path-jail'
import { allGrantsExpired } from './permissions'
import {
  addPersistedLink,
  findLink,
  getLinksForCwd,
  initProjectLinks,
  removePersistedLink,
  touchLink,
} from './project-links'
import { initProjectOrder } from './project-order'
import { getAllProjectSettings, getProjectSettings, initProjectSettings, setProjectSettings } from './project-settings'
import { closeProjectStore, initProjectStore } from './project-store'
import { initPush, isPushConfigured, sendPushToAll } from './push'
import { createRouter } from './routes'
import { createSessionStore } from './session-store'
import {
  cleanExpired as cleanExpiredShares,
  initShares,
  shareToGrants as shareToGrantList,
  validateShare as validateShareToken,
} from './shares'
import { cleanupVoiceForWs } from './voice-stream'
import { createWsServer } from './ws-server'

interface Args {
  port: number
  apiPort?: number
  verbose: boolean
  cacheDir?: string
  clearCache: boolean
  noPersistence: boolean
  webDir?: string
  allowedRoots: string[]
  pathMaps: Array<{ from: string; to: string }>
  rpId?: string
  origins: string[]
  rclaudeSecret?: string
  vapidPublicKey?: string
  vapidPrivateKey?: string
}

function parseArgs(): Args {
  const args = process.argv.slice(2)
  let port = DEFAULT_CONCENTRATOR_PORT
  let apiPort: number | undefined
  let verbose = false
  let cacheDir: string | undefined
  let clearCache = false
  let noPersistence = false
  let webDir: string | undefined
  const allowedRoots: string[] = []
  const pathMaps: Array<{ from: string; to: string }> = []
  let rpId: string | undefined
  const origins: string[] = []
  let rclaudeSecret: string | undefined
  // vapidPublicKey and vapidPrivateKey declared after arg parsing (env-only)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--port' || arg === '-p') {
      port = parseInt(args[++i], 10)
    } else if (arg === '--api-port') {
      apiPort = parseInt(args[++i], 10)
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--cache-dir') {
      cacheDir = args[++i]
    } else if (arg === '--clear-cache') {
      clearCache = true
    } else if (arg === '--no-persistence') {
      noPersistence = true
    } else if (arg === '--web-dir' || arg === '-w') {
      webDir = args[++i]
    } else if (arg === '--allow-root') {
      allowedRoots.push(args[++i])
    } else if (arg === '--rp-id') {
      rpId = args[++i]
    } else if (arg === '--origin') {
      origins.push(args[++i])
    } else if (arg === '--rclaude-secret') {
      rclaudeSecret = args[++i]
    } else if (arg === '--path-map') {
      const mapping = args[++i]
      const sep = mapping.indexOf(':')
      if (sep > 0) {
        pathMaps.push({ from: mapping.slice(0, sep), to: mapping.slice(sep + 1) })
      }
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  // Env fallbacks
  if (!rclaudeSecret) rclaudeSecret = process.env.RCLAUDE_SECRET
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY

  return {
    port,
    apiPort,
    verbose,
    cacheDir,
    clearCache,
    noPersistence,
    webDir,
    allowedRoots,
    pathMaps,
    rpId,
    origins,
    rclaudeSecret,
    vapidPublicKey,
    vapidPrivateKey,
  }
}

function printHelp() {
  console.log(`
concentrator - Claude Code Session Aggregator

Receives session events from rclaude instances and provides a unified view.

USAGE:
  concentrator [OPTIONS]

OPTIONS:
  -p, --port <port>      WebSocket port (default: ${DEFAULT_CONCENTRATOR_PORT})
  --api-port <port>      REST API port (default: same as WebSocket)
  -v, --verbose          Enable verbose logging
  -w, --web-dir <dir>    Serve web dashboard from directory
  --cache-dir <dir>      Session cache directory (default: ~/.cache/concentrator)
  --clear-cache          Clear session cache and exit
  --no-persistence       Disable session persistence
  --allow-root <dir>     Add allowed filesystem root (repeatable)
  --rp-id <domain>       WebAuthn relying party ID (default: localhost)
  --origin <url>         Allowed WebAuthn origin (repeatable, default: http://localhost:PORT)
  --rclaude-secret <s>   Shared secret for rclaude WebSocket auth (or RCLAUDE_SECRET env)
  -h, --help             Show this help message

ENDPOINTS:
  WebSocket:
    ws://localhost:${DEFAULT_CONCENTRATOR_PORT}/      Connect session

  REST API:
    GET  /sessions                List all sessions
    GET  /sessions?active=true    List active sessions only
    GET  /sessions/:id            Get session details
    GET  /sessions/:id/events     Get session events
    POST /sessions/:id/input      Send input to session
    GET  /health                  Health check

EXAMPLES:
  concentrator                   # Start on default port
  concentrator -p 8080           # Start on port 8080
  concentrator -v                # Start with verbose logging
  concentrator --clear-cache     # Clear cached sessions
`)
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

async function main() {
  const {
    port,
    apiPort,
    verbose,
    cacheDir,
    clearCache,
    noPersistence,
    webDir,
    allowedRoots: extraRoots,
    pathMaps,
    rpId,
    origins,
    rclaudeSecret,
    vapidPublicKey,
    vapidPrivateKey,
  } = parseArgs()

  // rclaude secret is required - no open WebSocket ingest
  if (!rclaudeSecret) {
    console.error('ERROR: --rclaude-secret or RCLAUDE_SECRET is required')
    process.exit(1)
  }
  setRclaudeSecret(rclaudeSecret)

  // Configure path jail - register allowed filesystem roots
  // Auto-detect ~/.claude for transcript access
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/root'
  const claudeDir = `${homeDir}/.claude`
  addAllowedRoot(claudeDir)

  // Add web dir if specified
  if (webDir) addAllowedRoot(webDir)

  // Add any extra roots from --allow-root flags
  for (const root of extraRoots) {
    addAllowedRoot(root)
  }

  // Register path mappings (host path -> container path)
  for (const { from, to } of pathMaps) {
    addPathMapping(from, to)
  }

  if (verbose) {
    console.log(`[jail] Allowed roots: ${getAllowedRoots().join(', ')}`)
    if (pathMaps.length > 0) {
      console.log(`[jail] Path mappings: ${pathMaps.map(m => `${m.from} -> ${m.to}`).join(', ')}`)
    }
  }

  // Initialize passkey auth
  const authCacheDir = cacheDir || `${homeDir}/.cache/concentrator`
  const defaultOrigins = [`http://localhost:${port}`]
  initAuth({
    cacheDir: authCacheDir,
    rpId: rpId || 'localhost',
    expectedOrigins: origins.length > 0 ? origins : defaultOrigins,
  })

  // Initialize model pricing (LiteLLM database)
  initModelPricing(authCacheDir)

  // Initialize project registry (must be before analytics -- migration depends on it)
  initProjectStore(authCacheDir)

  // Initialize cost reporting store (SQLite)
  initCostStore(authCacheDir)

  // Initialize analytics store (SQLite, non-critical)
  initAnalyticsStore(authCacheDir)

  // Initialize settings
  initProjectSettings(authCacheDir)
  initGlobalSettings(authCacheDir)
  initProjectOrder(authCacheDir)
  initProjectLinks(authCacheDir)
  initInterSessionLog(authCacheDir)
  initAddressBook(authCacheDir)
  initMessageQueue(authCacheDir)
  initShares({ cacheDir: authCacheDir })
  setShareValidator(token => validateShareToken(token) !== null)

  // Initialize web push (optional - needs VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY env vars)
  if (vapidPublicKey && vapidPrivateKey) {
    initPush({
      vapidPublicKey,
      vapidPrivateKey,
      vapidSubject: origins.length > 0 ? origins[0] : `http://localhost:${port}`,
    })
    console.log(`[push] Web Push configured (VAPID key: ${vapidPublicKey.slice(0, 12)}...)`)
  } else {
    console.log('[push] Web Push disabled (set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY to enable)')
  }

  const sessionStore = createSessionStore({
    cacheDir,
    enablePersistence: !noPersistence,
  })

  // Handle --clear-cache
  if (clearCache) {
    await sessionStore.clearState()
    console.log('Cache cleared.')
    process.exit(0)
  }

  // Save state on shutdown
  process.on('SIGINT', async () => {
    console.log('\n[shutdown] Saving state...')
    closeAnalyticsStore()
    closeCostStore()
    closeProjectStore()
    await Promise.all([sessionStore.saveState(), sessionStore.flushTranscripts()])
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    closeAnalyticsStore()
    closeCostStore()
    closeProjectStore()
    await Promise.all([sessionStore.saveState(), sessionStore.flushTranscripts()])
    process.exit(0)
  })
  process.on('SIGHUP', () => {
    reloadState()
    console.log('[auth] Reloaded auth state from disk (SIGHUP)')

    // Terminate WS connections for revoked users
    const subscribers = sessionStore.getSubscribers()
    for (const ws of subscribers) {
      const userName = (ws.data as { userName?: string }).userName
      if (userName) {
        const user = getUser(userName)
        if (!user || user.revoked) {
          console.log(`[auth] Terminating WS for revoked user: ${userName}`)
          sessionStore.removeTerminalViewerBySocket(ws)
          sessionStore.removeSubscriber(ws)
          try {
            ws.close(4401, 'User revoked')
          } catch {}
        } else {
          // Hot-reload grants on live connections
          ;(ws.data as { grants?: unknown }).grants = user.grants
        }
      }
    }
  })

  // Periodically close dashboard WS connections with expired auth tokens
  setInterval(() => {
    const subscribers = sessionStore.getSubscribers()
    for (const ws of subscribers) {
      const data = ws.data as { authToken?: string; userName?: string }
      if (!data.authToken) continue // rclaude/agent connections use secret, not tokens
      const session = validateSession(data.authToken)
      if (!session) {
        console.log(`[auth] Closing expired WS for user: ${data.userName || 'unknown'}`)
        sessionStore.removeTerminalViewerBySocket(ws)
        sessionStore.removeSubscriber(ws)
        try {
          ws.close(4401, 'Session expired')
        } catch {}
      }
    }
  }, 60_000) // check every minute

  // Periodically check grant expiry -- disconnect users whose grants have all expired
  setInterval(() => {
    const subscribers = sessionStore.getSubscribers()
    for (const ws of subscribers) {
      const data = ws.data as WsData
      if (!data.grants || data.grants.length === 0) continue
      if (allGrantsExpired(data.grants)) {
        console.log(`[auth] All grants expired for user: ${data.userName || 'unknown'} -- disconnecting`)
        sessionStore.removeTerminalViewerBySocket(ws)
        sessionStore.removeSubscriber(ws)
        try {
          ws.close(4403, 'Grants expired')
        } catch {}
      }
    }
  }, 30_000) // check every 30 seconds

  // Periodically expire share tokens and close guest connections
  setInterval(() => {
    const expired = cleanExpiredShares()
    if (expired.length > 0) {
      const subscribers = sessionStore.getSubscribers()
      for (const ws of subscribers) {
        const data = ws.data as { shareToken?: string }
        if (data.shareToken && expired.includes(data.shareToken)) {
          console.log(`[shares] Closing expired share viewer (token: ${data.shareToken.slice(0, 8)}...)`)
          try {
            ws.send(JSON.stringify({ type: 'share_expired', reason: 'Share session has expired' }))
            ws.close(4403, 'Share expired')
          } catch {}
        }
      }
      sessionStore.broadcastSharesUpdate()
    }
  }, 30_000) // check every 30 seconds

  // Write PID file so CLI can send signals
  if (cacheDir) {
    const pidFile = join(cacheDir, 'concentrator.pid')
    writeFileSync(pidFile, String(process.pid))
  }

  // Create WebSocket server
  const wsServer = createWsServer({
    port,
    sessionStore,
    onSessionStart(sessionId, meta) {
      if (verbose) {
        console.log(`[+] Session started: ${sessionId.slice(0, 8)}... (${meta.cwd})`)
      }
    },
    onSessionEnd(sessionId, reason) {
      if (verbose) {
        console.log(`[-] Session ended: ${sessionId.slice(0, 8)}... (${reason})`)
      }
    },
    onHookEvent(sessionId, event) {
      if (verbose) {
        const toolName = 'tool_name' in event.data ? (event.data.tool_name as string) : ''
        const suffix = toolName ? ` (${toolName})` : ''
        console.log(`[*] ${sessionId.slice(0, 8)}... ${event.hookEvent}${suffix}`)
      }

      // Auto-send push notification on Notification hook events
      if (event.hookEvent === 'Notification' && isPushConfigured()) {
        const session = sessionStore.getSession(sessionId)
        const cwd = session?.cwd?.split('/').slice(-2).join('/') || sessionId.slice(0, 8)
        const d = event.data as Record<string, unknown>
        const message = (d?.message as string) || 'Awaiting input...'
        const notifType = (d?.notification_type as string) || 'Notification'
        sendPushToAll({
          title: `${notifType} - ${cwd}`,
          body: message,
          sessionId,
          tag: `notification-${sessionId}`,
        }).catch(() => {})
      }

      // Auto-send push on session Stop (Claude finished working)
      if (event.hookEvent === 'Stop' && isPushConfigured()) {
        const session = sessionStore.getSession(sessionId)
        const cwd = session?.cwd?.split('/').slice(-2).join('/') || sessionId.slice(0, 8)
        const d = event.data as Record<string, unknown>
        const reason = (d?.stop_hook_reason as string) || 'completed'
        sendPushToAll({
          title: `Session stopped - ${cwd}`,
          body: reason,
          sessionId,
          tag: `stop-${sessionId}`,
        }).catch(() => {})
      }
    },
  })

  // Create Hono router with all HTTP routes
  const serverStartTime = Date.now()
  const router = createRouter({
    sessionStore,
    webDir,
    vapidPublicKey,
    rclaudeSecret,
    cacheDir: authCacheDir,
    serverStartTime,
    publicOrigin: origins[0],
  })

  if (apiPort && apiPort !== port) {
    // Separate API server (Hono handles all HTTP)
    Bun.serve({
      port: apiPort,
      fetch: router.fetch,
    })
    console.log(`REST API listening on http://localhost:${apiPort}`)
  } else {
    // Combined HTTP + WebSocket server
    wsServer.stop()

    // Register message handlers
    registerAllHandlers()

    // Context deps shared by all handler contexts
    const contextDeps: ContextDeps = {
      sessions: sessionStore,
      verbose,
      origins,
      getProjectSettings,
      setProjectSettings,
      getAllProjectSettings,
      pushConfigured: isPushConfigured(),
      pushSendToAll: payload => {
        if (isPushConfigured()) sendPushToAll(payload)
      },
      getLinksForCwd,
      findLink: (cwdA: string, cwdB: string) => !!findLink(cwdA, cwdB),
      addLink: addPersistedLink,
      removeLink: removePersistedLink,
      touchLink,
      logMessage: appendMessage,
      addressBook: { getOrAssign, resolve },
      messageQueue: { enqueue, drain, getQueueSize },
    }

    Bun.serve<WsData>({
      port,
      async fetch(req, server) {
        // WebSocket upgrade must happen before Hono (Bun needs server.upgrade -> undefined)
        const url = new URL(req.url)
        if (
          req.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
          (url.pathname === '/' || url.pathname === '/ws')
        ) {
          // Share token auth (link-based guest access)
          const shareToken = url.searchParams.get('share')
          if (shareToken) {
            const share = validateShareToken(shareToken)
            if (!share) return new Response('Invalid or expired share link', { status: 401 })
            const success = server.upgrade(req, {
              data: {
                isShare: true,
                shareToken,
                hideUserInput: share.hideUserInput || false,
                grants: shareToGrantList(share),
              } as WsData,
            })
            if (success) return undefined
            return new Response('WebSocket upgrade failed', { status: 500 })
          }

          // Auth check for WS connections (requireAuth handles secret/cookie/token)
          const authBlock = requireAuth(req)
          if (authBlock) return authBlock

          const wsUserName = getAuthenticatedUser(req) ?? undefined
          // Extract auth token for periodic expiry checks on the WS connection
          const cookieHeader = req.headers.get('cookie')
          const tokenMatch = cookieHeader?.match(/concentrator-session=([^;]+)/)
          const authToken = tokenMatch?.[1]
          // Load grants for permission enforcement on WS messages
          const wsUser = wsUserName ? getUser(wsUserName) : undefined
          const success = server.upgrade(req, {
            data: { userName: wsUserName, authToken, grants: wsUser?.grants } as WsData,
          })
          if (success) return undefined
          return new Response('WebSocket upgrade failed', { status: 500 })
        }

        // All HTTP routes handled by Hono (auth middleware included)
        return router.fetch(req)
      },
      websocket: {
        // Keep connections alive through proxies (Cloudflare, nginx, etc.)
        idleTimeout: 120, // seconds - close after 120s of no data
        sendPings: true, // auto-send WebSocket pings to keep alive
        open(_ws) {
          // Connection established
        },
        message(ws, message) {
          try {
            const msgStr = message as string
            sessionStore.recordTraffic('in', msgStr.length)
            const data = JSON.parse(msgStr)

            // Route to registered handler
            const ctx = createContext(ws, contextDeps)
            if (!routeMessage(ctx, data.type, data) && verbose) {
              console.log(`[ws] Unhandled message type: ${data.type}`)
            }
          } catch (error) {
            ws.send(
              JSON.stringify({
                type: 'error',
                message: `Failed to process message: ${error}`,
              }),
            )
          }
        },
        close(ws, code, reason) {
          if (verbose) {
            const id = ws.data.sessionId?.slice(0, 8) || (ws.data.isDashboard ? 'dashboard' : 'unknown')
            console.log(`[ws] Connection closed: ${id} code=${code} reason=${reason || 'none'}`)
          }

          // Handle agent disconnection
          if (ws.data.isAgent) {
            sessionStore.removeAgent(ws)
            if (verbose) {
              console.log('[agent] Host agent disconnected')
            }
            return
          }

          // Handle dashboard subscriber disconnection
          if (ws.data.isDashboard) {
            // Clean up any active voice streaming session
            cleanupVoiceForWs(ws)
            // If this dashboard was viewing a terminal, remove from viewers
            sessionStore.removeTerminalViewerBySocket(ws)
            // Clean up launch job subscriptions
            sessionStore.cleanupJobSubscriber(ws)
            sessionStore.removeSubscriber(ws)
            if (verbose) {
              console.log(`[dashboard] Subscriber disconnected (total: ${sessionStore.getSubscriberCount()})`)
            }
            return
          }

          // Handle rclaude session disconnection
          const sessionId = ws.data.sessionId
          const closeWrapperId = ws.data.wrapperId
          if (sessionId && closeWrapperId) {
            // Notify terminal viewers attached to this wrapper's PTY
            const viewers = sessionStore.getTerminalViewers(closeWrapperId)
            if (viewers.size > 0) {
              const msg = JSON.stringify({
                type: 'terminal_error',
                wrapperId: closeWrapperId,
                error: 'Wrapper disconnected',
              })
              for (const viewer of viewers) {
                try {
                  viewer.send(msg)
                } catch {}
              }
              for (const viewer of viewers) {
                sessionStore.removeTerminalViewer(closeWrapperId, viewer)
              }
            }

            // Remove this wrapper's socket
            sessionStore.removeSessionSocket(sessionId, closeWrapperId)
            const remaining = sessionStore.getActiveWrapperCount(sessionId)

            const session = sessionStore.getSession(sessionId)
            if (session && session.status !== 'ended' && remaining === 0) {
              // Last wrapper disconnected - end the session
              sessionStore.endSession(sessionId, 'connection_closed')
              if (verbose) {
                console.log(`[-] Session ended: ${sessionId.slice(0, 8)}... (connection_closed, last wrapper)`)
              }

              // Check for pending restart (terminate + auto-revive)
              const pendingRestart = sessionStore.consumePendingRestart(closeWrapperId)
              if (pendingRestart) {
                const agent = sessionStore.getAgent()
                if (agent) {
                  const wrapperId = crypto.randomUUID()
                  console.log(
                    `[restart] Reviving after disconnect: ${pendingRestart.cwd.split('/').pop()} wrapperId=${wrapperId.slice(0, 8)}`,
                  )
                  agent.send(
                    JSON.stringify({
                      type: 'revive',
                      sessionId: session.id,
                      cwd: pendingRestart.cwd,
                      wrapperId,
                      mode: 'resume',
                    }),
                  )

                  // Register rendezvous for caller (if not self-restart)
                  if (!pendingRestart.isSelfRestart) {
                    sessionStore
                      .addRendezvous(wrapperId, pendingRestart.callerSessionId, pendingRestart.cwd, 'restart')
                      .then(revived => {
                        const callerWs = sessionStore.getSessionSocket(pendingRestart.callerSessionId)
                        callerWs?.send(
                          JSON.stringify({
                            type: 'restart_ready',
                            sessionId: revived.id,
                            cwd: revived.cwd,
                            wrapperId,
                            session: revived,
                          }),
                        )
                      })
                      .catch(err => {
                        const callerWs = sessionStore.getSessionSocket(pendingRestart.callerSessionId)
                        callerWs?.send(
                          JSON.stringify({
                            type: 'restart_timeout',
                            wrapperId,
                            cwd: pendingRestart.cwd,
                            error: typeof err === 'string' ? err : 'Restart rendezvous timed out',
                          }),
                        )
                      })
                  }
                } else {
                  console.log('[restart] No agent connected - cannot revive after restart')
                }
              }
            } else if (verbose && remaining > 0) {
              console.log(
                `[~] Wrapper ${closeWrapperId.slice(0, 8)} disconnected from session ${sessionId.slice(0, 8)}... (${remaining} wrapper(s) remaining)`,
              )
            }
          }
        },
      },
    })
  }

  const webDirDisplay = webDir ? webDir.padEnd(55) : 'Built-in UI'.padEnd(55)
  console.log(`
┌─────────────────────────────────────────────────────────────────────────────┐
│  CLAUDE CONCENTRATOR                                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  WebSocket:  ws://localhost:${String(port).padEnd(5)}                                          │
│  REST API:   http://localhost:${String(apiPort || port).padEnd(5)}                                        │
│  Dashboard:  ${webDirDisplay} │
│  Verbose:    ${verbose ? 'ON ' : 'OFF'}                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
`)

  // Print status periodically
  if (verbose) {
    setInterval(() => {
      const sessions = sessionStore.getActiveSessions()
      if (sessions.length > 0) {
        console.log(`\n[i] Active sessions: ${sessions.length}`)
        for (const session of sessions) {
          const age = formatDuration(Date.now() - session.startedAt)
          const idle = formatDuration(Date.now() - session.lastActivity)
          console.log(
            `    ${session.id.slice(0, 8)}... [${session.status.toUpperCase()}] age=${age} idle=${idle} events=${session.events.length}`,
          )
        }
      }
    }, 60000)
  }
}

main()
