#!/usr/bin/env bun
/**
 * Claudwerk Broker
 * Aggregates sessions from multiple rclaude instances
 */

import { checkBunVersion } from '../shared/bun-version'

checkBunVersion()

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractProjectLabel } from '../shared/project-uri'
import { DEFAULT_BROKER_PORT } from '../shared/protocol'
import { getOrAssign, initAddressBook, resolve } from './address-book'
import { closeAnalyticsStore, initAnalyticsStore } from './analytics-store'
import { getUser, initAuth, reloadState, validateConversation } from './auth'
import {
  getAuthenticatedUser,
  requireAuth,
  resolveAuth,
  setRclaudeSecret,
  setSentinelRegistry,
  setShareValidator,
} from './auth-routes'
import { createConversationStore } from './conversation-store'
import { type ContextDeps, createContext } from './create-context'
import { initGlobalSettings } from './global-settings'
import type { WsData } from './handler-context'
import { registerAllHandlers } from './handlers'
import { appendMessage, initInterSessionLog } from './inter-conversation-log'
import { drain, enqueue, getQueueSize, initMessageQueue } from './message-queue'
import { routeMessage } from './message-router'
import { initModelPricing } from './model-pricing'
import { addAllowedRoot, addPathMapping, getAllowedRoots } from './path-jail'
import { allGrantsExpired } from './permissions'
import {
  addPersistedLink,
  findLink,
  getLinksForProject,
  initProjectLinks,
  removePersistedLink,
  touchLink,
} from './project-links'
import { initProjectOrder } from './project-order'
import { getAllProjectSettings, getProjectSettings, initProjectSettings, setProjectSettings } from './project-settings'
import { closeProjectStore, initProjectStore } from './project-store'
import { initPush, isPushConfigured, sendPushToAll } from './push'
import { createRouter } from './routes'
import { createSentinelRegistry } from './sentinel-registry'
import {
  cleanExpired as cleanExpiredShares,
  initShares,
  shareToGrants as shareToGrantList,
  validateShare as validateShareToken,
} from './shares'
import { createStore } from './store'
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
  let port = DEFAULT_BROKER_PORT
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
  if (!rclaudeSecret) rclaudeSecret = process.env.CLAUDWERK_SECRET ?? process.env.RCLAUDE_SECRET
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
broker - Claudwerk Broker

Receives session events from rclaude instances and provides a unified view.

USAGE:
  broker [OPTIONS]

