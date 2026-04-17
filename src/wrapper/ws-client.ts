/**
 * WebSocket Client
 * Connects to concentrator with automatic reconnection and offline queuing
 */

import type {
  BgTaskOutput,
  ConcentratorMessage,
  FileResponse,
  Heartbeat,
  HookEvent,
  InterSessionDelivery,
  InterSessionListResponse,
  ProjectLinkRequest,
  SessionClear,
  SessionEnd,
  SessionMeta,
  SubagentTranscript,
  TerminalData,
  TranscriptEntries,
  TranscriptEntry,
  WrapperCapability,
  WrapperMessage,
} from '../shared/protocol'
import { DEFAULT_CONCENTRATOR_URL } from '../shared/protocol'
import { BUILD_VERSION } from '../shared/version'
import { debug as _debug } from './debug'

const debug = (msg: string) => _debug(`[ws] ${msg}`)

export interface WsClientOptions {
  concentratorUrl?: string
  concentratorSecret?: string
  sessionId: string
  wrapperId: string
  cwd: string
  model?: string
  args?: string[]
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
  spinnerVerbs?: string[]
  autocompactPct?: number
  maxBudgetUsd?: number
  adHocTaskId?: string
  adHocWorktree?: string
  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (error: Error) => void
  capabilities?: WrapperCapability[]
  onInput?: (input: string, crDelay?: number) => void
  onTerminalAttach?: (cols: number, rows: number) => void
  onTerminalDetach?: () => void
  onTerminalInput?: (data: string) => void
  onTerminalResize?: (cols: number, rows: number) => void
  onTranscriptRequest?: (limit?: number) => void
  onSubagentTranscriptRequest?: (agentId: string, limit?: number) => void
  onFileRequest?: (requestId: string, path: string) => void
  onFileEditorMessage?: (message: Record<string, unknown>) => void
  onAck?: (origins: string[]) => void
  onTranscriptKick?: () => void
  onChannelSessionsList?: (sessions: InterSessionListResponse['sessions']) => void
  onChannelSendResult?: (result: unknown) => void
  onChannelDeliver?: (delivery: InterSessionDelivery) => void
  onChannelLinkRequest?: (request: ProjectLinkRequest) => void
  onPermissionResponse?: (requestId: string, behavior: 'allow' | 'deny', toolUseId?: string) => void
  onPermissionRule?: (toolName: string, behavior: 'allow' | 'deny') => void
  onRendezvousResult?: (message: Record<string, unknown>) => void
  onChannelReviveResult?: (result: { ok: boolean; error?: string; name?: string }) => void
  onChannelRestartResult?: (result: {
    ok: boolean
    error?: string
    name?: string
    selfRestart?: boolean
    alreadyEnded?: boolean
  }) => void
  onChannelSpawnResult?: (result: { ok: boolean; error?: string; wrapperId?: string }) => void
  onSpawnDiagnosticsResult?: (result: {
    ok: boolean
    jobId?: string
    error?: string
    diagnostics?: Record<string, unknown>
  }) => void
  /**
   * Launch job events for jobs this wrapper subscribed to. Fires on
   * launch_progress / launch_log / job_complete / job_failed -- the shape
   * matches what the concentrator forwards verbatim via forwardJobEvent.
   */
  onLaunchJobEvent?: (event: Record<string, unknown>) => void
  onChannelConfigureResult?: (result: { ok: boolean; error?: string }) => void
  onChannelRenameResult?: (result: { ok: boolean; error?: string }) => void
  onAskAnswer?: (
    toolUseId: string,
    answers?: Record<string, string>,
    annotations?: Record<string, { preview?: string; notes?: string }>,
    skip?: boolean,
  ) => void
  onDialogResult?: (dialogId: string, result: import('../shared/dialog-schema').DialogResult) => void
  onDialogKeepalive?: (dialogId: string) => void
  onPlanApprovalResponse?: (
    requestId: string,
    action: 'approve' | 'reject' | 'feedback',
    feedback?: string,
    toolUseId?: string,
  ) => void
  onQuitSession?: () => void
  onInterrupt?: () => void
}

export interface WsClient {
  send: (message: WrapperMessage) => void
  sendHookEvent: (event: HookEvent) => void
  sendSessionEnd: (reason: string) => void
  sendSessionClear: (newSessionId: string, cwd: string, model?: string) => void
  sendTerminalData: (data: string) => void
  sendTranscriptEntries: (entries: TranscriptEntry[], isInitial: boolean) => void
  sendSubagentTranscript: (agentId: string, entries: TranscriptEntry[], isInitial: boolean) => void
  sendFileResponse: (requestId: string, data?: string, mediaType?: string, error?: string) => void
  sendBgTaskOutput: (taskId: string, data: string, done: boolean) => void
  sendStreamDelta: (event: Record<string, unknown>) => void
  sendRateLimit: (retryAfterMs: number, message: string) => void
  sendSessionStatus: (status: 'active' | 'idle') => void
  close: () => void
  isConnected: () => boolean
}

