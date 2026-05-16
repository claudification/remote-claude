#!/usr/bin/env bun
/**
 * Claudwerk Broker
 * Aggregates conversations from multiple rclaude instances
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
  setGatewayRegistry,
  setRclaudeSecret,
  setSentinelRegistry,
  setShareValidator,
} from './auth-routes'
import { buildReviveMessage } from './build-revive'
import { createConversationStore } from './conversation-store'
import { type ContextDeps, createContext } from './create-context'
import { startExternalStatusPolling, stopExternalStatusPolling } from './external-status'
import { createGatewayRegistry } from './gateway-registry'
import { initGlobalSettings } from './global-settings'
import type { WsData } from './handler-context'
import { registerAllHandlers } from './handlers'
import { startSpawnApprovalSweep } from './handlers/spawn-approval'
import { appendMessage, initInterConversationLog } from './inter-conversation-log'
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
import { initRecapOrchestrator } from './recap-orchestrator'
import { createRouter } from './routes'
import { createSentinelRegistry } from './sentinel-registry'
import {
  cleanExpired as cleanExpiredShares,
  initShares,
  shareToGrants as shareToGrantList,
  validateShare as validateShareToken,
} from './shares'
import { createStore } from './store'
import { createTerminationLog, startTerminationLogSweep } from './termination-log'
import { cleanupVoiceForWs } from './voice-stream'

interface Args {
  port: number
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

Receives conversation events from rclaude instances and provides a unified view.

USAGE:
  broker [OPTIONS]

OPTIONS:
  -p, --port <port>      WebSocket port (default: ${DEFAULT_BROKER_PORT})
  -v, --verbose          Enable verbose logging
  -w, --web-dir <dir>    Serve web dashboard from directory
  --cache-dir <dir>      Conversation cache directory (default: ~/.cache/broker)
  --clear-cache          Clear conversation cache and exit
  --no-persistence       Disable conversation persistence
  --allow-root <dir>     Add allowed filesystem root (repeatable)
  --rp-id <domain>       WebAuthn relying party ID (default: localhost)
  --origin <url>         Allowed WebAuthn origin (repeatable, default: http://localhost:PORT)
  --rclaude-secret <s>   Shared secret for rclaude WebSocket auth (or RCLAUDE_SECRET env)
  -h, --help             Show this help message

ENDPOINTS:
  WebSocket:
    ws://localhost:${DEFAULT_BROKER_PORT}/      Connect conversation

  REST API:
    GET  /conversations                List all conversations
    GET  /conversations?active=true    List active conversations only
    GET  /conversations/:id            Get conversation details
    GET  /conversations/:id/events     Get conversation events
    POST /conversations/:id/input      Send input to conversation
    GET  /health                  Health check

EXAMPLES:
  broker                   # Start on default port
  broker -p 8080           # Start on port 8080
  broker -v                # Start with verbose logging
  broker --clear-cache     # Clear cached conversations
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
      if (result.legacyHermesDeleted) {
        summary.push(`dropped ${result.legacyHermesDeleted} legacy hermes://gateway conversations`)
      }
      if (result.tasksBackfilled) {
        const t = result.tasksBackfilled
        if (t.tasks || t.archived) {
          summary.push(`backfilled tasks: ${t.tasks} active, ${t.archived} archived (${t.conversations} conversations)`)
        }
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
  initInterConversationLog(store.messages)
  initAddressBook(store.kv)
  initMessageQueue(store.messages)
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

  // Initialize gateway registry (persisted gateway adapter records)
  const gatewayRegistry = authCacheDir ? createGatewayRegistry(authCacheDir) : undefined
  if (gatewayRegistry) setGatewayRegistry(gatewayRegistry)

  // Termination log: append-only NDJSON, daily-rotated, 30-day retention.
  // Every endConversation() call writes one row -- the single source of
  // truth for "who killed conversation X" investigations.
  const terminationLog = createTerminationLog(authCacheDir)
  startTerminationLogSweep(terminationLog)

  const conversationStore = createConversationStore({
    cacheDir,
    enablePersistence: !noPersistence,
    store,
    terminationLog,
    sentinelRegistry,
  })

  // Handle --clear-cache
  if (clearCache) {
    await conversationStore.clearState()
    console.log('Cache cleared.')
    process.exit(0)
  }

  initRecapOrchestrator({
    cacheDir: cacheDir ?? '.',
    brokerStore: store,
    broadcaster: {
      broadcast: msg => conversationStore.broadcastConversationScoped(msg as Record<string, unknown>, '*'),
    },
    // inform_on_complete: push a recap-completed system channel message into
    // the requesting conversation. Connected-only -- if the conversation is
    // offline the push is skipped (the caller can still poll recap_get).
    informConversation: (conversationId, msg) => {
      const ws = conversationStore.getConversationSocket(conversationId)
      if (!ws) {
        console.log(
          `[recap] inform skipped -- conversation ${conversationId.slice(0, 8)} not connected (recap=${msg.recapId})`,
        )
        return
      }
      ws.send(
        JSON.stringify({
          type: 'system_channel_deliver',
          kind: 'recap-completed',
          recapId: msg.recapId,
          text: msg.text,
        }),
      )
      console.log(`[recap] inform delivered -> conversation ${conversationId.slice(0, 8)} (recap=${msg.recapId})`)
    },
  })

  // External status polling (clanker.watch health + usage.report efficiency)
  startExternalStatusPolling({
    onHealth: health => conversationStore.setClaudeHealth(health),
    onEfficiency: efficiency => conversationStore.setClaudeEfficiency(efficiency),
  })

  // Shutdown: StoreDriver writes are immediate, just close handles
  process.on('SIGINT', async () => {
    console.log('\n[shutdown] Closing stores...')
    stopExternalStatusPolling()
    clearInterval(costCleanupTimer)
    closeAnalyticsStore()
    closeProjectStore()
    store.close()
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    stopExternalStatusPolling()
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
      const conv = validateConversation(data.authToken)
      if (!conv) {
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
            ws.send(JSON.stringify({ type: 'share_expired', reason: 'Share has expired' }))
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
    gatewayRegistry,
    terminationLog,
  })

  // Combined HTTP + WebSocket server. (The legacy unauthenticated
  // `ws-server.ts` and split-port mode were removed; see SECURITY-AUDIT.md C1.)
  {
    // Register message handlers
    registerAllHandlers()

    // Spawn approval sweep: reap pending prompts older than the TTL on
    // startup (clears anything stuck across a restart) and on a periodic
    // cadence after that.
    startSpawnApprovalSweep(conversationStore)

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
                shareConversationId: share.conversationId,
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
          } else if (authResult?.role === 'gateway') {
            wsData.isGateway = true
            wsData.gatewayType = authResult.gatewayType
            wsData.gatewayId = authResult.gatewayId
            wsData.gatewayAlias = authResult.alias
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
          // Always log -- per the LOG EVERYTHING covenant a bare close line
          // hidden behind `verbose` is a bug. Include all routing context we
          // have so the post-mortem grep is one line. Note: ccSessionId is
          // off-limits in this file (CC concept, broker boundary) -- the
          // boot/meta handlers log it on their side; close just logs role+ids.
          const hintConv = ws.data.conversationId?.slice(0, 8)
          const hintConn = (ws.data.connectionId as string | undefined)?.slice(0, 8)
          const role = ws.data.isControlPanel
            ? 'dashboard'
            : ws.data.isSentinel
              ? 'sentinel'
              : ws.data.isGateway
                ? 'gateway'
                : hintConv
                  ? 'agent-host'
                  : 'unknown'
          console.log(
            `[ws] Connection closed: role=${role} conv=${hintConv ?? 'none'} conn=${hintConn ?? 'none'} code=${code} reason=${reason || 'none'}`,
          )

          // Handle sentinel disconnection
          if (ws.data.isSentinel) {
            conversationStore.removeSentinel(ws)
            if (verbose) {
              console.log('[sentinel] Sentinel disconnected')
            }
            return
          }

          // Handle gateway adapter disconnection (e.g. Hermes)
          if (ws.data.isGateway) {
            const gatewayType = conversationStore.removeGatewaySocketByRef(ws)
            if (gatewayType) {
              console.log(`[gateway] ${gatewayType} adapter disconnected`)
            }
            return
          }

          // Handle dashboard subscriber disconnection
          if (ws.data.isControlPanel) {
            // Clean up any active voice streaming conversation
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

          // Handle agent host disconnection. Authoritative cleanup is by socket
          // identity, NOT ws.data.conversationId -- a socket can land in the map
          // before agent_host_boot/meta tags ws.data, and we must still end the
          // conversation when it dies. ws.data.conversationId is only a hint
          // for viewer notifications.
          const touchedConversationIds = conversationStore.removeConversationSocketsByRef(ws)
          const hintConversationId = ws.data.conversationId
          // Make sure the hint id is in the set even if the by-ref pass didn't
          // find it (e.g. socket was never registered).
          const conversationIdsToCheck = new Set<string>(touchedConversationIds)
          if (hintConversationId) conversationIdsToCheck.add(hintConversationId)

          // Log the cleanup pass with all knowable inputs so the next "[unknown]
          // socket closed" never requires a code dive.
          console.log(
            `[ws] cleanup: hintConv=${hintConversationId?.slice(0, 8) ?? 'none'} touchedConvs=[${touchedConversationIds.map(c => c.slice(0, 8)).join(',')}] (${touchedConversationIds.length}) toCheckCount=${conversationIdsToCheck.size}`,
          )

          if (conversationIdsToCheck.size > 0) {
            // Notify any terminal/json-stream viewers attached to these conversations.
            for (const cid of conversationIdsToCheck) {
              const viewers = conversationStore.getTerminalViewers(cid)
              if (viewers.size > 0) {
                const msg = JSON.stringify({
                  type: 'terminal_error',
                  conversationId: cid,
                  error: 'Wrapper disconnected',
                })
                for (const viewer of viewers) {
                  try {
                    viewer.send(msg)
                  } catch {}
                }
                for (const viewer of viewers) {
                  conversationStore.removeTerminalViewer(cid, viewer)
                }
              }

              const jsViewers = conversationStore.getJsonStreamViewers(cid)
              if (jsViewers.size > 0) {
                const msg = JSON.stringify({
                  type: 'json_stream_data',
                  conversationId: cid,
                  lines: [],
                  isBackfill: false,
                })
                for (const viewer of jsViewers) {
                  try {
                    viewer.send(msg)
                  } catch {}
                }
                for (const viewer of jsViewers) {
                  conversationStore.removeJsonStreamViewer(cid, viewer)
                }
              }
            }

            // End every conversation that has no live socket left. Use the
            // hint id (set by meta/agent_host_boot) when present so restart
            // semantics target the conversation the user actually started.
            const primaryConversationId = hintConversationId ?? touchedConversationIds[0]
            for (const cid of conversationIdsToCheck) {
              const remaining = conversationStore.getActiveConversationCount(cid)
              const conv = conversationStore.getConversation(cid)
              if (!conv || conv.status === 'ended' || remaining > 0) {
                if (verbose && remaining > 0) {
                  console.log(
                    `[~] Wrapper disconnected from conversation ${cid.slice(0, 8)}... (${remaining} wrappers remaining)`,
                  )
                }
                continue
              }
              conversationStore.endConversation(cid, {
                source: 'ws-close',
                initiator: 'system:broker',
                detail: { note: 'Last agent host socket closed without explicit end message' },
              })
              conversationStore.broadcastConversationUpdate(cid)
              if (verbose) {
                console.log(`[-] Conversation ended: ${cid.slice(0, 8)}... (connection_closed, last agent host)`)
              }
              if (cid !== primaryConversationId) continue

              // Check for pending restart (terminate + auto-revive). Only runs
              // for the primary conversation (the one named in ws.data).
              const closeConversationId = cid
              const pendingRestart = conversationStore.consumePendingRestart(closeConversationId)
              if (pendingRestart) {
                const sentinel = conversationStore.getSentinel()
                if (sentinel) {
                  const conversationId = crypto.randomUUID()
                  console.log(
                    `[restart] Reviving after disconnect: ${extractProjectLabel(pendingRestart.project)} conversationId=${conversationId.slice(0, 8)}`,
                  )
                  sentinel.send(JSON.stringify(buildReviveMessage(conv, conversationId)))

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
                            conversationId: revived.id,
                            project: revived.project,
                            conversation: revived,
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
│  REST API:   http://localhost:${String(port).padEnd(5)}                                        │
│  Dashboard:  ${webDirDisplay} │
│  Verbose:    ${verbose ? 'ON ' : 'OFF'}                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
`)

  // Reap conversations whose sockets all died without a clean WS close
  // (network blip, OS sleep, half-open TCP). Runs every 30s.
  setInterval(() => {
    try {
      const ended = conversationStore.reapPhantomConversations()
      if (ended.length > 0) {
        for (const id of ended) {
          console.log(`[reaper] ended phantom conversation ${id.slice(0, 8)}... (no live sockets)`)
          conversationStore.broadcastConversationUpdate(id)
        }
      }
    } catch (err) {
      console.error('[broker] Phantom reaper crashed -- swallowing:', err)
    }
  }, 30_000)

  // Print status periodically
  if (verbose) {
    setInterval(() => {
      try {
        const conversations = conversationStore.getActiveConversations()
        if (conversations.length === 0) return
        console.log(`\n[i] Active conversations: ${conversations.length}`)
        for (const conv of conversations) {
          if (typeof conv.id !== 'string' || conv.id.length === 0) {
            console.warn(
              `[broker] BAD DATA: active conversation with invalid id (id=${JSON.stringify(conv.id)}, project=${conv.project ?? '?'}, status=${conv.status ?? '?'}, startedAt=${conv.startedAt}) -- skipping in logger; this should never happen and indicates a handler accepted malformed input`,
            )
            continue
          }
          const age = formatDuration(Date.now() - conv.startedAt)
          const idle = formatDuration(Date.now() - conv.lastActivity)
          console.log(
            `    ${conv.id.slice(0, 8)}... [${(conv.status ?? 'unknown').toUpperCase()}] age=${age} idle=${idle} events=${conv.events?.length ?? 0}`,
          )
        }
      } catch (err) {
        console.error('[broker] Periodic status logger crashed -- swallowing to keep broker alive:', err)
      }
    }, 60000)
  }
}

main()
