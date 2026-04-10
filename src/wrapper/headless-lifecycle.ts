/**
 * Headless Lifecycle
 * Callbacks for the stream-json backend: onInit, onResult, onExit,
 * onPermissionRequest, onTaskStarted, onSubagentEntry, respawn for /clear.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WrapperMessage } from '../shared/protocol'
import { debug as _debug } from './debug'
import type { StreamBackendOptions, StreamProcess } from './stream-backend'
import { sendTranscriptEntriesChunked, startSubagentWatcher } from './transcript-manager'
import type { WrapperContext } from './wrapper-context'

const debug = (msg: string) => _debug(msg)

export interface HeadlessCallbackDeps {
  ctx: WrapperContext
  permissionRules: {
    shouldAutoApprove: (toolName: string, inputPreview: string) => boolean
    isPlanModeAllowed: () => boolean
  }
  finalClaudeArgs: string[]
  settingsPath: string
  localServerPort: number
  concentratorUrl?: string
  concentratorSecret?: string
  spawnStreamClaude: (opts: StreamBackendOptions) => StreamProcess
  cleanup: () => void
}

/**
 * Build the spawn options for the headless (stream-json) backend.
 * These callbacks capture the WrapperContext and update shared state.
 * Returns the options object to pass to spawnStreamClaude.
 */