/**
 * Create WebSocket client with offline queuing
 */
export function createWsClient(options: WsClientOptions): WsClient {
  const {
    concentratorUrl = DEFAULT_CONCENTRATOR_URL,
    concentratorSecret,
    sessionId: initialSessionId,
    wrapperId,
    cwd,
    model,
    args,
    claudeVersion,
    claudeAuth,
    spinnerVerbs,
    autocompactPct,
    maxBudgetUsd,
    adHocTaskId,
    adHocWorktree,
    onConnected,
    onDisconnected,
    onError,
    capabilities,
    onInput,
    onTerminalAttach,
    onTerminalDetach,
    onTerminalInput,
    onTerminalResize,
    onTranscriptRequest,
    onSubagentTranscriptRequest,
    onFileRequest,
    onFileEditorMessage,
    onAck,
    onTranscriptKick,
    onChannelSessionsList,
    onChannelSendResult,
    onChannelDeliver,
    onChannelLinkRequest,
    onPermissionResponse,
    onPermissionRule,
    onRendezvousResult,
    onChannelReviveResult,
    onChannelRestartResult,
    onChannelSpawnResult,
    onSpawnDiagnosticsResult,
    onLaunchJobEvent,
    onChannelConfigureResult,
    onChannelRenameResult,
    onAskAnswer,
    onDialogResult,
    onDialogKeepalive,
    onPlanApprovalResponse,
    onQuitSession,
    onInterrupt,
  } = options

  let sessionId = initialSessionId
  let ws: WebSocket | null = null
  let connected = false
  let shouldReconnect = true
  let reconnectAttempts = 0
  const maxReconnectAttempts = 50
  const messageQueue: WrapperMessage[] = []
  const MAX_QUEUE_SIZE = 500
  let heartbeatInterval: Timer | null = null

  function connect() {
    try {
      const wsUrl = concentratorSecret
        ? `${concentratorUrl}${concentratorUrl.includes('?') ? '&' : '?'}secret=${encodeURIComponent(concentratorSecret)}`
        : concentratorUrl
      debug(`Connecting to: ${wsUrl.replace(/secret=[^&]+/, 'secret=***')}`)
      ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        try {
          connected = true
          reconnectAttempts = 0
          debug('WebSocket connected')

          // Send session metadata with capabilities + version
          const meta: SessionMeta = {
            type: 'meta',
            sessionId,
            wrapperId,
            cwd,
            startedAt: Date.now(),
            model,
            capabilities,
            args,
            version: `rclaude/${BUILD_VERSION.gitHashShort}`,
            buildTime: BUILD_VERSION.buildTime,
            claudeVersion,
            claudeAuth,
            spinnerVerbs,
            autocompactPct,
            maxBudgetUsd,
            adHocTaskId,
            adHocWorktree,
          }
          ws?.send(JSON.stringify(meta))

          // Flush queued messages
          while (messageQueue.length > 0) {
            const msg = messageQueue.shift()
            if (msg) {
              try {
                ws?.send(JSON.stringify(msg))
              } catch (err) {
                debug(`Failed to flush queued message: ${err instanceof Error ? err.message : err}`)
              }
            }
          }

          // Start heartbeat
          heartbeatInterval = setInterval(() => {
            if (connected) {
              try {
                const heartbeat: Heartbeat = {
                  type: 'heartbeat',
                  sessionId,
                  timestamp: Date.now(),
                }
                ws?.send(JSON.stringify(heartbeat))
              } catch (err) {
                debug(`Heartbeat send failed: ${err instanceof Error ? err.message : err}`)
              }
            }
          }, 30000) // 30 seconds

          onConnected?.()
        } catch (err) {
          debug(`onopen handler error: ${err instanceof Error ? err.message : err}`)
        }
      }

      ws.onclose = (event: CloseEvent) => {
        debug(`WebSocket closed: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`)
        connected = false
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval)
          heartbeatInterval = null
        }

        onDisconnected?.()

        // Attempt reconnect with exponential backoff, capped at 60s
        if (shouldReconnect && reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++
          const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempts, 6), 60_000)
          debug(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})`)
          setTimeout(connect, delay)
        } else if (shouldReconnect) {
          onError?.(new Error(`WebSocket reconnection gave up after ${maxReconnectAttempts} attempts`))
        }
      }

      ws.onerror = event => {
        const errorEvent = event as ErrorEvent
        const detail = errorEvent.message || errorEvent.error || 'unknown'
        debug(`WebSocket error: ${detail}`)
        const error = new Error(`WebSocket error: ${detail}`)
        onError?.(error)
      }

      ws.onmessage = event => {
        try {
          const message = JSON.parse(event.data as string) as ConcentratorMessage
          if (process.env.RCLAUDE_SHOW_WEBSOCKET_MESSAGES) {
            const m = message as unknown as Record<string, unknown>
            const summary = message.type === 'input' ? `input: "${m.input}"` : message.type
            debug(`WS <<< ${summary}`)
          }
          // Handle messages from concentrator
          switch (message.type) {
            case 'error':
              onError?.(new Error(message.message))
              break
            case 'input':
              // Forward input to PTY
              onInput?.(message.input, message.crDelay)
              break
            case 'terminal_attach':
              onTerminalAttach?.(message.cols, message.rows)
              break
            case 'terminal_detach':
              onTerminalDetach?.()
              break
            case 'terminal_data':
              // Raw terminal input from browser (keystrokes, no mangling)
              onTerminalInput?.(message.data)
              break
            case 'terminal_resize':
              onTerminalResize?.(message.cols, message.rows)
              break
            case 'transcript_request':
              onTranscriptRequest?.(message.limit)
              break
            case 'subagent_transcript_request':
              onSubagentTranscriptRequest?.(message.agentId, message.limit)
              break
            case 'file_request':
              onFileRequest?.(message.requestId, message.path)
              break
            case 'ack':
              onAck?.(message.origins || [])
              break
            case 'transcript_kick':
              onTranscriptKick?.()
              break
            case 'channel_sessions_list':
              onChannelSessionsList?.(message.sessions)
              break
            case 'channel_deliver':
              onChannelDeliver?.(message)
              break
            case 'channel_link_request':
              onChannelLinkRequest?.(message)
              break
            case 'permission_response':
              onPermissionResponse?.(message.requestId, message.behavior, message.toolUseId)
              break
            case 'ask_answer':
              onAskAnswer?.(message.toolUseId, message.answers, message.annotations, message.skip)
              break
            case 'dialog_result':
              onDialogResult?.(message.dialogId, message.result)
              break
            case 'plan_approval_response':
              onPlanApprovalResponse?.(message.requestId, message.action, message.feedback, message.toolUseId)
              break
            case 'interrupt':
              onInterrupt?.()
              break
            case 'terminate_session':
              onQuitSession?.()
              break
            default: {
              const msgType = (message as Record<string, unknown>).type as string
              // Deprecated alias for terminate_session
              if (msgType === 'quit_session') {
                onQuitSession?.()
                break
              }
              if (msgType === 'dialog_keepalive') {
                const m = message as Record<string, unknown>
                onDialogKeepalive?.(m.dialogId as string)
                break
              }
              // Inter-session send result (not in formal ConcentratorMessage type)
              if (msgType === 'channel_send_result') {
                onChannelSendResult?.(message)
                break
              }
              if (msgType === 'permission_rule') {
                const m = message as Record<string, unknown>
                onPermissionRule?.(m.toolName as string, m.behavior as 'allow' | 'deny')
                break
              }
              if (msgType === 'channel_revive_result') {
                onChannelReviveResult?.(message as unknown as { ok: boolean; error?: string; name?: string })
                break
              }
              if (msgType === 'channel_restart_result') {
                onChannelRestartResult?.(
                  message as unknown as {
                    ok: boolean
                    error?: string
                    name?: string
                    selfRestart?: boolean
                    alreadyEnded?: boolean
                  },
                )
                break
              }
              if (msgType === 'channel_spawn_result') {
                onChannelSpawnResult?.(message as unknown as { ok: boolean; error?: string; wrapperId?: string })
                break
              }
              if (msgType === 'spawn_diagnostics_result') {
                onSpawnDiagnosticsResult?.(
                  message as unknown as {
                    ok: boolean
                    jobId?: string
                    error?: string
                    diagnostics?: Record<string, unknown>
                  },
                )
                break
              }
              if (
                msgType === 'launch_progress' ||
                msgType === 'launch_log' ||
                msgType === 'job_complete' ||
                msgType === 'job_failed'
              ) {
                onLaunchJobEvent?.(message as unknown as Record<string, unknown>)
                break
              }
              if (msgType === 'channel_configure_result') {
                onChannelConfigureResult?.(message as unknown as { ok: boolean; error?: string })
                break
              }
              if (msgType === 'rename_session_result') {
                onChannelRenameResult?.(message as unknown as { ok: boolean; error?: string })
                break
              }
              if (
                msgType === 'spawn_ready' ||
                msgType === 'spawn_timeout' ||
                msgType === 'revive_ready' ||
                msgType === 'revive_timeout' ||
                msgType === 'restart_ready' ||
                msgType === 'restart_timeout'
              ) {
                onRendezvousResult?.(message as Record<string, unknown>)
                break
              }
              if (msgType?.startsWith('file_') || msgType?.startsWith('project_') || msgType === 'project_quick_add') {
                onFileEditorMessage?.(message as unknown as Record<string, unknown>)
              }
              break
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    } catch (error) {
      onError?.(error as Error)
      // Attempt reconnect on connection failure
      if (shouldReconnect && reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++
        const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempts, 6), 60_000)
        setTimeout(connect, delay)
      }
    }
  }

  function send(message: WrapperMessage) {
    try {
      if (connected && ws?.readyState === WebSocket.OPEN) {
        if (process.env.RCLAUDE_SHOW_WEBSOCKET_MESSAGES) {
          debug(`WS >>> ${message.type}`)
        }
        const json = JSON.stringify(message)
        // Log large messages for debugging disconnects
        if (json.length > 100_000) {
          onError?.(new Error(`Large WS message: type=${message.type} size=${(json.length / 1024).toFixed(0)}KB`))
        }
        ws.send(json)
      } else {
        // Queue for later, cap size to prevent unbounded growth
        if (messageQueue.length >= MAX_QUEUE_SIZE) {
          const dropped = messageQueue.shift()
          debug(`Queue full (${MAX_QUEUE_SIZE}), dropping oldest message: type=${dropped?.type}`)
        }
        messageQueue.push(message)
      }
    } catch (err) {
      debug(`WS send failed (type=${message.type}): ${err instanceof Error ? err.message : err}`)
    }
  }

  function sendHookEvent(event: HookEvent) {
    send(event)
  }

  function sendSessionEnd(reason: string) {
    const endMsg: SessionEnd = {
      type: 'end',
      sessionId,
      reason,
      endedAt: Date.now(),
    }
    send(endMsg)
  }

  function sendSessionClear(newSessionId: string, newCwd: string, newModel?: string) {
    // Skip same-ID rekey -- causes channel subscriber destruction on concentrator
    if (sessionId === newSessionId) {
      debug?.(`Skipping same-ID session_clear (${sessionId.slice(0, 8)})`)
      return
    }
    const msg: SessionClear = {
      type: 'session_clear',
      oldSessionId: sessionId,
      newSessionId,
      wrapperId,
      cwd: newCwd,
      model: newModel,
    }
    send(msg)
    // Update local session ID so subsequent messages use the new ID
    sessionId = newSessionId
  }

  function sendTerminalData(data: string) {
    const msg: TerminalData = {
      type: 'terminal_data',
      wrapperId,
      data,
    }
    send(msg)
  }

  function sendTranscriptEntries(entries: TranscriptEntry[], isInitial: boolean) {
    const msg: TranscriptEntries = {
      type: 'transcript_entries',
      sessionId,
      entries,
      isInitial,
    }
    send(msg)
  }

  function sendSubagentTranscript(agentId: string, entries: TranscriptEntry[], isInitial: boolean) {
    const msg: SubagentTranscript = {
      type: 'subagent_transcript',
      sessionId,
      agentId,
      entries,
      isInitial,
    }
    send(msg)
  }

  function sendFileResponse(requestId: string, data?: string, mediaType?: string, error?: string) {
    const msg: FileResponse = {
      type: 'file_response',
      requestId,
      data,
      mediaType,
      error,
    }
    send(msg)
  }

  function sendBgTaskOutput(taskId: string, data: string, done: boolean) {
    const msg: BgTaskOutput = {
      type: 'bg_task_output',
      sessionId,
      taskId,
      data,
      done,
    }
    send(msg)
  }

  function close() {
    shouldReconnect = false
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval)
      heartbeatInterval = null
    }
    if (ws) {
      ws.close()
      ws = null
    }
    connected = false
  }

  function isConnected() {
    return connected
  }

  // Start connection
  connect()

  return {
    send,
    sendHookEvent,
    sendSessionEnd,
    sendSessionClear,
    sendTerminalData,
    sendTranscriptEntries,
    sendSubagentTranscript,
    sendFileResponse,
    sendBgTaskOutput,
    sendStreamDelta(event: Record<string, unknown>) {
      send({ type: 'stream_delta', sessionId, event } as WrapperMessage)
    },
    sendRateLimit(retryAfterMs: number, message: string) {
      send({ type: 'rate_limit', sessionId, retryAfterMs, message } as WrapperMessage)
    },
    sendSessionStatus(status: 'active' | 'idle') {
      send({ type: 'session_status', sessionId, status } as WrapperMessage)
    },
    close,
    isConnected,
  }
}
