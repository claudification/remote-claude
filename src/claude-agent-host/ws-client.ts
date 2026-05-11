/**
 * WebSocket Client
 * Connects to broker with automatic reconnection and offline queuing
 */

import type { DialogResult } from '../shared/dialog-schema'
import { createHostTransport, type HostTransport } from '../shared/host-transport'
import { cwdToProjectUri } from '../shared/project-uri'
import type {
  AgentHostBoot,
  AgentHostCapability,
  AgentHostMessage,
  BgTaskOutput,
  BootEvent,
  BootStep,
  BrokerMessage,
  ConversationEnd,
  ConversationMeta,
  ConversationReset,
  FileResponse,
  HookEvent,
  InterConversationListResponse,
  InterSessionDelivery,
  LaunchConfig,
  ProjectLinkRequest,
  RclaudePermissionConfig,
  SubagentTranscript,
  TerminalData,
  TranscriptEntry,
} from '../shared/protocol'
import { AGENT_HOST_PROTOCOL_VERSION, DEFAULT_BROKER_URL } from '../shared/protocol'
import { BUILD_VERSION } from '../shared/version'
import { debug as _debug } from './debug'

const debug = (msg: string) => _debug(`[ws] ${msg}`)

export interface WsClientOptions {
  brokerUrl?: string
  brokerSecret?: string
  /** null means we don't have a CC session id yet -- the client will send
   *  `wrapper_boot` on connect instead of `meta` and must have `initialBoot`
   *  populated. Once the session id arrives, call `setSessionId()`. */
  ccSessionId: string | null
  conversationId: string
  cwd: string
  model?: string
  configuredModel?: string
  args?: string[]
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
  spinnerVerbs?: string[]
  autocompactPct?: number
  maxBudgetUsd?: number
  adHocTaskId?: string
  adHocWorktree?: string
  /** Passed through to `wrapper_boot` when connecting before session id. */
  initialBoot?: {
    claudeArgs: string[]
    title?: string
    description?: string
    launchConfig?: LaunchConfig
  }
  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (error: Error) => void
  capabilities?: AgentHostCapability[]
  onInput?: (input: string, crDelay?: number) => void
  onTerminalAttach?: (cols: number, rows: number) => void
  onTerminalDetach?: () => void
  onTerminalInput?: (data: string) => void
  onTerminalResize?: (cols: number, rows: number) => void
  onJsonStreamAttach?: () => void
  onJsonStreamDetach?: () => void
  onTranscriptRequest?: (limit?: number) => void
  onSubagentTranscriptRequest?: (agentId: string, limit?: number) => void
  onFileRequest?: (requestId: string, path: string) => void
  onFileEditorMessage?: (message: Record<string, unknown>) => void
  onAck?: (origins: string[]) => void
  onTranscriptKick?: () => void
  onChannelConversationsList?: (
    conversations: InterConversationListResponse['conversations'],
    self?: InterConversationListResponse['self'],
  ) => void
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
  onChannelSpawnResult?: (result: { ok: boolean; error?: string; conversationId?: string; requestId?: string }) => void
  onSpawnDiagnosticsResult?: (result: {
    ok: boolean
    jobId?: string
    error?: string
    diagnostics?: Record<string, unknown>
  }) => void
  /**
   * Launch job events for jobs this agent host subscribed to. Fires on
   * launch_progress / launch_log / job_complete / job_failed -- the shape
   * matches what the broker forwards verbatim via forwardJobEvent.
   */
  onLaunchJobEvent?: (event: Record<string, unknown>) => void
  onChannelConfigureResult?: (result: { ok: boolean; error?: string }) => void
  onChannelRenameResult?: (result: { ok: boolean; error?: string }) => void
  onConversationControlResult?: (result: { ok: boolean; error?: string; name?: string; action?: string }) => void
  onAskAnswer?: (
    toolUseId: string,
    answers?: Record<string, string>,
    annotations?: Record<string, { preview?: string; notes?: string }>,
    skip?: boolean,
  ) => void
  onDialogResult?: (dialogId: string, result: DialogResult) => void
  onDialogKeepalive?: (dialogId: string) => void
  onPlanApprovalResponse?: (
    requestId: string,
    action: 'approve' | 'reject' | 'feedback',
    feedback?: string,
    toolUseId?: string,
  ) => void
  onQuitConversation?: (source: string, initiator?: string) => void
  onInterrupt?: () => void
  onConfigUpdated?: () => void
  onConfigGet?: (requestId: string) => void
  onConfigSet?: (requestId: string, config: RclaudePermissionConfig) => void
  /** Catch-all for broker -> agent-host RPC responses keyed by requestId.
   *  Fires for recap_search_result, recap_mcp_get_result, recap_mcp_list_result,
   *  and any future *_result message that carries a requestId we registered via
   *  the broker-rpc helper (src/claude-agent-host/mcp-tools/lib/broker-rpc.ts). */
  onBrokerRpcResponse?: (msg: Record<string, unknown>) => void
  /**
   * Control verb delivered by broker (dashboard self-control or inter-session MCP).
   * Backend-specific dispatch lives in the agent host -- this callback is just the entry point.
   */
  onControl?: (
    action: 'clear' | 'quit' | 'interrupt' | 'set_model' | 'set_effort' | 'set_permission_mode',
    args: { model?: string; effort?: string; permissionMode?: string; fromSession?: string },
  ) => void
  /** Optional sink for structured diagnostics from inside the ws client.
   *  Wired to ctx.diag by index.ts so the dashboard's diag endpoint can
   *  surface warnings (e.g. suppressed same-id conversation_clear). */
  onDiag?: (type: string, msg: string, args?: unknown) => void
}

