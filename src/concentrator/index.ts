#!/usr/bin/env bun
/**
 * Claude Code Session Concentrator
 * Aggregates sessions from multiple rclaude instances
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONCENTRATOR_PORT } from '../shared/protocol'
import { createApiHandler } from './api'
import { getUser, initAuth, reloadState } from './auth'
import { getAuthenticatedUser, handleAuthRoute, requireAuth, setRclaudeSecret } from './auth-routes'
import { initGlobalSettings } from './global-settings'
import { addAllowedRoot, addPathMapping, getAllowedRoots } from './path-jail'
import { initProjectSettings } from './project-settings'
import { initPush, isPushConfigured, sendPushToAll } from './push'
import { createSessionStore } from './session-store'
import { cleanupVoiceForWs, handleVoiceData, handleVoiceStart, handleVoiceStop } from './voice-stream'
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
  let vapidPublicKey: string | undefined
  let vapidPrivateKey: string | undefined

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
  vapidPublicKey = process.env.VAPID_PUBLIC_KEY
  vapidPrivateKey = process.env.VAPID_PRIVATE_KEY

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

  // Initialize settings
  initProjectSettings(authCacheDir)
  initGlobalSettings(authCacheDir)

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
    await sessionStore.saveState()
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    await sessionStore.saveState()
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
        }
      }
    }
  })

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

  // Create REST API server (on same or different port)
  const apiHandler = createApiHandler({ sessionStore, webDir, vapidPublicKey, rclaudeSecret, cacheDir: authCacheDir })

  if (apiPort && apiPort !== port) {
    // Separate API server
    Bun.serve({
      port: apiPort,
      fetch: apiHandler,
    })
    console.log(`REST API listening on http://localhost:${apiPort}`)
  } else {
    // Combine API with WebSocket server - need to create new combined server
    wsServer.stop()

    interface WsData {
      sessionId?: string
      wrapperId?: string // unique per rclaude instance (multiple can share sessionId)
      isDashboard?: boolean
      isAgent?: boolean
      userName?: string // authenticated user name (for revocation tracking)
    }

    Bun.serve<WsData>({
      port,
      async fetch(req, server) {
        // Auth routes first (login, register, status)
        const authResponse = await handleAuthRoute(req)
        if (authResponse) return authResponse

        // Auth middleware (blocks unauthenticated access when users exist)
        const authBlock = requireAuth(req)
        if (authBlock) return authBlock

        const url = new URL(req.url)

        // WebSocket upgrade for /ws or /
        if (
          req.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
          (url.pathname === '/' || url.pathname === '/ws')
        ) {
          // Extract authenticated user for revocation tracking
          const wsUserName = getAuthenticatedUser(req) ?? undefined
          const success = server.upgrade(req, {
            data: { userName: wsUserName } as WsData,
          })
          if (success) {
            return undefined
          }
          return new Response('WebSocket upgrade failed', { status: 500 })
        }

        // REST API for other routes
        return apiHandler(req)
      },
      websocket: {
        open(_ws) {
          // Connection established
        },
        message(ws, message) {
          try {
            const data = JSON.parse(message as string)

            switch (data.type) {
              case 'meta': {
                const wrapperId = data.wrapperId || data.sessionId // backwards compat
                ws.data.sessionId = data.sessionId
                ws.data.wrapperId = wrapperId

                // Check if session exists (resume case)
                const existingSession = sessionStore.getSession(data.sessionId)
                if (existingSession) {
                  sessionStore.resumeSession(data.sessionId)
                  // Update capabilities + version on reconnect
                  if (data.capabilities) existingSession.capabilities = data.capabilities
                  if (data.version) existingSession.version = data.version
                  if (data.buildTime) existingSession.buildTime = data.buildTime
                  if (data.claudeVersion) existingSession.claudeVersion = data.claudeVersion
                  if (verbose) {
                    const wrapperCount = sessionStore.getActiveWrapperCount(data.sessionId) + 1
                    console.log(
                      `[~] Session resumed: ${data.sessionId.slice(0, 8)}... wrapper=${wrapperId.slice(0, 8)} (${data.cwd}) [${wrapperCount} wrapper(s)]${data.version ? ` [${data.version}]` : ''}`,
                    )
                  }
                } else {
                  const newSession = sessionStore.createSession(
                    data.sessionId,
                    data.cwd,
                    data.model,
                    data.args,
                    data.capabilities,
                  )
                  if (data.version) newSession.version = data.version
                  if (data.buildTime) newSession.buildTime = data.buildTime
                  if (data.claudeVersion) newSession.claudeVersion = data.claudeVersion
                  if (verbose) {
                    console.log(
                      `[+] Session started: ${data.sessionId.slice(0, 8)}... wrapper=${wrapperId.slice(0, 8)} (${data.cwd})${data.version ? ` [${data.version}]` : ''}`,
                    )
                  }
                }

                // Track socket by wrapperId (multiple wrappers can share a sessionId)
                sessionStore.setSessionSocket(data.sessionId, wrapperId, ws)

                // Broadcast session update so dashboard picks up new wrapperIds and status
                sessionStore.broadcastSessionUpdate(data.sessionId)

                ws.send(JSON.stringify({ type: 'ack', eventId: data.sessionId, origins }))
                break
              }
              case 'hook': {
                const sessionId = ws.data.sessionId || data.sessionId
                if (sessionId) {
                  sessionStore.addEvent(sessionId, data)
                  if (verbose) {
                    const toolName = data.data?.tool_name || ''
                    const suffix = toolName ? ` (${toolName})` : ''
                    console.log(`[*] ${sessionId.slice(0, 8)}... ${data.hookEvent}${suffix}`)
                  }
                }
                break
              }
              case 'heartbeat': {
                // Heartbeats keep the WS alive but do NOT count as activity.
                // Only hook events and transcript entries reset lastActivity.
                break
              }
              case 'session_clear': {
                // Same wrapper, new Claude session ID (e.g. /clear)
                // Re-key session in-place so dashboard stays connected
                const oldId = data.oldSessionId || ws.data.sessionId
                const newId = data.newSessionId
                const clearWrapperId = data.wrapperId || ws.data.wrapperId
                if (oldId && newId && clearWrapperId) {
                  const session = sessionStore.rekeySession(oldId, newId, clearWrapperId, data.cwd, data.model)
                  if (session) {
                    ws.data.sessionId = newId
                    if (verbose) {
                      console.log(
                        `[~] Session re-keyed: ${oldId.slice(0, 8)} -> ${newId.slice(0, 8)} wrapper=${clearWrapperId.slice(0, 8)} (${data.cwd})`,
                      )
                    }
                  } else {
                    // Fallback: create new session if old one was already gone
                    if (verbose) {
                      console.log(`[!] session_clear: old session ${oldId.slice(0, 8)} not found, creating new`)
                    }
                    sessionStore.createSession(newId, data.cwd, data.model)
                    ws.data.sessionId = newId
                    sessionStore.setSessionSocket(newId, clearWrapperId, ws)
                  }
                }
                break
              }
              case 'notify': {
                // Push notification from wrapper (triggered by Claude via curl)
                const sessionId = ws.data.sessionId || data.sessionId
                const session = sessionId ? sessionStore.getSession(sessionId) : undefined
                const cwd = session?.cwd?.split('/').slice(-2).join('/') || sessionId?.slice(0, 8) || 'rclaude'
                const message = data.message || 'Notification'
                const title = data.title || cwd
                console.log(`[notify] ${title}: ${message}`)

                // Send push notification
                if (isPushConfigured()) {
                  sendPushToAll({
                    title,
                    body: message,
                    sessionId,
                    tag: `notify-${sessionId}`,
                  }).catch(() => {})
                }

                // Broadcast toast to all dashboard subscribers
                const toastMsg = JSON.stringify({ type: 'toast', title, message, sessionId })
                for (const sub of sessionStore.getSubscribers()) {
                  try {
                    sub.send(toastMsg)
                  } catch {}
                }
                break
              }
              case 'end': {
                const sessionId = ws.data.sessionId || data.sessionId
                const endWrapperId = ws.data.wrapperId
                if (sessionId && endWrapperId) {
                  // Remove this wrapper's socket
                  sessionStore.removeSessionSocket(sessionId, endWrapperId)
                  const remaining = sessionStore.getActiveWrapperCount(sessionId)
                  if (remaining === 0) {
                    // Last wrapper disconnected - actually end the session
                    sessionStore.endSession(sessionId, data.reason)
                    if (verbose) {
                      console.log(`[-] Session ended: ${sessionId.slice(0, 8)}... (${data.reason})`)
                    }
                  } else if (verbose) {
                    console.log(
                      `[~] Wrapper ${endWrapperId.slice(0, 8)} ended for session ${sessionId.slice(0, 8)}... (${remaining} wrapper(s) remaining)`,
                    )
                  }
                }
                break
              }
              case 'subscribe': {
                // Dashboard client subscribing to updates
                ws.data.isDashboard = true
                sessionStore.addSubscriber(ws)
                // Send current agent status
                ws.send(JSON.stringify({ type: 'agent_status', connected: sessionStore.hasAgent() }))
                if (verbose) {
                  console.log(`[dashboard] Subscriber connected (total: ${sessionStore.getSubscriberCount()})`)
                }
                break
              }
              case 'agent_identify': {
                // Host agent connecting (exclusive - only one allowed)
                const accepted = sessionStore.setAgent(ws)
                if (accepted) {
                  ws.data.isAgent = true
                  ws.send(JSON.stringify({ type: 'ack', eventId: 'agent' }))
                  if (verbose) {
                    console.log('[agent] Host agent connected')
                  }
                } else {
                  ws.send(JSON.stringify({ type: 'agent_reject', reason: 'Another agent is already connected' }))
                  ws.close(4409, 'Agent already connected')
                }
                break
              }
              case 'revive_result': {
                // Agent reporting result of a revive command
                if (verbose) {
                  const ok = data.success ? 'OK' : 'FAIL'
                  console.log(
                    `[agent] Revive ${data.sessionId?.slice(0, 8)}... ${ok}${data.error ? ` (${data.error})` : ''}`,
                  )
                }
                break
              }
              case 'spawn_result': {
                if (verbose) {
                  const ok = data.success ? 'OK' : 'FAIL'
                  console.log(`[agent] Spawn ${ok}${data.error ? ` (${data.error})` : ''}`)
                }
                sessionStore.resolveSpawn(data.requestId, data)
                break
              }
              case 'list_dirs_result': {
                sessionStore.resolveDir(data.requestId, data)
                break
              }

              // Terminal relay: dashboard -> rclaude
              // Terminal messages: all routed by wrapperId (physical PTY identity)
              case 'terminal_attach': {
                const wid = data.wrapperId
                const targetSocket = sessionStore.getSessionSocketByWrapper(wid)
                if (targetSocket) {
                  const isFirstViewer = !sessionStore.hasTerminalViewers(wid)
                  sessionStore.addTerminalViewer(wid, ws)
                  if (isFirstViewer) {
                    targetSocket.send(JSON.stringify(data))
                  }
                  if (verbose) {
                    const viewers = sessionStore.getTerminalViewers(wid)
                    console.log(
                      `[terminal] Attached to wrapper=${wid.slice(0, 8)} (${data.cols}x${data.rows}) [${viewers.size} viewer(s)]`,
                    )
                  }
                } else {
                  ws.send(
                    JSON.stringify({
                      type: 'terminal_error',
                      wrapperId: wid,
                      error: 'Wrapper not connected',
                    }),
                  )
                }
                break
              }
              case 'terminal_detach': {
                const wid = data.wrapperId
                sessionStore.removeTerminalViewer(wid, ws)
                if (!sessionStore.hasTerminalViewers(wid)) {
                  const detachSocket = sessionStore.getSessionSocketByWrapper(wid)
                  if (detachSocket) {
                    detachSocket.send(JSON.stringify(data))
                  }
                }
                if (verbose) {
                  const viewers = sessionStore.getTerminalViewers(wid)
                  console.log(
                    `[terminal] Detached from wrapper=${wid.slice(0, 8)} [${viewers.size} viewer(s) remaining]`,
                  )
                }
                break
              }
              case 'terminal_data': {
                const wid = data.wrapperId
                if (ws.data.isDashboard) {
                  // Dashboard -> rclaude (user keystrokes)
                  const targetSocket = sessionStore.getSessionSocketByWrapper(wid)
                  if (targetSocket) {
                    targetSocket.send(JSON.stringify(data))
                  }
                } else if (ws.data.wrapperId) {
                  // rclaude -> dashboard (PTY output) - broadcast to all viewers of this wrapper
                  const viewers = sessionStore.getTerminalViewers(wid || ws.data.wrapperId)
                  const msg = JSON.stringify(data)
                  for (const viewer of viewers) {
                    try {
                      viewer.send(msg)
                    } catch {}
                  }
                }
                break
              }
              case 'terminal_resize': {
                const targetSocket = sessionStore.getSessionSocketByWrapper(data.wrapperId)
                if (targetSocket) {
                  targetSocket.send(JSON.stringify(data))
                }
                break
              }
              case 'terminal_error': {
                // rclaude -> dashboard - broadcast to all viewers of this wrapper
                const viewers = sessionStore.getTerminalViewers(data.wrapperId || ws.data.wrapperId || '')
                const msg = JSON.stringify(data)
                for (const viewer of viewers) {
                  try {
                    viewer.send(msg)
                  } catch {}
                }
                break
              }
              case 'tasks_update': {
                const sessionId = ws.data.sessionId || data.sessionId
                if (sessionId) {
                  sessionStore.updateTasks(sessionId, data.tasks || [])
                  // Forward active task list to dashboard subscribers (archived fetched on demand)
                  const taskMsg = JSON.stringify({ type: 'tasks_update', sessionId, tasks: data.tasks || [] })
                  for (const sub of sessionStore.getSubscribers()) {
                    try {
                      sub.send(taskMsg)
                    } catch {}
                  }
                  if (verbose) {
                    console.log(`[*] ${sessionId.slice(0, 8)}... tasks_update (${(data.tasks || []).length} tasks)`)
                  }
                }
                break
              }

              case 'diag': {
                const sessionId = ws.data.sessionId || data.sessionId
                if (sessionId && Array.isArray(data.entries)) {
                  const session = sessionStore.getSession(sessionId)
                  if (session) {
                    session.diagLog.push(...data.entries)
                    // Cap at 500 entries
                    if (session.diagLog.length > 500) {
                      session.diagLog.splice(0, session.diagLog.length - 500)
                    }
                  }
                }
                break
              }

              // Transcript streaming: rclaude -> concentrator (cache + forward to dashboard)
              case 'transcript_entries': {
                const sessionId = ws.data.sessionId || data.sessionId
                if (sessionId) {
                  const entryCount = (data.entries || []).length
                  sessionStore.addTranscriptEntries(sessionId, data.entries || [], data.isInitial || false)
                  // Broadcast to dashboard subscribers
                  const msg = JSON.stringify(data)
                  for (const sub of sessionStore.getSubscribers()) {
                    try {
                      sub.send(msg)
                    } catch {}
                  }
                  // Always log transcript events (new feature - needs visibility)
                  console.log(
                    `[transcript] ${sessionId.slice(0, 8)}... ${entryCount} entries (initial: ${data.isInitial})`,
                  )
                }
                break
              }
              case 'subagent_transcript': {
                const sessionId = ws.data.sessionId || data.sessionId
                if (sessionId && data.agentId) {
                  const entryCount = (data.entries || []).length
                  sessionStore.addSubagentTranscriptEntries(
                    sessionId,
                    data.agentId,
                    data.entries || [],
                    data.isInitial || false,
                  )
                  // Broadcast to dashboard subscribers
                  const msg = JSON.stringify(data)
                  for (const sub of sessionStore.getSubscribers()) {
                    try {
                      sub.send(msg)
                    } catch {}
                  }
                  console.log(
                    `[transcript] ${sessionId.slice(0, 8)}... subagent ${data.agentId.slice(0, 7)} ${entryCount} entries`,
                  )
                }
                break
              }
              case 'bg_task_output': {
                const sessionId = ws.data.sessionId || data.sessionId
                if (sessionId && data.taskId) {
                  sessionStore.addBgTaskOutput(sessionId, data.taskId, data.data || '', data.done || false)
                  // Broadcast to dashboard subscribers
                  const msg = JSON.stringify(data)
                  for (const sub of sessionStore.getSubscribers()) {
                    try {
                      sub.send(msg)
                    } catch {}
                  }
                }
                break
              }
              case 'file_response': {
                // Check if this is a server-side request (e.g. keyterm generation)
                if (data.requestId && sessionStore.resolveFile(data.requestId, data)) {
                  break // Handled server-side, don't broadcast
                }
                // rclaude responding to a dashboard file request - forward to subscribers
                const msg = JSON.stringify(data)
                for (const sub of sessionStore.getSubscribers()) {
                  try {
                    sub.send(msg)
                  } catch {}
                }
                break
              }

              // File editor relay: dashboard <-> wrapper
              // Dashboard sends request (with sessionId + requestId), concentrator forwards to wrapper.
              // Wrapper sends response (with requestId), concentrator forwards back to requesting dashboard.
              case 'file_list_request':
              case 'file_content_request':
              case 'file_save':
              case 'file_watch':
              case 'file_unwatch':
              case 'file_history_request':
              case 'file_restore':
              case 'quick_note_append': {
                if (ws.data.isDashboard && data.sessionId) {
                  // Dashboard -> wrapper: forward to the session's wrapper
                  const targetSocket = sessionStore.getSessionSocket(data.sessionId)
                  if (targetSocket) {
                    // Tag with the dashboard socket so we can route the response back
                    targetSocket.send(JSON.stringify(data))
                  } else {
                    ws.send(
                      JSON.stringify({
                        type: data.type.replace('_request', '_response').replace('_save', '_save_response'),
                        requestId: data.requestId,
                        error: 'Session not connected',
                      }),
                    )
                  }
                }
                break
              }
              case 'file_list_response':
              case 'file_content_response':
              case 'file_save_response':
              case 'file_history_response':
              case 'file_restore_response':
              case 'quick_note_response':
              case 'file_changed': {
                // Wrapper -> dashboard: forward to all dashboard subscribers
                // (requestId-based correlation handles routing on the client side)
                const msg = JSON.stringify(data)
                for (const sub of sessionStore.getSubscribers()) {
                  try {
                    sub.send(msg)
                  } catch {}
                }
                break
              }

              // Transcript streaming: dashboard -> rclaude (request cached or proxied transcript)
              case 'transcript_request': {
                if (data.sessionId) {
                  // Serve from cache if available
                  if (sessionStore.hasTranscriptCache(data.sessionId)) {
                    const entries = sessionStore.getTranscriptEntries(data.sessionId, data.limit)
                    ws.send(
                      JSON.stringify({
                        type: 'transcript_entries',
                        sessionId: data.sessionId,
                        entries,
                        isInitial: true,
                      }),
                    )
                  } else {
                    // Forward request to rclaude so it can send transcript
                    const sessionSocket = sessionStore.getSessionSocket(data.sessionId)
                    if (sessionSocket) {
                      sessionSocket.send(JSON.stringify(data))
                    }
                  }
                }
                break
              }
              case 'subagent_transcript_request': {
                if (data.sessionId && data.agentId) {
                  if (sessionStore.hasSubagentTranscriptCache(data.sessionId, data.agentId)) {
                    const entries = sessionStore.getSubagentTranscriptEntries(data.sessionId, data.agentId, data.limit)
                    ws.send(
                      JSON.stringify({
                        type: 'subagent_transcript',
                        sessionId: data.sessionId,
                        agentId: data.agentId,
                        entries,
                        isInitial: true,
                      }),
                    )
                  } else {
                    const sessionSocket = sessionStore.getSessionSocket(data.sessionId)
                    if (sessionSocket) {
                      sessionSocket.send(JSON.stringify(data))
                    }
                  }
                }
                break
              }
              // Voice streaming: browser <-> Deepgram via concentrator relay
              case 'voice_start': {
                handleVoiceStart(ws, data, sessionStore)
                break
              }
              case 'voice_data': {
                handleVoiceData(ws, data.audio)
                break
              }
              case 'voice_stop': {
                handleVoiceStop(ws)
                break
              }

              case 'file_request': {
                // Dashboard requesting a file - proxy to rclaude
                if (data.sessionId) {
                  const sessionSocket = sessionStore.getSessionSocket(data.sessionId)
                  if (sessionSocket) {
                    sessionSocket.send(JSON.stringify(data))
                  } else {
                    ws.send(
                      JSON.stringify({
                        type: 'file_response',
                        requestId: data.requestId,
                        error: 'Session not connected',
                      }),
                    )
                  }
                }
                break
              }
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
        close(ws) {
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
