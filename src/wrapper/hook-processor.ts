/**
 * Hook Processor
 * Handles all hook events from Claude Code (SessionStart, SubagentStart/Stop, etc.)
 * and dispatches to the appropriate state updates, watchers, and concentrator forwarding.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HookEvent } from '../shared/protocol'
import { debug as _debug } from './debug'
import {
  startSubagentWatcher,
  startTranscriptWatcher as startTranscriptWatcherFn,
  stopSubagentWatcher,
} from './transcript-manager'
import type { WrapperContext } from './wrapper-context'

const debug = (msg: string) => _debug(msg)

const MAX_EVENT_QUEUE = 200

/**
 * Process a hook event from Claude Code.
 * Handles SessionStart (session ID extraction, transcript watcher setup),
 * SubagentStart/Stop (subagent watcher lifecycle), and event forwarding/queuing.
 */
export function processHookEvent(ctx: WrapperContext, event: HookEvent) {
  // Extract Claude's real session ID from SessionStart
  if (event.hookEvent === 'SessionStart' && event.data) {
    const data = event.data as Record<string, unknown>
    debug(
      `SessionStart data keys: ${Object.keys(data).join(', ')} | source=${data.source} | session_id=${String(data.session_id).slice(0, 8)}`,
    )
    if (data.session_id && typeof data.session_id === 'string') {
      const newSessionId = data.session_id
      const sessionChanged = ctx.claudeSessionId !== newSessionId
      const prevSessionId = ctx.claudeSessionId
      ctx.claudeSessionId = newSessionId
      ctx.diag('session', sessionChanged ? 'Session ID changed' : 'Session ID confirmed', {
        sessionId: ctx.claudeSessionId,
        prev: sessionChanged ? prevSessionId : undefined,
        internalId: ctx.internalId,
      })

      // Connect (or re-key) to concentrator with the correct session ID
      if (!ctx.wsClient) {
        ctx.connectToConcentrator(ctx.claudeSessionId)
      } else if (sessionChanged) {
        // Session ID changed (e.g. /clear, /resume) - re-key on same connection
        debug('Session ID changed, sending session_clear to concentrator')
        const newModel = typeof data.model === 'string' ? data.model : undefined
        ctx.wsClient.sendSessionClear(ctx.claudeSessionId, ctx.cwd, newModel)

        // Clean up all subagent watchers from old session
        for (const [agentId, watcher] of ctx.subagentWatchers) {
          debug(`Stopping orphaned subagent watcher: ${agentId.slice(0, 7)}`)
          watcher.stop()
        }
        ctx.subagentWatchers.clear()

        // Reset task watcher for new session directory
        ctx.lastTasksJson = ''
        if (ctx.taskWatcher) {
          ctx.taskWatcher.close()
          ctx.taskWatcher = null
        }
        ctx.startTaskWatching()
        ctx.startProjectWatching()
      }

      // Start/restart transcript watcher if path is available and session changed
      if (data.transcript_path && typeof data.transcript_path === 'string') {
        const transcriptPath = data.transcript_path
        ctx.parentTranscriptPath = transcriptPath
        // Start watcher if transcript file exists, or retry until it does
        // Brand new projects can take 60-90s before Claude creates the JSONL file.
        // Use exponential backoff: 500ms, 1s, 2s, 4s... capped at 10s, ~2.5 min total
        async function tryStartTranscriptWatcher(path: string) {
          if (ctx.headless) return // no transcript file watching in headless mode
          let delay = 500
          const maxDelay = 10_000
          const maxTotal = 900_000 // 15 minutes total (slow-starting sessions can take 6+ min)
          let elapsed = 0
          let attempt = 0
          while (elapsed < maxTotal) {
            if (existsSync(path)) {
              if (sessionChanged || !ctx.transcriptWatcher) {
                if (ctx.transcriptWatcher) {
                  debug('Stopping old transcript watcher (session changed)')
                  ctx.transcriptWatcher.stop()
                  ctx.transcriptWatcher = null
                }
                debug(`Starting transcript watcher: ${path}`)
                startTranscriptWatcherFn(ctx, path)
              } else {
                debug('Transcript watcher already running for correct session')
              }
              return
            }
            attempt++
            debug(
              `Transcript file not found (attempt ${attempt}, ${(elapsed / 1000).toFixed(1)}s elapsed), retrying in ${delay}ms: ${path}`,
            )
            await new Promise(r => setTimeout(r, delay))
            elapsed += delay
            delay = Math.min(delay * 2, maxDelay)
          }
          ctx.diag('error', 'Transcript file never appeared', {
            path,
            elapsed: `${(elapsed / 1000).toFixed(0)}s`,
            attempts: attempt,
          })
        }
        tryStartTranscriptWatcher(transcriptPath).catch(err => {
          debug(`tryStartTranscriptWatcher error: ${err instanceof Error ? err.message : err}`)
        })
      } else {
        debug('WARNING: No transcript_path in SessionStart data!')
      }
    }
  }

  // Start live watching subagent transcripts at SubagentStart
  if (event.hookEvent === 'SubagentStart' && event.data) {
    const data = event.data as Record<string, unknown>
    const agentId = String(data.agent_id || '')
    if (agentId && ctx.parentTranscriptPath) {
      // Derive subagent transcript path: {sessionDir}/subagents/agent-{agentId}.jsonl
      const sessionDir = ctx.parentTranscriptPath.replace(/\.jsonl$/, '')
      const agentTranscriptPath = join(sessionDir, 'subagents', `agent-${agentId}.jsonl`)
      if (existsSync(agentTranscriptPath)) {
        startSubagentWatcher(ctx, agentId, agentTranscriptPath, true)
      } else {
        debug(`SubagentStart: transcript file not yet created: ${agentTranscriptPath}`)
        // Retry after a short delay (file may be created slightly after hook fires)
        setTimeout(() => {
          if (existsSync(agentTranscriptPath) && !ctx.subagentWatchers.has(agentId)) {
            startSubagentWatcher(ctx, agentId, agentTranscriptPath, true)
          }
        }, 500)
      }
    }
  }

  // Stop live watcher and do final read at SubagentStop
  if (event.hookEvent === 'SubagentStop' && event.data) {
    const data = event.data as Record<string, unknown>
    const agentId = String(data.agent_id || '')
    const transcriptPath = typeof data.agent_transcript_path === 'string' ? data.agent_transcript_path : undefined
    debug(`SubagentStop: agent=${agentId.slice(0, 7)} transcript=${transcriptPath || 'NONE'}`)
    // Stop live watcher first
    stopSubagentWatcher(ctx, agentId)
    // Then do a final read of the complete transcript
    if (agentId && transcriptPath) {
      startSubagentWatcher(ctx, agentId, transcriptPath, false)
    }
  }

  // TaskCreated: trigger immediate task file read (faster than waiting for chokidar/5s poll)
  if (event.hookEvent === 'TaskCreated') {
    ctx.readTasks()
  }

  // Forward to concentrator, or queue until session ID + WS are ready
  if (ctx.claudeSessionId && ctx.wsClient?.isConnected()) {
    ctx.wsClient.sendHookEvent({ ...event, sessionId: ctx.claudeSessionId })
    debug(`Hook: ${event.hookEvent} -> forwarded (sid=${ctx.claudeSessionId.slice(0, 8)})`)
  } else {
    if (ctx.eventQueue.length >= MAX_EVENT_QUEUE) {
      const dropped = ctx.eventQueue.shift()
      debug(`Event queue full (${MAX_EVENT_QUEUE}), dropping oldest: ${dropped?.hookEvent}`)
    }
    ctx.eventQueue.push(event)
    debug(
      `Hook: ${event.hookEvent} -> QUEUED (claudeSessionId=${ctx.claudeSessionId?.slice(0, 8) || 'null'} ws=${ctx.wsClient?.isConnected() || false} queue=${ctx.eventQueue.length})`,
    )
  }
}