export interface WsClient {
  send: (message: AgentHostMessage) => void
  sendHookEvent: (event: HookEvent) => void
  sendConversationEnd: (
    reason: string,
    extras?: {
      source?: import('../shared/protocol').TerminationSource
      detail?: import('../shared/protocol').TerminationDetail
    },
  ) => void
  sendConversationReset: (project: string, model?: string) => void
  sendMetadataUpdate: (metadata: Record<string, unknown>) => void
  sendTerminalData: (data: string) => void
  sendTranscriptEntries: (entries: TranscriptEntry[], isInitial: boolean) => void
  sendSubagentTranscript: (agentId: string, entries: TranscriptEntry[], isInitial: boolean) => void
  sendFileResponse: (requestId: string, data?: string, mediaType?: string, error?: string) => void
  sendBgTaskOutput: (taskId: string, data: string, done: boolean) => void
  sendJsonStreamData: (lines: string[], isBackfill: boolean) => void
  sendStreamDelta: (event: Record<string, unknown>) => void
  sendRateLimitStatus: (info: {
    status: 'limited' | 'allowed'
    retryAfterMs?: number
    rateLimitType?: string
    resetsAt?: number
    raw: Record<string, unknown>
  }) => void
  sendConversationStatus: (status: 'active' | 'idle') => void
  /** Emit a structured boot-phase event. Queued if not yet connected. */
  sendBootEvent: (step: BootStep, detail?: string, raw?: unknown) => void
  /** Called once the real CC session id is known. Sends `meta` (so the
   *  broker can resume/create the real session) and `conversation_promote`
   *  so the booting entry gets merged into the real session. */
  setSessionId: (ccSessionId: string, source: 'stream_json' | 'hook') => void
  close: () => void
  isConnected: () => boolean
}

/**
 * Create WebSocket client with offline queuing
 */