OPTIONS:
  -p, --port <port>      WebSocket port (default: ${DEFAULT_BROKER_PORT})
  --api-port <port>      REST API port (default: same as WebSocket)
  -v, --verbose          Enable verbose logging
  -w, --web-dir <dir>    Serve web dashboard from directory
  --cache-dir <dir>      Session cache directory (default: ~/.cache/broker)
  --clear-cache          Clear session cache and exit
  --no-persistence       Disable session persistence
  --allow-root <dir>     Add allowed filesystem root (repeatable)
  --rp-id <domain>       WebAuthn relying party ID (default: localhost)
  --origin <url>         Allowed WebAuthn origin (repeatable, default: http://localhost:PORT)
  --rclaude-secret <s>   Shared secret for rclaude WebSocket auth (or RCLAUDE_SECRET env)
  -h, --help             Show this help message

ENDPOINTS:
  WebSocket:
    ws://localhost:${DEFAULT_BROKER_PORT}/      Connect session

  REST API:
    GET  /conversations                List all sessions
    GET  /conversations?active=true    List active sessions only
    GET  /conversations/:id            Get session details
    GET  /conversations/:id/events     Get session events
    POST /conversations/:id/input      Send input to session
    GET  /health                  Health check

EXAMPLES:
  broker                   # Start on default port
  broker -p 8080           # Start on port 8080
  broker -v                # Start with verbose logging
  broker --clear-cache     # Clear cached sessions
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
  const authCacheDir = cacheDir || `${homeDir}/.cache/broker`
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

  // Initialize analytics store (SQLite, non-critical)
  initAnalyticsStore(authCacheDir)

  // Initialize unified store (SQLite-backed)
  const store = createStore({ type: 'sqlite', dataDir: authCacheDir })
  store.init()

  // Auto-migrate: absorb legacy JSON/JSONL/cost-data.db and canonicalize URIs
  // on every boot. Idempotent -- schema-version stamp in store.kv makes the
  // common case a single read. See src/broker/store/migrate.ts.
  {
    const { runStartupMigration, SCHEMA_VERSION } = await import('./store/migrate')
    const result = runStartupMigration(store, authCacheDir)
    if (result.skipped) {
      console.log(`[store] Schema version ${SCHEMA_VERSION} (up to date)`)
    } else {
      const summary: string[] = []
      if (result.migrated) {
        const c = result.migrated.counts
        const parts: string[] = []
        if (c.sessions) parts.push(`${c.sessions} sessions`)
        if (c.transcriptEntries) parts.push(`${c.transcriptEntries} transcript entries`)
        if (c.shares) parts.push(`${c.shares} shares`)
        if (c.addressBook) parts.push(`${c.addressBook} address-book entries`)
        if (c.costTurns) parts.push(`${c.costTurns} cost turns`)
        if (parts.length) summary.push(`legacy: ${parts.join(', ')}`)
      }
      if (result.canonicalized) {
        const c = result.canonicalized
        const parts: string[] = []
        if (c.storeTurns) parts.push(`${c.storeTurns} turns`)
        if (c.storeHourlyDeleted) parts.push(`${c.storeHourlyDeleted} stale hourly_stats deleted`)
        if (c.storeConversations) parts.push(`${c.storeConversations} sessions`)
        if (c.analyticsTurns) parts.push(`${c.analyticsTurns} analytics turns`)
        if (c.storeScopeLinks) parts.push(`${c.storeScopeLinks} scope links`)
        if (c.storeAddressBook) parts.push(`${c.storeAddressBook} address book`)
        if (parts.length) summary.push(`canonicalized URIs: ${parts.join(', ')}`)
      }
      console.log(
        `[store] Migrated schema v${result.fromVersion} -> v${result.toVersion}` +
          (summary.length ? ` (${summary.join('; ')})` : ''),
      )
    }
  }

  // Schedule cost data cleanup (30-day retention, runs daily)
  const COST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
  const costCleanupTimer = setInterval(
    () => {
      const cutoff = Date.now() - COST_RETENTION_MS
      const deleted = store.costs.pruneOlderThan(cutoff)
      if (deleted.turns > 0 || deleted.hourly > 0) {
        console.log(`[cost] Cleanup: ${deleted.turns} turns, ${deleted.hourly} hourly rows removed (>30d)`)
      }
    },
    24 * 60 * 60 * 1000,
  )
  // Prune once at startup too (don't block startup on it, but fire-and-forget)
  {
    const cutoff = Date.now() - COST_RETENTION_MS
    const deleted = store.costs.pruneOlderThan(cutoff)
    if (deleted.turns > 0 || deleted.hourly > 0) {
      console.log(`[cost] Startup cleanup: ${deleted.turns} turns, ${deleted.hourly} hourly rows removed (>30d)`)
    }
  }

  // Initialize settings (backed by store.kv)
  initProjectSettings(store.kv)
  initGlobalSettings(store.kv)
  initProjectOrder(store.kv)
  initProjectLinks(store.kv)
  initInterSessionLog(store.kv)
  initAddressBook(store.kv)
  initMessageQueue(store.kv)
  initShares({ kv: store.kv })
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

  // Initialize sentinel registry (persisted sentinel host records)
  const sentinelRegistry = authCacheDir ? createSentinelRegistry(authCacheDir) : undefined
  if (sentinelRegistry) setSentinelRegistry(sentinelRegistry)

  const conversationStore = createConversationStore({
    cacheDir,
    enablePersistence: !noPersistence,
    store,
    sentinelRegistry,
  })

  // Handle --clear-cache
  if (clearCache) {
    await conversationStore.clearState()
    console.log('Cache cleared.')
    process.exit(0)
  }

  // Shutdown: StoreDriver writes are immediate, just close handles
  process.on('SIGINT', async () => {
    console.log('\n[shutdown] Closing stores...')
    clearInterval(costCleanupTimer)
    closeAnalyticsStore()
    closeProjectStore()
    store.close()
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    clearInterval(costCleanupTimer)
    closeAnalyticsStore()
    closeProjectStore()
    store.close()
    process.exit(0)
  })
  process.on('SIGHUP', () => {
    reloadState()
    sentinelRegistry?.load()
    console.log('[auth] Reloaded auth + sentinel registry from disk (SIGHUP)')

    // Terminate WS connections for revoked users
    const subscribers = conversationStore.getSubscribers()
    for (const ws of subscribers) {
      const userName = (ws.data as { userName?: string }).userName
      if (userName) {
        const user = getUser(userName)
        if (!user || user.revoked) {
          console.log(`[auth] Terminating WS for revoked user: ${userName}`)
          conversationStore.removeTerminalViewerBySocket(ws)
          conversationStore.removeJsonStreamViewerBySocket(ws)
          conversationStore.removeSubscriber(ws)
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
    const subscribers = conversationStore.getSubscribers()
    for (const ws of subscribers) {
      const data = ws.data as { authToken?: string; userName?: string }
      if (!data.authToken) continue // rclaude/agent connections use secret, not tokens
      const session = validateConversation(data.authToken)
      if (!session) {
        console.log(`[auth] Closing expired WS for user: ${data.userName || 'unknown'}`)
        conversationStore.removeTerminalViewerBySocket(ws)
        conversationStore.removeJsonStreamViewerBySocket(ws)
        conversationStore.removeSubscriber(ws)
        try {
          ws.close(4401, 'Session expired')
        } catch {}
      }
    }
  }, 60_000) // check every minute

  // Periodically check grant expiry -- disconnect users whose grants have all expired
  setInterval(() => {
    const subscribers = conversationStore.getSubscribers()
    for (const ws of subscribers) {
      const data = ws.data as WsData
      if (!data.grants || data.grants.length === 0) continue
      if (allGrantsExpired(data.grants)) {
        console.log(`[auth] All grants expired for user: ${data.userName || 'unknown'} -- disconnecting`)
        conversationStore.removeTerminalViewerBySocket(ws)
        conversationStore.removeJsonStreamViewerBySocket(ws)
        conversationStore.removeSubscriber(ws)
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
      const subscribers = conversationStore.getSubscribers()
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
      conversationStore.broadcastSharesUpdate()
    }
  }, 30_000) // check every 30 seconds

  // Write PID file so CLI can send signals
  if (cacheDir) {
    const pidFile = join(cacheDir, 'broker.pid')
    writeFileSync(pidFile, String(process.pid))
  }

  // Create WebSocket server
  const wsServer = createWsServer({
    port,
    conversationStore,
    onConversationStart(sessionId, meta) {
      if (verbose) {
        console.log(`[+] Session started: ${sessionId.slice(0, 8)}... (${meta.project})`)
      }
    },
    onConversationEnd(sessionId, reason) {
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
        const session = conversationStore.getConversation(sessionId)
        const label = session?.project ? extractProjectLabel(session.project) : sessionId.slice(0, 8)
        const d = event.data as Record<string, unknown>
        const message = (d?.message as string) || 'Awaiting input...'
        const notifType = (d?.notification_type as string) || 'Notification'
        sendPushToAll({
          title: `${notifType} - ${label}`,
          body: message,
          conversationId: sessionId,
          tag: `notification-${sessionId}`,
        }).catch(() => {})
      }

      // Auto-send push on session Stop (Claude finished working)
      if (event.hookEvent === 'Stop' && isPushConfigured()) {
        const session = conversationStore.getConversation(sessionId)
        const label = session?.project ? extractProjectLabel(session.project) : sessionId.slice(0, 8)
        const d = event.data as Record<string, unknown>
        const reason = (d?.stop_hook_reason as string) || 'completed'
        sendPushToAll({
          title: `Session stopped - ${label}`,
          body: reason,
          conversationId: sessionId,
          tag: `stop-${sessionId}`,
        }).catch(() => {})
      }
    },
  })

  // Create Hono router with all HTTP routes
  const serverStartTime = Date.now()
  const router = createRouter({
    conversationStore,
    store,
    webDir,
    vapidPublicKey,
    rclaudeSecret,
    cacheDir: authCacheDir,
    serverStartTime,
    publicOrigin: origins[0],
    sentinelRegistry,
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
      conversations: conversationStore,
      store,
      verbose,
      origins,
      getProjectSettings,
      setProjectSettings,
      getAllProjectSettings,
      pushConfigured: isPushConfigured(),
      pushSendToAll: payload => {
        if (isPushConfigured()) sendPushToAll(payload)
      },
      getLinksForProject,
      findLink: (projectA: string, projectB: string) => !!findLink(projectA, projectB),
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

          // Resolve auth identity for WS data tagging
          const wsSecret = url.searchParams.get('secret')
          const authResult = wsSecret ? resolveAuth(wsSecret) : null

          const wsUserName = getAuthenticatedUser(req) ?? undefined
          // Extract auth token for periodic expiry checks on the WS connection
          const cookieHeader = req.headers.get('cookie')
          const tokenMatch = cookieHeader?.match(/cw-session=([^;]+)/)
          const authToken = tokenMatch?.[1]
          // Load grants for permission enforcement on WS messages
          const wsUser = wsUserName ? getUser(wsUserName) : undefined
          const wsData: WsData = { userName: wsUserName, authToken, grants: wsUser?.grants }
          if (authResult?.role === 'sentinel') {
            wsData.sentinelId = authResult.sentinelId
            wsData.sentinelAlias = authResult.alias
          }
          const success = server.upgrade(req, { data: wsData })
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
            conversationStore.recordTraffic('in', msgStr.length)
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
            const id = ws.data.ccSessionId?.slice(0, 8) || (ws.data.isControlPanel ? 'dashboard' : 'unknown')
            console.log(`[ws] Connection closed: ${id} code=${code} reason=${reason || 'none'}`)
          }

          // Handle sentinel disconnection
          if (ws.data.isSentinel) {
            conversationStore.removeSentinel(ws)
            if (verbose) {
              console.log('[sentinel] Sentinel disconnected')
            }
            return
          }

          // Handle dashboard subscriber disconnection
          if (ws.data.isControlPanel) {
            // Clean up any active voice streaming session
            cleanupVoiceForWs(ws)
            // If this dashboard was viewing a terminal or json stream, remove from viewers
            conversationStore.removeTerminalViewerBySocket(ws)
            conversationStore.removeJsonStreamViewerBySocket(ws)
            // Clean up launch job subscriptions
            conversationStore.cleanupJobSubscriber(ws)
            conversationStore.removeSubscriber(ws)
            if (verbose) {
              console.log(`[dashboard] Subscriber disconnected (total: ${conversationStore.getSubscriberCount()})`)
            }
            return
          }

          // Handle rclaude session disconnection
          const ccSessionId = ws.data.ccSessionId
          const closeWrapperId = ws.data.conversationId
          if (ccSessionId && closeWrapperId) {
            // Notify terminal viewers attached to this wrapper's PTY
            const viewers = conversationStore.getTerminalViewers(closeWrapperId)
            if (viewers.size > 0) {
              const msg = JSON.stringify({
                type: 'terminal_error',
                conversationId: closeWrapperId,
                error: 'Wrapper disconnected',
              })
              for (const viewer of viewers) {
                try {
                  viewer.send(msg)
                } catch {}
              }
              for (const viewer of viewers) {
                conversationStore.removeTerminalViewer(closeWrapperId, viewer)
              }
            }

            // Notify json-stream viewers attached to this wrapper
            const jsViewers = conversationStore.getJsonStreamViewers(closeWrapperId)
            if (jsViewers.size > 0) {
              const msg = JSON.stringify({
                type: 'json_stream_data',
                conversationId: closeWrapperId,
                lines: [],
                isBackfill: false,
              })
              for (const viewer of jsViewers) {
                try {
                  viewer.send(msg)
                } catch {}
              }
              for (const viewer of jsViewers) {
                conversationStore.removeJsonStreamViewer(closeWrapperId, viewer)
              }
            }

            // Remove this wrapper's socket
            conversationStore.removeConversationSocket(closeWrapperId, ccSessionId)
            const remaining = conversationStore.getActiveConversationCount(closeWrapperId)

            const session = conversationStore.getConversation(closeWrapperId)
            if (session && session.status !== 'ended' && remaining === 0) {
              // Last wrapper disconnected - end the conversation
              conversationStore.endConversation(closeWrapperId, 'connection_closed')
              if (verbose) {
                console.log(`[-] Session ended: ${closeWrapperId.slice(0, 8)}... (connection_closed, last wrapper)`)
              }

              // Check for pending restart (terminate + auto-revive)
              const pendingRestart = conversationStore.consumePendingRestart(closeWrapperId)
              if (pendingRestart) {
                const sentinel = conversationStore.getSentinel()
                if (sentinel) {
                  const conversationId = crypto.randomUUID()
                  console.log(
                    `[restart] Reviving after disconnect: ${extractProjectLabel(pendingRestart.project)} conversationId=${conversationId.slice(0, 8)}`,
                  )
                  sentinel.send(
                    JSON.stringify({
                      type: 'revive',
                      sessionId: session.id,
                      project: pendingRestart.project,
                      conversationId,
                      mode: 'resume',
                    }),
                  )

                  // Register rendezvous for caller (if not self-restart)
                  if (!pendingRestart.isSelfRestart) {
                    conversationStore
                      .addRendezvous(
                        conversationId,
                        pendingRestart.callerConversationId,
                        pendingRestart.project,
                        'restart',
                      )
                      .then(revived => {
                        const callerWs = conversationStore.getConversationSocket(pendingRestart.callerConversationId)
                        callerWs?.send(
                          JSON.stringify({
                            type: 'restart_ready',
                            sessionId: revived.id,
                            project: revived.project,
                            conversationId,
                            session: revived,
                          }),
                        )
                      })
                      .catch(err => {
                        const callerWs = conversationStore.getConversationSocket(pendingRestart.callerConversationId)
                        callerWs?.send(
                          JSON.stringify({
                            type: 'restart_timeout',
                            conversationId,
                            project: pendingRestart.project,
                            error: typeof err === 'string' ? err : 'Restart rendezvous timed out',
                          }),
                        )
                      })
                  }
                } else {
                  console.log('[restart] No sentinel connected - cannot revive after restart')
                }
              }
            } else if (verbose && remaining > 0) {
              console.log(
                `[~] Wrapper ${closeWrapperId.slice(0, 8)} disconnected from conversation ${closeWrapperId.slice(0, 8)}... (${remaining} wrappers remaining)`,
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
      const sessions = conversationStore.getActiveConversations()
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
