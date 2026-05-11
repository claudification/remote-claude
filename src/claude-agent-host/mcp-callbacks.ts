/**
 * MCP Channel Callbacks
 * Builds the callback object passed to initMcpChannel().
 * These callbacks bridge MCP tool calls to broker WS messages.
 */

import { randomUUID } from 'node:crypto'
import { isPathWithinCwd } from '../shared/path-guard'
import type { AgentHostMessage } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'
import { getPendingCallbacks } from './broker-connection'
import { wsToHttpUrl } from './cli-args'
import { debug } from './debug'
import { beginLaunch, emitLaunchEvent } from './launch-events'
import type { McpChannelCallbacks } from './mcp-channel'
import { pushChannelMessage, sendPermissionResponse } from './mcp-channel'
import { clearInteraction, sendInteraction } from './pending-interactions'
import { sendProjectChanged } from './task-watcher'

export interface McpCallbackDeps {
  brokerUrl: string
  brokerSecret: string | undefined
  noBroker: boolean
  conversationId: string
  cwd: string
  headless: boolean
  channelEnabled: boolean
  cleanup: () => void
}

export function buildMcpCallbacksWithRules(
  ctx: AgentHostContext,
  deps: McpCallbackDeps,
  permissionRules: { shouldAutoApprove: (toolName: string, inputPreview: string) => boolean },
): McpChannelCallbacks {
  const pending = getPendingCallbacks()

  return {
    onNotify(message, title) {
      ctx.diag('channel', `Notify: ${title ? `[${title}] ` : ''}${message.slice(0, 80)}`)
      if (ctx.wsClient?.isConnected()) {
        ctx.wsClient.send({
          type: 'notify',
          conversationId: deps.conversationId,
          message,
          title,
        })
      }
    },

    async onShareFile(filePath) {
      if (!isPathWithinCwd(filePath, deps.cwd)) {
        debug(`[channel] share_file: path outside CWD: ${filePath}`)
        return null
      }
      const httpUrl = deps.noBroker ? null : wsToHttpUrl(deps.brokerUrl)
      if (!httpUrl) return null
      try {
        const file = Bun.file(filePath)
        if (!(await file.exists())) {
          debug(`[channel] share_file: file not found: ${filePath}`)
          return null
        }
        const contentType = file.type || 'application/octet-stream'
        const res = await fetch(`${httpUrl}/api/files`, {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            'X-Conversation-Id': ctx.claudeSessionId || deps.conversationId,
            ...(deps.brokerSecret ? { Authorization: `Bearer ${deps.brokerSecret}` } : {}),
          },
          body: file,
        })
        if (!res.ok) {
          debug(`[channel] share_file: upload failed: ${res.status}`)
          return null
        }
        const data = (await res.json()) as { url?: string }
        ctx.diag('channel', `Shared: ${filePath} -> ${data.url}`)
        return data.url || null
      } catch (err) {
        debug(`[channel] share_file error: ${err instanceof Error ? err.message : err}`)
        return null
      }
    },

    async onListConversations(status, showMetadata) {
      if (!ctx.wsClient?.isConnected()) return { conversations: [] }
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ conversations: [] }), 5000)
        pending.pendingListConversations = (conversations, self) => {
          clearTimeout(timeout)
          pending.pendingListConversations = null
          resolve({ conversations, self })
        }
        ctx.wsClient?.send({
          type: 'channel_list_conversations',
          status,
          show_metadata: showMetadata,
        } as unknown as AgentHostMessage)
      })
    },

    async onSendMessage(to, intent, message, context, conversationId) {
      if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected' }
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
        pending.pendingSendResult = result => {
          clearTimeout(timeout)
          pending.pendingSendResult = null
          resolve(result)
        }
        ctx.wsClient?.send({
          type: 'channel_send',
          fromConversation: ctx.claudeSessionId || deps.conversationId,
          toConversation: to,
          intent,
          message,
          context,
          conversationId,
        } as unknown as AgentHostMessage)
      })
    },

    onPermissionRequest(data) {
      if (permissionRules.shouldAutoApprove(data.toolName, data.inputPreview)) {
        if (deps.headless && ctx.streamProc) {
          ctx.streamProc.sendPermissionResponse(data.requestId, true)
        } else {
          sendPermissionResponse(data.requestId, 'allow').catch((err: unknown) => {
            debug(`sendPermissionResponse (auto) error: ${err instanceof Error ? err.message : err}`)
          })
        }
        ctx.diag(deps.headless ? 'headless' : 'channel', `Permission auto-approved: ${data.requestId} ${data.toolName}`)
        if (ctx.wsClient?.isConnected()) {
          ctx.wsClient.send({
            type: 'permission_auto_approved',
            conversationId: ctx.conversationId,
            requestId: data.requestId,
            toolName: data.toolName,
            description: data.description,
          } as unknown as AgentHostMessage)
        }
        return
      }

      ctx.diag('channel', `Permission request: ${data.requestId} ${data.toolName}`)
      sendInteraction(ctx, 'permission_request', data.requestId, {
        type: 'permission_request',
        conversationId: ctx.claudeSessionId || deps.conversationId,
        requestId: data.requestId,
        toolName: data.toolName,
        description: data.description,
        inputPreview: data.inputPreview,
      })
    },

    onDialogShow(dialogId, layout) {
      ctx.diag('dialog', `Show: "${layout.title}" (${dialogId.slice(0, 8)})`)
      sendInteraction(ctx, 'dialog_show', dialogId, {
        type: 'dialog_show',
        conversationId: ctx.conversationId,
        dialogId,
        layout,
      } as unknown as AgentHostMessage)
    },

    onDialogDismiss(dialogId) {
      ctx.diag('dialog', `Dismiss: ${dialogId.slice(0, 8)}`)
      clearInteraction(ctx, dialogId)
      ctx.wsClient?.send({
        type: 'dialog_dismiss',
        conversationId: ctx.conversationId,
        dialogId,
      } as unknown as AgentHostMessage)
    },

    onDeliverMessage(content, meta) {
      if (deps.headless && ctx.streamProc) {
        const attrs = Object.entries(meta)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ')
        const wrapped = `<channel ${attrs}>\n${content}\n</channel>`
        ctx.streamProc.sendUserMessage(wrapped)
        ctx.diag('headless', `Delivered message: ${meta.sender} ${content.slice(0, 60)}`)
      } else {
        pushChannelMessage(content, meta)
        ctx.diag('channel', `Delivered message: ${meta.sender} ${content.slice(0, 60)}`)
      }
    },

    onDisconnect() {
      ctx.diag('channel', 'Channel disconnected')
    },

    onTogglePlanMode() {
      if (deps.headless) {
        if (ctx.streamProc) {
          ctx.diag('channel', 'toggle_plan_mode: sending set_permission_mode via control_request')
          ctx.streamProc.sendSetPermissionMode('plan')
        }
      } else {
        ctx.diag('channel', 'toggle_plan_mode: injecting /plan via PTY')
        if (ctx.ptyProcess) ctx.ptyProcess.write('/plan\r')
      }
    },

    async onReviveConversation(targetConversationId) {
      if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
        pending.pendingReviveResult = result => {
          clearTimeout(timeout)
          pending.pendingReviveResult = null
          resolve(result)
        }
        ctx.wsClient?.send({
          type: 'channel_revive',
          conversationId: targetConversationId,
        } as unknown as AgentHostMessage)
      })
    },

    async onSpawnConversation({ onProgress, ...spawnParams }) {
      return handleSpawnConversation(ctx, deps, spawnParams, onProgress)
    },

    async onListHosts() {
      if (!ctx.wsClient?.isConnected()) return []
      try {
        const httpUrl = wsToHttpUrl(deps.brokerUrl)
        const resp = await fetch(`${httpUrl}/api/sentinels`, {
          headers: { Authorization: `Bearer ${deps.brokerSecret}` },
        })
        if (!resp.ok) return []
        const data = (await resp.json()) as Array<{
          alias: string
          hostname?: string
          connected: boolean
        }>
        return data.map(s => ({
          alias: s.alias,
          hostname: s.hostname,
          connected: s.connected,
          conversationCount: 0,
        }))
      } catch {
        return []
      }
    },

    async onGetSpawnDiagnostics(jobId) {
      if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }
      return new Promise(resolve => {
        const timeout = setTimeout(() => {
          pending.pendingSpawnDiagnostics.delete(jobId)
          resolve({ ok: false, error: 'Timeout waiting for diagnostics' })
        }, 10_000)
        pending.pendingSpawnDiagnostics.set(jobId, result => {
          clearTimeout(timeout)
          resolve(result)
        })
        ctx.wsClient?.send({
          type: 'get_spawn_diagnostics',
          jobId,
        } as unknown as AgentHostMessage)
      })
    },

    async onRestartConversation(targetConversationId) {
      if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }
      return new Promise(resolve => {
        const timeout = setTimeout(
          () => resolve({ ok: false, error: 'Timeout waiting for restart confirmation' }),
          10000,
        )
        pending.pendingRestartResult = result => {
          clearTimeout(timeout)
          pending.pendingRestartResult = null
          resolve(result)
        }
        ctx.wsClient?.send({
          type: 'channel_restart',
          conversationId: targetConversationId,
        } as unknown as AgentHostMessage)
      })
    },

    async onControlConversation({ conversationId: targetConversationId, action, model, effort }) {
      if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }
      return new Promise(resolve => {
        const timeout = setTimeout(
          () => resolve({ ok: false, error: 'Timeout waiting for control confirmation' }),
          10000,
        )
        pending.pendingControlResult = result => {
          clearTimeout(timeout)
          pending.pendingControlResult = null
          resolve(result)
        }
        ctx.wsClient?.send({
          type: 'conversation_control',
          targetConversation: targetConversationId,
          action,
          ...(model && { model }),
          ...(effort && { effort }),
          fromConversation: ctx.claudeSessionId || deps.conversationId,
        } as unknown as AgentHostMessage)
      })
    },

    async onConfigureConversation({ conversationId: targetConversationId, label, icon, color, description, keyterms }) {
      if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
        pending.pendingConfigureResult = result => {
          clearTimeout(timeout)
          pending.pendingConfigureResult = null
          resolve(result)
        }
        ctx.wsClient?.send({
          type: 'channel_configure',
          conversationId: targetConversationId,
          label,
          icon,
          color,
          description,
          keyterms,
        } as unknown as AgentHostMessage)
      })
    },

    async onRenameConversation(name, description) {
      if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
        pending.pendingRenameResult = result => {
          clearTimeout(timeout)
          pending.pendingRenameResult = null
          resolve(result)
        }
        ctx.wsClient?.send({
          type: 'rename_conversation',
          conversationId: ctx.conversationId,
          name,
          description,
        } as unknown as AgentHostMessage)
      })
    },

    onProjectChanged() {
      sendProjectChanged(ctx)
    },

    onExitConversation(status, message) {
      const detail = message ? `${status}: ${message}` : status
      beginLaunch(ctx, 'live')
      emitLaunchEvent(ctx, 'conversation_exit', {
        detail,
        raw: { status, message },
      })
      const endReason = status === 'error' ? `self_exit_error: ${message || 'unknown'}` : 'self_exit'
      if (ctx.claudeSessionId) {
        ctx.wsClient?.sendConversationEnd(endReason, {
          source: 'mcp-exit-session',
          detail: {
            ccSessionId: ctx.claudeSessionId,
            agentHostPid: process.pid,
            note: `Agent self-terminated via mcp__rclaude__exit_session (status=${status})${message ? `: ${message}` : ''}`,
          },
        })
      }
      setTimeout(() => {
        deps.cleanup()
        process.exit(status === 'error' ? 1 : 0)
      }, 500)
    },
  }
}