export function createWsClient(options: WsClientOptions): WsClient {
  const {
    brokerUrl = DEFAULT_BROKER_URL,
    brokerSecret,
    ccSessionId: initialCcSessionId,
    conversationId,
    cwd,
    model,
    configuredModel,
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
    onJsonStreamAttach,
    onJsonStreamDetach,
    onTranscriptRequest,
    onSubagentTranscriptRequest,
    onFileRequest,
    onFileEditorMessage,
    onAck,
    onTranscriptKick,
    onChannelConversationsList,
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
    onConversationControlResult,
    onAskAnswer,
    onDialogResult,
    onDialogKeepalive,
    onPlanApprovalResponse,
    onQuitConversation,
    onInterrupt,
    onConfigUpdated,
    onConfigGet,
    onConfigSet,
    onControl,
    onDiag,
    onBrokerRpcResponse,
  } = options

  const project = cwdToProjectUri(cwd)

  // Per-host state. The transport (created below) owns connection plumbing,
  // queue, heartbeat, ring buffer, reconnect, and protocol_upgrade handling --
  // see src/shared/host-transport. We keep ccSessionId here because the
  // initial-message decision (meta vs boot) is claude-specific.
  let ccSessionId: string | null = initialCcSessionId

  /** Stable conversation identity for all outbound messages. Always returns
   *  the agent host's conversationId (the broker's primary key). ccSessionId
   *  is metadata only and never used as a routing key. */
  function routeId(): string {
    return conversationId
  }

  /** Build the first wire message sent on every (re)connect. Mirrors the
   *  pre-extraction behaviour: send `meta` if we already know the CC session
   *  id (resume path), else `agent_host_boot` (early-connect path). */
  function buildInitialMessage(): AgentHostMessage {
    if (ccSessionId) {
      const meta: ConversationMeta = {
        type: 'meta',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        ccSessionId,
        conversationId,
        project,
        startedAt: Date.now(),
        model,
        configuredModel,
        capabilities,
        args,
        version: `rclaude/${BUILD_VERSION.gitHashShort}`,
        buildTime: BUILD_VERSION.buildTime,
        agentHostType: 'claude',
        claudeVersion,
        claudeAuth,
        spinnerVerbs,
        autocompactPct,
        maxBudgetUsd,
        adHocTaskId,
        adHocWorktree,
      }
      return meta
    }
    const boot: AgentHostBoot = {
      type: 'agent_host_boot',
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      conversationId,
      project,
      capabilities: capabilities || [],
      claudeArgs: options.initialBoot?.claudeArgs || args || [],
      version: `rclaude/${BUILD_VERSION.gitHashShort}`,
      buildTime: BUILD_VERSION.buildTime,
      agentHostType: 'claude',
      claudeVersion,
      claudeAuth,
      launchConfig: options.initialBoot?.launchConfig,
      title: options.initialBoot?.title,
      description: options.initialBoot?.description,
      startedAt: Date.now(),
      configuredModel,
    }
    return boot
  }

  /**
   * Route a single inbound broker message to the right callback. Pulled out
   * of the original `ws.onmessage` handler when the transport plumbing was
   * extracted to src/shared/host-transport. Behaviour is byte-identical --
   * the transport handles `protocol_upgrade_required` itself (same banner +
   * exit(2)) so this function never sees that case.
   */
  function routeBrokerMessage(message: BrokerMessage): void {
    if (process.env.RCLAUDE_SHOW_WEBSOCKET_MESSAGES) {
      const m = message as unknown as Record<string, unknown>
      const summary = message.type === 'input' ? `input: "${m.input}"` : message.type
      debug(`WS <<< ${summary}`)
    }
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
      case 'json_stream_attach':
        onJsonStreamAttach?.()
        break
      case 'json_stream_detach':
        onJsonStreamDetach?.()
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
      case 'notify_config_updated':
        onConfigUpdated?.()
        break
      case 'rclaude_config_get':
        onConfigGet?.(message.requestId)
        break
      case 'rclaude_config_set':
        onConfigSet?.(message.requestId, message.config)
        break
      case 'channel_conversations_list':
        onChannelConversationsList?.(message.conversations, message.self)
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
      case 'terminate_conversation': {
        const source = typeof message.source === 'string' ? message.source : 'dashboard-other'
        const initiator = typeof message.initiator === 'string' ? message.initiator : undefined
        onQuitConversation?.(source, initiator)
        break
      }
      case 'control': {
        const action = message.action
        if (
          action === 'clear' ||
          action === 'quit' ||
          action === 'interrupt' ||
          action === 'set_model' ||
          action === 'set_effort' ||
          action === 'set_permission_mode'
        ) {
          onControl?.(action, {
            model: typeof message.model === 'string' ? message.model : undefined,
            effort: typeof message.effort === 'string' ? message.effort : undefined,
            permissionMode: typeof message.permissionMode === 'string' ? message.permissionMode : undefined,
            fromSession: typeof message.fromSession === 'string' ? message.fromSession : undefined,
          })
        } else {
          debug(`control: unknown action "${String(action)}"`)
        }
        break
      }
      default: {
        const msgType = (message as unknown as Record<string, unknown>).type as string
        if (msgType === 'dialog_keepalive') {
          const m = message as unknown as Record<string, unknown>
          onDialogKeepalive?.(m.dialogId as string)
          break
        }
        // Inter-session send result (not in formal BrokerMessage type)
        if (msgType === 'channel_send_result') {
          onChannelSendResult?.(message)
          break
        }
        if (msgType === 'permission_rule') {
          const m = message as unknown as Record<string, unknown>
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
          onChannelSpawnResult?.(
            message as unknown as { ok: boolean; error?: string; conversationId?: string; requestId?: string },
          )
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
        if (msgType === 'conversation_control_result') {
          onConversationControlResult?.(
            message as unknown as { ok: boolean; error?: string; name?: string; action?: string },
          )
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
          onRendezvousResult?.(message as unknown as Record<string, unknown>)
          break
        }
        if (
          msgType === 'recap_search_result' ||
          msgType === 'recap_mcp_get_result' ||
          msgType === 'recap_mcp_list_result'
        ) {
          onBrokerRpcResponse?.(message as unknown as Record<string, unknown>)
          break
        }
        if (msgType === 'recap_created' || msgType === 'recap_error') {
          // Only forward recap_created/error to broker-rpc when it carries a
          // requestId we minted. Plain recap_create from the dashboard does
          // not carry one and the response goes only to that single client
          // via ctx.reply(), so this branch is harmless for non-MCP callers.
          const m = message as unknown as Record<string, unknown>
          if (typeof m.requestId === 'string') {
            onBrokerRpcResponse?.(m)
          }
          break
        }
        if (msgType?.startsWith('file_') || msgType?.startsWith('project_') || msgType === 'project_quick_add') {
          onFileEditorMessage?.(message as unknown as Record<string, unknown>)
        }
        break
      }
    }
  }

  // Transport owns: WS lifecycle, queue, heartbeat, ring buffer, reconnect,
  // protocol_upgrade_required handling, conversation_promote dispatch.
  // See src/shared/host-transport for the contract.
  const transport: HostTransport = createHostTransport({
    brokerUrl,
    brokerSecret,
    conversationId,
    buildInitialMessage,
    onMessage: routeBrokerMessage,
    onConnected,
    onDisconnected,
    onError,
    onDiag: (_kind, msg, args) => {
      onDiag?.('transport', msg, args)
      debug(`[ws] ${msg}${args ? ` ${JSON.stringify(args)}` : ''}`)
    },
    trace: process.env.RCLAUDE_SHOW_WEBSOCKET_MESSAGES
      ? (dir, m) => {
          const summary =
            (m as { type?: string }).type === 'input'
              ? `input: "${(m as { input?: string }).input ?? ''}"`
              : (m as { type?: string }).type
          debug(`WS ${dir === 'in' ? '<<<' : '>>>'} ${summary ?? '?'}`)
        }
      : undefined,
  })

  function send(message: AgentHostMessage) {
    // Surface oversized payloads -- 100KB+ correlates with WS disconnects on
    // some routers. Transport handles the actual delivery + queueing.
    const json = JSON.stringify(message)
    if (json.length > 100_000) {
      onError?.(new Error(`Large WS message: type=${message.type} size=${(json.length / 1024).toFixed(0)}KB`))
    }
    transport.send(message)
  }

  function sendHookEvent(event: HookEvent) {
    send(event)
  }

  function sendConversationEnd(
    reason: string,
    extras?: {
      source?: import('../shared/protocol').TerminationSource
      detail?: import('../shared/protocol').TerminationDetail
    },
  ) {
    const endMsg: ConversationEnd = {
      type: 'end',
      conversationId,
      ccSessionId: ccSessionId || undefined,
      reason,
      source: extras?.source,
      detail: extras?.detail,
      endedAt: Date.now(),
    }
    send(endMsg)
  }

  function sendConversationReset(newProject: string, newModel?: string) {
    const msg: ConversationReset = {
      type: 'conversation_reset',
      conversationId,
      project: newProject,
      model: newModel,
    }
    send(msg)
  }

  function sendMetadataUpdate(metadata: Record<string, unknown>) {
    send({ type: 'update_conversation_metadata', conversationId, metadata } as AgentHostMessage)
  }

  function sendTerminalData(data: string) {
    const msg: TerminalData = {
      type: 'terminal_data',
      conversationId,
      data,
    }
    send(msg)
  }

  function sendTranscriptEntries(entries: TranscriptEntry[], isInitial: boolean) {
    // Transport handles the ring buffer + replay-on-reconnect.
    transport.sendTranscriptEntries(entries, isInitial)
  }

  function sendSubagentTranscript(agentId: string, entries: TranscriptEntry[], isInitial: boolean) {
    const msg: SubagentTranscript = {
      type: 'subagent_transcript',
      conversationId: routeId(),
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
      conversationId: routeId(),
      taskId,
      data,
      done,
    }
    send(msg)
  }

  function sendBootEvent(step: BootStep, detail?: string, raw?: unknown) {
    const msg: BootEvent = {
      type: 'boot_event',
      conversationId,
      step,
      detail,
      raw,
      t: Date.now(),
    }
    send(msg)
  }

  function setSessionId(newSessionId: string, source: 'stream_json' | 'hook') {
    const wasBoot = !ccSessionId
    ccSessionId = newSessionId
    if (!wasBoot) return // already had a session id, nothing to promote
    // Transport handles conversation_promote (idempotent). We follow up with
    // a fresh `meta` so the broker resumes/creates the real session with
    // full metadata (the boot payload only had a subset of fields).
    transport.setSessionId(newSessionId, source)
    const meta: ConversationMeta = {
      type: 'meta',
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      ccSessionId: newSessionId,
      conversationId,
      project,
      startedAt: Date.now(),
      model,
      capabilities,
      args,
      version: `rclaude/${BUILD_VERSION.gitHashShort}`,
      buildTime: BUILD_VERSION.buildTime,
      agentHostType: 'claude',
      claudeVersion,
      claudeAuth,
      spinnerVerbs,
      autocompactPct,
      maxBudgetUsd,
      adHocTaskId,
      adHocWorktree,
    }
    send(meta)
  }

  function close() {
    transport.close()
  }

  function isConnected() {
    return transport.isConnected()
  }

  return {
    send,
    sendHookEvent,
    sendConversationEnd,
    sendConversationReset,
    sendMetadataUpdate,
    sendTerminalData,
    sendTranscriptEntries,
    sendSubagentTranscript,
    sendFileResponse,
    sendBgTaskOutput,
    sendJsonStreamData(lines: string[], isBackfill: boolean) {
      send({ type: 'json_stream_data', conversationId, lines, isBackfill } as AgentHostMessage)
    },
    sendStreamDelta(event: Record<string, unknown>) {
      send({ type: 'stream_delta', conversationId: routeId(), event } as AgentHostMessage)
    },
    sendRateLimitStatus(info: {
      status: 'limited' | 'allowed'
      retryAfterMs?: number
      rateLimitType?: string
      resetsAt?: number
      raw: Record<string, unknown>
    }) {
      send({
        type: 'rate_limit_status',
        conversationId: routeId(),
        status: info.status,
        retryAfterMs: info.retryAfterMs,
        rateLimitType: info.rateLimitType,
        resetsAt: info.resetsAt,
        raw: info.raw,
      } as AgentHostMessage)
    },
    sendConversationStatus(status: 'active' | 'idle') {
      send({ type: 'conversation_status', conversationId: routeId(), status } as AgentHostMessage)
    },
    sendBootEvent,
    setSessionId,
    close,
    isConnected,
  }
}
