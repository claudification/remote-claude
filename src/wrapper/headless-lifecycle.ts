/**
 * Headless Lifecycle
 * Callbacks for the stream-json backend: onInit, onResult, onExit,
 * onPermissionRequest, onTaskStarted, onSubagentEntry, respawn for /clear.
 */

import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { WrapperMessage } from '../shared/protocol'
import { debug as _debug } from './debug'
import { hasPendingAskRequests } from './local-server'
import { hasPendingDialogs, resetMcpChannel } from './mcp-channel'
import { writeMergedSettings } from './settings-merge'
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
  rclaudeDir: string
  claudeVersion?: string
  mcpConfigPath: string
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
  const { ctx, permissionRules, finalClaudeArgs, cleanup } = deps

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

      // NOTE: Ad-hoc initial prompt is NOT sent here. CC's init message only fires
      // AFTER the first user message in --print mode. The prompt is sent from
      // sendAdHocPrompt() called after spawnStreamClaude() returns.
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
      // Capture result text for ad-hoc sessions (forwarded to concentrator for task completion display)
      if (result.result_text && typeof result.result_text === 'string' && ctx.wsClient?.isConnected()) {
        ctx.wsClient.send({
          type: 'result_text',
          sessionId: ctx.claudeSessionId || ctx.internalId,
          text: result.result_text,
        } as unknown as WrapperMessage)
      }

      // Ad-hoc sessions: auto-terminate after the first result.
      // CC in stream-json mode stays alive waiting for more stdin input.
      // For fire-and-forget tasks, we exit after the task completes.
      const isAdHoc = process.env.RCLAUDE_ADHOC === '1'
      if (isAdHoc) {
        // Check for pending user interactions (dialogs, AskUserQuestion, plan approvals).
        // If any are pending, CC is waiting for user input and will continue processing
        // after they resolve -- shutting down now would kill the session prematurely.
        const pendingCount =
          (hasPendingDialogs() ? 1 : 0) + ctx.pendingAskRequests.size + (hasPendingAskRequests() ? 1 : 0)

        if (pendingCount > 0) {
          debug(`[ad-hoc] Result received but ${pendingCount} pending interaction(s) -- deferring shutdown`)
          ctx.diag(
            'ad-hoc',
            `Deferring shutdown: ${pendingCount} pending interaction(s) (dialogs=${hasPendingDialogs()}, asks=${ctx.pendingAskRequests.size}, hookAsks=${hasPendingAskRequests()})`,
          )
          // Poll until all pending interactions are resolved, then let the next
          // result message (after CC continues) trigger normal ad-hoc shutdown.
          // Safety cap: 5 min max wait to prevent zombie sessions.
          const MAX_WAIT_MS = 5 * 60_000
          const POLL_MS = 2_000
          const startedAt = Date.now()
          const checkPending = () => {
            const still =
              (hasPendingDialogs() ? 1 : 0) + ctx.pendingAskRequests.size + (hasPendingAskRequests() ? 1 : 0)
            if (still > 0 && Date.now() - startedAt < MAX_WAIT_MS) {
              setTimeout(checkPending, POLL_MS)
              return
            }
            if (still > 0) {
              debug(`[ad-hoc] Safety cap reached with ${still} pending interaction(s) -- shutting down anyway`)
              ctx.diag('ad-hoc', `Safety cap: forced shutdown with ${still} pending interaction(s)`)
            } else {
              debug('[ad-hoc] All pending interactions resolved -- waiting for next result from CC')
              ctx.diag('ad-hoc', 'All pending interactions resolved, CC will continue')
            }
            // Don't shut down here -- CC will continue processing after the interaction
            // resolves and emit another result message, which will re-enter this handler.
            // Only force-shutdown if the safety cap was hit.
            if (still > 0) {
              adHocShutdown(ctx, result, cleanup)
            }
          }
          setTimeout(checkPending, POLL_MS)
          return
        }

        adHocShutdown(ctx, result, cleanup)
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

    onPlanModeChanged(planMode) {
      const sessionId = ctx.claudeSessionId || ctx.internalId
      ctx.diag('headless', `Plan mode: ${planMode ? 'ON' : 'OFF'} (from status message)`)
      if (ctx.wsClient?.isConnected()) {
        ctx.wsClient.send({
          type: 'plan_mode_changed',
          sessionId,
          planMode,
        } as unknown as WrapperMessage)
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
          plan = '(Plan content not available -- file missing or empty)'
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
          ctx.diag('headless', `ExitPlanMode: forwarded for approval (${request.requestId.slice(0, 8)})`)
        } else {
          // No dashboard connected -- auto-approve to prevent CC from hanging
          ctx.diag('headless', 'ExitPlanMode: no WS connection, auto-approving')
          ctx.streamProc?.sendPermissionResponse(request.requestId, true, undefined, toolUseId)
          ctx.pendingAskRequests.delete(pendingKey)
        }
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
        // /clear: respawn CC fresh (strip --resume/--session-id)
        ctx.clearRequested = false
        const freshArgs = finalClaudeArgs.filter(
          (a, i, arr) =>
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
 * Perform ad-hoc session shutdown: worktree merge-back, close CC stdin, force-kill safety net.
 * Extracted so it can be called immediately or deferred after pending interactions resolve.
 */
function adHocShutdown(
  ctx: WrapperContext,
  result: { subtype: string; [key: string]: unknown },
  cleanup: () => void,
): void {
  // Worktree merge-back and cleanup.
  // CC won't get a chance to fire WorktreeRemove (we kill it on exit),
  // so rclaude handles merge + cleanup directly.
  const adHocWorktree = process.env.RCLAUDE_WORKTREE
  if (adHocWorktree) {
    // ctx.cwd is the PROJECT ROOT (set at rclaude startup), not the worktree.
    // CC's --worktree flag creates the worktree at .claude/worktrees/<name>.
    const projectRoot = ctx.cwd
    const wtPath = join(projectRoot, '.claude', 'worktrees', adHocWorktree)
    const branch = `worktree-${adHocWorktree}`

    try {
      debug(`[ad-hoc] Worktree cleanup: path=${wtPath} branch=${branch}`)

      // Check if worktree actually exists (CC may have cleaned it up itself)
      const wtExists = Bun.spawnSync(['test', '-d', wtPath]).exitCode === 0
      if (!wtExists) {
        debug(`[ad-hoc] Worktree already gone: ${wtPath}`)
        ctx.diag('ad-hoc', 'Worktree already cleaned up by CC')
      } else {
        const mainBranch =
          Bun.spawnSync(['git', 'rev-parse', '--verify', 'main'], { cwd: wtPath }).exitCode === 0 ? 'main' : 'master'
        const aheadResult = Bun.spawnSync(['git', 'rev-list', '--count', `${mainBranch}..HEAD`], { cwd: wtPath })
        const ahead = Number.parseInt(aheadResult.stdout.toString().trim(), 10) || 0

        let merged = ahead === 0
        if (ahead > 0) {
          const ff = Bun.spawnSync(['git', 'fetch', '.', `HEAD:${mainBranch}`], { cwd: wtPath })
          if (ff.exitCode === 0) {
            debug(`[ad-hoc] Merged ${ahead} commits from ${branch} to ${mainBranch}`)
            ctx.diag('ad-hoc', `Merged ${ahead} commits from ${branch} to ${mainBranch}`)
            merged = true
          } else {
            debug(`[ad-hoc] Cannot fast-forward ${mainBranch} (${ahead} unmerged commits on ${branch})`)
            ctx.diag('ad-hoc', `WARNING: ${ahead} unmerged commits on ${branch} - worktree preserved`)
          }
        } else {
          debug(`[ad-hoc] Branch ${branch} already merged (0 commits ahead)`)
        }

        if (merged) {
          // Remove worktree from project root (must be outside the worktree)
          const removeResult = Bun.spawnSync(['git', 'worktree', 'remove', wtPath], { cwd: projectRoot })
          if (removeResult.exitCode === 0) {
            debug(`[ad-hoc] Removed worktree: ${wtPath}`)
            ctx.diag('ad-hoc', `Worktree removed: ${adHocWorktree}`)
            const branchDel = Bun.spawnSync(['git', 'branch', '-d', branch], { cwd: projectRoot })
            if (branchDel.exitCode === 0) {
              debug(`[ad-hoc] Deleted branch: ${branch}`)
              ctx.diag('ad-hoc', `Branch deleted: ${branch}`)
            } else {
              debug(`[ad-hoc] Branch delete failed: ${branchDel.stderr.toString().trim()}`)
            }
          } else {
            const err = removeResult.stderr.toString().trim()
            debug(`[ad-hoc] Worktree remove failed: ${err}`)
            ctx.diag('ad-hoc', `Worktree remove failed: ${err} - leaving in place`)
          }
        } else {
          ctx.diag('ad-hoc', `Worktree NOT removed (unmerged work on ${branch}). NO CODE LOST.`)
        }
      }
    } catch (e) {
      debug(`[ad-hoc] Worktree cleanup failed: ${e}`)
      ctx.diag('ad-hoc', `Worktree cleanup error: ${e} - worktree preserved`)
    }
  }

  debug('[ad-hoc] Result received, closing CC stdin for graceful shutdown')
  ctx.diag('ad-hoc', `Task complete (${result.subtype}), closing stdin`)
  // Close CC's stdin pipe so it sees EOF and runs shutdown hooks
  // (including WorktreeRemove). CC will exit naturally, firing onExit.
  setTimeout(() => {
    try {
      const stdin = ctx.streamProc?.proc?.stdin
      if (stdin && typeof stdin !== 'number') stdin.end()
      debug('[ad-hoc] CC stdin closed (EOF sent)')
    } catch (e) {
      debug(`[ad-hoc] Failed to close stdin: ${e}`)
    }
    // Safety net: if CC doesn't exit within 10s after EOF, force kill
    setTimeout(() => {
      debug('[ad-hoc] CC still alive after 10s, force exiting')
      cleanup()
      process.exit(0)
    }, 10_000)
  }, 2000)
}

/**
 * Send the ad-hoc initial prompt from a file.
 * Called AFTER spawnStreamClaude() returns, NOT from onInit.
 *
 * Why: CC's init message only fires AFTER the first user message in --print mode.
 * If we wait for onInit, the prompt never gets sent (chicken-and-egg).
 * Instead, we send the prompt shortly after the process spawns. CC queues
 * stdin and processes it once ready -- the user message triggers init.
 */
export function sendAdHocPrompt(ctx: WrapperContext): void {
  const promptFile = process.env.RCLAUDE_INITIAL_PROMPT_FILE
  if (!promptFile) return

  debug(`[ad-hoc] Prompt file: ${promptFile}`)
  try {
    const prompt = readFileSync(promptFile, 'utf-8').trim()
    if (!prompt) {
      debug('[ad-hoc] WARNING: Prompt file was empty')
      ctx.diag('ad-hoc', 'WARNING: prompt file empty')
      unlinkSync(promptFile)
      return
    }
    debug(`[ad-hoc] Read prompt (${prompt.length} chars), scheduling send in 1s`)
    ctx.diag('ad-hoc', `Read prompt file (${prompt.length} chars)`)

    // 1s delay to let CC process spawn and set up stdin pipe
    setTimeout(() => {
      if (ctx.streamProc) {
        ctx.streamProc.sendUserMessage(prompt)
        debug(`[ad-hoc] Initial prompt sent (${prompt.length} chars)`)
        ctx.diag('ad-hoc', `Sent initial prompt (${prompt.length} chars)`)
      } else {
        debug('[ad-hoc] ERROR: streamProc not available when sending prompt')
        ctx.diag('ad-hoc', 'ERROR: streamProc not available')
      }
    }, 1000)

    // Clean up the prompt file
    unlinkSync(promptFile)
    debug('[ad-hoc] Cleaned up prompt file')
  } catch (e) {
    debug(`[ad-hoc] FAILED to read prompt file ${promptFile}: ${e}`)
    ctx.diag('ad-hoc', `FAILED to read prompt file: ${e}`)
  }
}

/**
 * Respawn the headless CC process (used by /clear handler).
 * Reuses all callbacks since they reference the outer WrapperContext.
 * Re-generates the settings file and MCP config to guarantee hooks + MCP
 * survive across the /clear boundary (CC or its SIGTERM cleanup may have
 * deleted the original files).
 */
async function respawnHeadless(deps: HeadlessCallbackDeps, args: string[]) {
  // Reset MCP transport so the new CC gets a clean connection
  // (old CC's transport state may linger and block the new client)
  await resetMcpChannel()

  // Re-write settings file (hooks) and MCP config -- they may have been
  // deleted by CC's exit cleanup or a race with the stale reaper.
  const { ctx, rclaudeDir, localServerPort, claudeVersion, mcpConfigPath } = deps
  try {
    deps.settingsPath = await writeMergedSettings(ctx.internalId, localServerPort, claudeVersion, rclaudeDir)
    ctx.diag('headless', `Regenerated settings: ${deps.settingsPath}`)
  } catch (e) {
    debug(`[respawn] Failed to regenerate settings: ${e}`)
  }
  try {
    await Bun.write(
      mcpConfigPath,
      JSON.stringify({ mcpServers: { rclaude: { type: 'http', url: `http://localhost:${localServerPort}/mcp` } } }),
    )
    ctx.diag('headless', `Regenerated MCP config: ${mcpConfigPath}`)
  } catch (e) {
    debug(`[respawn] Failed to regenerate MCP config: ${e}`)
  }

  const opts = buildHeadlessSpawnOptions(deps)
  // Override args for the fresh spawn
  opts.args = args
  deps.ctx.streamProc = deps.spawnStreamClaude(opts)
  deps.ctx.streamProc.forwardStdin()
}