async function handleSpawnConversation(
  ctx: AgentHostContext,
  _deps: McpCallbackDeps,
  spawnParams: Record<string, unknown>,
  onProgress?: (event: Record<string, unknown>) => void,
) {
  if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }

  const pending = getPendingCallbacks()
  const requestId = randomUUID()
  const spawnResult = await new Promise<{ ok: boolean; error?: string; conversationId?: string; jobId?: string }>(
    resolve => {
      const timeout = setTimeout(() => {
        if (pending.pendingSpawnRequestId === requestId) {
          pending.pendingSpawnResult = null
          pending.pendingSpawnRequestId = null
        }
        resolve({ ok: false, error: 'Timeout' })
      }, 15000)
      pending.pendingSpawnRequestId = requestId
      pending.pendingSpawnResult = result => {
        clearTimeout(timeout)
        pending.pendingSpawnResult = null
        pending.pendingSpawnRequestId = null
        resolve(result)
      }
      ctx.wsClient?.send({
        type: 'channel_spawn',
        requestId,
        ...spawnParams,
      } as unknown as AgentHostMessage)
    },
  )

  if (!spawnResult.ok) return spawnResult

  const jobId = spawnResult.jobId
  ctx.diag(
    'channel',
    `spawn_session: ${(spawnParams as { cwd?: string }).cwd} mode=${(spawnParams as { mode?: string }).mode || 'default'} conversationId=${spawnResult.conversationId?.slice(0, 8)} job=${jobId?.slice(0, 8)}`,
  )

  if (jobId && onProgress) {
    pending.launchJobListeners.set(jobId, onProgress)
    ctx.wsClient?.send({ type: 'subscribe_job', jobId } as unknown as AgentHostMessage)
  }

  function cleanupJob() {
    if (!jobId) return
    pending.launchJobListeners.delete(jobId)
    ctx.wsClient?.send({ type: 'unsubscribe_job', jobId } as unknown as AgentHostMessage)
  }

  const SPAWN_RENDEZVOUS_MS = 45_000
  if (spawnResult.conversationId) {
    try {
      const wid = spawnResult.conversationId
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.pendingRendezvous.delete(wid)
          reject(new Error(`Rendezvous timeout (${SPAWN_RENDEZVOUS_MS / 1000}s)`))
        }, SPAWN_RENDEZVOUS_MS)
        pending.pendingRendezvous.set(wid, {
          resolve: msg => {
            clearTimeout(timer)
            resolve(msg)
          },
          reject: (e: string) => {
            clearTimeout(timer)
            reject(new Error(e))
          },
        })
      })
      const conversation = result.conversation as Record<string, unknown> | undefined
      ctx.diag(
        'channel',
        `spawn_conversation: rendezvous resolved cc-session=${(result.ccSessionId as string)?.slice(0, 8)}`,
      )
      cleanupJob()
      return { ok: true, conversationId: spawnResult.conversationId, jobId, conversation }
    } catch (err) {
      ctx.diag('channel', `spawn_conversation: rendezvous failed: ${err instanceof Error ? err.message : err}`)
      cleanupJob()
      return { ok: true, conversationId: spawnResult.conversationId, jobId, timedOut: true }
    }
  }

  cleanupJob()
  return { ok: true, conversationId: spawnResult.conversationId, jobId }
}