export function buildHeadlessSpawnOptions(deps: HeadlessCallbackDeps): StreamBackendOptions {
  const { ctx, permissionRules, finalClaudeArgs, spawnStreamClaude, cleanup } = deps

  const opts: StreamBackendOptions = {
    args: finalClaudeArgs,
    settingsPath: deps.settingsPath,
    sessionId: ctx.internalId,
    localServerPort: deps.localServerPort,
    concentratorUrl: deps.concentratorUrl,
    concentratorSecret: deps.concentratorSecret,

    onTranscriptEntries(entries, isInitial) {
      sendTranscriptEntriesChunked(ctx, entries, isInitial)
    },

    onInit(init) {
      debug(`[headless] init: session=${init.session_id?.slice(0, 8)} model=${init.model}`)
      if (init.session_id) {
        const prevId = ctx.claudeSessionId
        ctx.claudeSessionId = init.session_id
        // Handle deferred /clear rekey -- now we have the REAL session ID
        if (ctx.pendingClearFromId && ctx.wsClient?.isConnected()) {
          ctx.diag(
            'headless',
            `Deferred rekey: ${ctx.pendingClearFromId.slice(0, 8)} -> ${init.session_id.slice(0, 8)}`,
          )
          ctx.wsClient.sendSessionClear(init.session_id, ctx.cwd)
          ctx.pendingClearFromId = null
        } else if (prevId && prevId !== init.session_id && ctx.wsClient?.isConnected()) {
          // Session ID changed outside /clear (e.g., revive with different session)
          ctx.diag('headless', `Session ID changed: ${prevId.slice(0, 8)} -> ${init.session_id.slice(0, 8)}`)
          ctx.wsClient.sendSessionClear(init.session_id, ctx.cwd)
        } else if (!prevId) {
          ctx.diag('headless', `CC session ID from init: ${init.session_id.slice(0, 8)}`)
        }
      }
      // Derive transcript path from init if not yet set by SessionStart hook
      if (init.session_id && !ctx.parentTranscriptPath) {
        const cwdSlug = ctx.cwd.replace(/\//g, '-').replace(/^-/, '')
        ctx.parentTranscriptPath = join(
          process.env.HOME || '',
          '.claude',
          'projects',
          cwdSlug,
          `${init.session_id}.jsonl`,
        )
        debug(`[headless] Derived transcript path: ${ctx.parentTranscriptPath}`)
      }
      // Forward full init metadata to concentrator for dashboard autocomplete
      if (ctx.wsClient?.isConnected()) {
        ctx.wsClient.send({
          type: 'session_info',
          sessionId: ctx.claudeSessionId || ctx.internalId,
          tools: (init.tools as Array<{ name: string } | string>)?.map(t => (typeof t === 'string' ? t : t.name)) || [],
          slashCommands: (init.slash_commands as string[]) || [],
          skills: (init.skills as string[]) || [],
          agents: (init.agents as string[]) || [],
          mcpServers: (init.mcp_servers as Array<{ name: string; status?: string }>) || [],
          plugins: (init.plugins as Array<{ name: string; source?: string }>) || [],
          model: (init.model as string) || '',
          permissionMode: (init.permissionMode as string) || '',
          claudeCodeVersion: (init.claude_code_version as string) || '',
          fastModeState: (init.fast_mode_state as string) || '',
        } as WrapperMessage)
        ctx.diag(
          'headless',
          `Sent session_info: ${(init.tools as unknown[])?.length || 0} tools, ${(init.skills as unknown[])?.length || 0} skills, ${(init.agents as unknown[])?.length || 0} agents`,
        )
      }
    },

    onResult(result) {
      ctx.diag('headless', `Result: ${result.subtype} cost=$${result.total_cost_usd} turns=${result.num_turns}`)
      if (result.total_cost_usd != null && ctx.wsClient?.isConnected() && ctx.claudeSessionId) {
        ctx.wsClient.send({
          type: 'turn_cost',
          sessionId: ctx.claudeSessionId,
          costUsd: result.total_cost_usd,
        } as unknown as WrapperMessage)
      }
    },

    onStreamEvent(event) {
      // Forward raw API SSE deltas to concentrator for real-time streaming
      if (ctx.wsClient?.isConnected()) {
        ctx.wsClient.sendStreamDelta(event)
      }
    },

    onRateLimit(retryAfterMs, message) {
      if (ctx.wsClient?.isConnected()) {
        ctx.wsClient.sendRateLimit(retryAfterMs, message)
      }
    },

    onTaskStarted(task) {
      if (task.taskType === 'local_agent' && task.taskId) {
        // Map toolUseId -> taskId for routing subagent entries from stdout
        ctx.agentToolUseMap.set(task.toolUseId, task.taskId)
        if (ctx.parentTranscriptPath) {
          // Also start file watcher for subagent JSONL (backup path)
          const sessionDir = ctx.parentTranscriptPath.replace(/\.jsonl$/, '')
          const agentTranscriptPath = join(sessionDir, 'subagents', `agent-${task.taskId}.jsonl`)
          debug(`[headless] Agent started: ${task.taskId.slice(0, 8)} -> ${agentTranscriptPath}`)
          startSubagentWatcher(ctx, task.taskId, agentTranscriptPath, true)
        }
      }
    },

    onSubagentEntry(toolUseId, entry) {
      const agentId = ctx.agentToolUseMap.get(toolUseId)
      if (agentId) {
        sendTranscriptEntriesChunked(ctx, [entry], false, agentId)
      }
    },

    onPermissionRequest(request) {
      const inputStr = JSON.stringify(request.toolInput)
      const toolUseId = request.tool_use_id as string | undefined

      // EnterPlanMode: check allowPlanMode config, approve or deny
      if (request.toolName === 'EnterPlanMode') {
        const sessionId = ctx.claudeSessionId || ctx.internalId
        if (!permissionRules.isPlanModeAllowed()) {
          ctx.streamProc?.sendPermissionResponse(request.requestId, false, undefined, toolUseId)
          ctx.diag('headless', 'EnterPlanMode denied: allowPlanMode is false')
          return
        }
        ctx.streamProc?.sendPermissionResponse(request.requestId, true, undefined, toolUseId)
        ctx.diag('headless', 'EnterPlanMode approved')
        if (ctx.wsClient?.isConnected()) {
          ctx.wsClient.send({
            type: 'plan_mode_changed',
            sessionId,
            planMode: true,
          } as unknown as WrapperMessage)
        }
        return
      }

      // ExitPlanMode: intercept and forward plan to dashboard for approval
      if (request.toolName === 'ExitPlanMode') {
        const sessionId = ctx.claudeSessionId || ctx.internalId
        ctx.diag('headless', `ExitPlanMode input keys: ${Object.keys(request.toolInput || {}).join(', ')}`)
        let plan = (request.toolInput?.plan as string) || ''
        const planFilePath = request.toolInput?.planFilePath as string | undefined
        const allowedPrompts = request.toolInput?.allowedPrompts as string[] | undefined

        // CC injects plan + planFilePath into the can_use_tool input via normalizeToolInput.
        // Fallback: read from planFilePath if plan content is somehow empty.
        if (!plan && planFilePath) {
          try {
            plan = readFileSync(planFilePath, 'utf-8')
            ctx.diag('headless', `ExitPlanMode: read plan from ${planFilePath} (${plan.length} chars)`)
          } catch {
            ctx.diag('headless', `ExitPlanMode: failed to read ${planFilePath}`)
          }
        }
        if (!plan) {
          plan = '(Plan content not available)'
        }

        // Store pending request for response routing
        const pendingKey = `plan_${request.requestId}`
        ctx.pendingAskRequests.set(pendingKey, { requestId: request.requestId, questions: [] })

        if (ctx.wsClient?.isConnected()) {
          ctx.wsClient.send({
            type: 'plan_approval',
            sessionId,
            requestId: request.requestId,
            toolUseId,
            plan,
            planFilePath,
            allowedPrompts,
          } as unknown as WrapperMessage)
        }
        ctx.diag('headless', `ExitPlanMode: forwarded for approval (${request.requestId.slice(0, 8)})`)
        return
      }

      // AskUserQuestion: route to dashboard ask_question UI, respond with answers
      if (request.toolName === 'AskUserQuestion' && toolUseId) {
        const questions = (request.toolInput?.questions as unknown[]) || []
        ctx.pendingAskRequests.set(toolUseId, { requestId: request.requestId, questions })
        if (ctx.wsClient?.isConnected()) {
          ctx.wsClient.send({
            type: 'ask_question',
            sessionId: ctx.claudeSessionId || ctx.internalId,
            toolUseId,
            questions,
          } as unknown as WrapperMessage)
        }
        ctx.diag('headless', `AskUserQuestion: ${toolUseId.slice(0, 12)} ${questions.length}q`)
        return
      }

      // Check auto-approve rules (rclaude.json + session rules) before forwarding to dashboard
      if (permissionRules.shouldAutoApprove(request.toolName, inputStr.slice(0, 200))) {
        ctx.streamProc?.sendPermissionResponse(request.requestId, true, undefined, toolUseId)
        ctx.diag('headless', `Permission auto-approved: ${request.requestId} ${request.toolName}`)
        if (ctx.wsClient?.isConnected()) {
          ctx.wsClient.send({
            type: 'permission_auto_approved',
            sessionId: ctx.claudeSessionId || ctx.internalId,
            requestId: request.requestId,
            toolName: request.toolName,
            description: (request.decision_reason as string) || `${request.toolName}: ${inputStr.slice(0, 100)}`,
          } as unknown as WrapperMessage)
        }
        return
      }

      // Forward to concentrator for dashboard handling
      if (ctx.wsClient?.isConnected()) {
        ctx.wsClient.send({
          type: 'permission_request',
          sessionId: ctx.claudeSessionId || ctx.internalId,
          toolName: request.toolName,
          description: (request.decision_reason as string) || `${request.toolName}: ${inputStr.slice(0, 100)}`,
          inputPreview: inputStr.slice(0, 200),
          requestId: request.requestId,
          toolUseId,
        })
        ctx.diag('headless', `Permission request: ${request.toolName} (${request.requestId.slice(0, 8)})`)
      }
    },

    onExit(code) {
      if (ctx.clearRequested) {
        // /clear: respawn CC fresh (strip --continue/--resume/--session-id)
        ctx.clearRequested = false
        const freshArgs = finalClaudeArgs.filter(
          (a, i, arr) =>
            a !== '--continue' &&
            a !== '--resume' &&
            !(i > 0 && arr[i - 1] === '--resume') &&
            a !== '--session-id' &&
            !(i > 0 && arr[i - 1] === '--session-id'),
        )
        const oldSessionId = ctx.claudeSessionId
        ctx.claudeSessionId = null
        ctx.parentTranscriptPath = ''
        ctx.pendingEditInputs.clear()
        ctx.agentToolUseMap.clear()
        ctx.pendingAskRequests.clear()
        // Don't rekey yet -- wait for the new CC's real session ID from onInit.
        // Sending randomUUID() here caused double-rekey and transcript loss.
        ctx.pendingClearFromId = oldSessionId
        ctx.diag(
          'headless',
          `Respawning CC fresh after /clear (old: ${oldSessionId?.slice(0, 8) || 'none'}, rekey deferred)`,
        )
        respawnHeadless(deps, freshArgs)
        return
      }
      if (ctx.claudeSessionId) {
        ctx.wsClient?.sendSessionEnd(code === 0 ? 'normal' : `exit_code_${code}`)
      }
      cleanup()
      process.exit(code ?? 0)
    },
  }

  return opts
}

/**
 * Respawn the headless CC process (used by /clear handler).
 * Reuses all callbacks since they reference the outer WrapperContext.
 */
function respawnHeadless(deps: HeadlessCallbackDeps, args: string[]) {
  const opts = buildHeadlessSpawnOptions(deps)
  // Override args for the fresh spawn
  opts.args = args
  deps.ctx.streamProc = deps.spawnStreamClaude(opts)
  deps.ctx.streamProc.forwardStdin()
}
