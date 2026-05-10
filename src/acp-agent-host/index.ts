#!/usr/bin/env bun
/**
 * acp-agent-host -- the generic ACP-speaking agent host.
 *
 * One binary that hosts any ACP-speaking child agent (OpenCode, Codex,
 * Gemini, Auggie, ...). Parameterized by a "recipe" the sentinel passes via
 * env vars (see `recipe.ts`). Knows nothing agent-specific.
 *
 * Lifecycle per conversation:
 *   1. Parse recipe + standard host config from env.
 *   2. Spawn the agent subprocess (`recipe.agentCmd`) with stdio piped.
 *   3. Connect to broker (host-transport handles WS reconnect/queue).
 *   4. Drive ACP `initialize` against the agent.
 *   5. session/new (or session/load on resume) with the broker MCP server.
 *   6. If `recipe.initialModel` is set, session/set_config_option to apply.
 *   7. Idle until broker sends `input` -> session/prompt -> stream
 *      session/update through the translator -> emit transcript entries.
 *   8. On agent->client requests (fs/*, terminal/*, session/request_permission)
 *      respond per the recipe / tier.
 *
 * Unlike the OpenCode-NDJSON host (one subprocess per turn), the ACP child
 * is long-lived: one ACP session lives the whole conversation. Resume is
 * native via session/load.
 */

import { checkBunVersion } from '../shared/bun-version'

checkBunVersion()

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHostTransport, type HostTransport } from '../shared/host-transport'
import { brokerMcpUrlFromWs } from '../shared/opencode-config'
import { cwdToProjectUri } from '../shared/project-uri'
import {
  AGENT_HOST_PROTOCOL_VERSION,
  type AgentHostBoot,
  type BrokerMessage,
  type ControlDeliver,
  DEFAULT_BROKER_URL,
  type TasksUpdate,
  type TranscriptEntry,
  type TranscriptUserEntry,
} from '../shared/protocol'
import { extractTodoTasksFromEntries } from '../shared/task-extract'
import { BUILD_VERSION } from '../shared/version'
import {
  type AcpPermissionOption,
  decidePermission,
  handleFsRead,
  handleFsWrite,
  pickOptionId,
  TERMINAL_NOT_IMPLEMENTED_ERROR,
} from './agent-callbacks'
import { JsonRpcClient } from './jsonrpc'
import { type ParsedHostConfig, parseHostConfig, RecipeParseError } from './recipe'
import {
  type AcpSessionUpdateParams,
  applyPromptUsage,
  applyUpdate,
  createTranslatorState,
  flushTurn,
  type TranslatorState,
} from './translator'

const log = (msg: string) => process.stderr.write(`[acp-host] ${msg}\n`)

interface InitializeResult {
  protocolVersion: number
  agentCapabilities?: { mcpCapabilities?: { http?: boolean; sse?: boolean } }
  agentInfo?: { name?: string; version?: string }
}
interface SessionNewResult {
  sessionId: string
  configOptions?: Array<{
    id: string
    type?: string
    currentValue?: unknown
    options?: Array<{ value: string; name?: string }>
  }>
}
interface SessionPromptResult {
  stopReason?: string
  usage?: {
    totalTokens?: number
    inputTokens?: number
    outputTokens?: number
    cachedReadTokens?: number
    cachedWriteTokens?: number
  }
}

function buildBoot(cfg: ParsedHostConfig): AgentHostBoot {
  // Project URI uses the agent name, not 'acp'. ACP is a transport detail;
  // the user-facing identity is "this is an OpenCode (or Codex, or Gemini)
  // conversation". Sidebar grouping, dashboard styling, and existing project
  // settings keyed on opencode:// continue to work unchanged.
  const uriScheme = cfg.recipe.agentName || 'acp'
  return {
    type: 'agent_host_boot',
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    conversationId: cfg.conversationId,
    project: cwdToProjectUri(cfg.cwd, uriScheme),
    capabilities: ['headless', 'channel', 'json_stream'],
    claudeArgs: [],
    version: `acp-host/${BUILD_VERSION.gitHashShort}`,
    buildTime: BUILD_VERSION.buildTime,
    agentHostType: 'acp',
    title: cfg.conversationTitle || undefined,
    description: cfg.conversationDescription || undefined,
    startedAt: Date.now(),
    configuredModel: cfg.recipe.initialModel ?? undefined,
  }
}

async function main() {
  let cfg: ParsedHostConfig
  try {
    cfg = parseHostConfig(process.env, DEFAULT_BROKER_URL)
  } catch (err) {
    if (err instanceof RecipeParseError) {
      log(`FATAL recipe: ${err.message}`)
      process.exit(2)
    }
    throw err
  }
  const debug = cfg.debug ? log : () => {}

  const initialPrompt = cfg.initialPromptFile ? safeRead(cfg.initialPromptFile) : null
  const brokerMcpUrl = brokerMcpUrlFromWs(cfg.brokerUrl)
  const mcpWired = !!(brokerMcpUrl && cfg.brokerSecret)

  // Per-conversation NDJSON traffic log -- mirrors the rclaude headless
  // ~/.rclaude/settings/headless-{conversationId}.ndjsonl convention so
  // ACP sessions can be inspected the same way Claude sessions are. One
  // line per JSON-RPC message, in either direction. Path:
  //   ~/.rclaude/settings/acp-{conversationId}.ndjsonl
  // Override with ACP_HOST_TRACE_FILE to a custom path; set =0 to disable.
  let traceFile: string | null = null
  if (process.env.ACP_HOST_TRACE_FILE !== '0') {
    traceFile =
      process.env.ACP_HOST_TRACE_FILE || join(homedir(), '.rclaude', 'settings', `acp-${cfg.conversationId}.ndjsonl`)
    try {
      mkdirSync(dirname(traceFile), { recursive: true })
      appendFileSync(
        traceFile,
        `${JSON.stringify({
          t: Date.now(),
          dir: 'note',
          msg: { type: 'host_start', conversationId: cfg.conversationId, agent: cfg.recipe.agentName },
        })}\n`,
      )
    } catch (e) {
      log(`could not open trace file ${traceFile}: ${(e as Error).message}`)
      traceFile = null
    }
  }
  // ─── NDJSON traffic log + JSON stream relay ──────────────────────────────
  // Write to disk (trace file), relay to dashboard viewers (JSON stream),
  // and buffer for backfill. All three share the same logic to avoid drift.
  const writeDisk = !!traceFile
  function traceWrite(dir: 'send' | 'recv' | 'note', msg: object) {
    if (writeDisk) {
      try {
        appendFileSync(traceFile!, `${JSON.stringify({ t: Date.now(), dir, msg })}\n`)
      } catch {
        // Drop silently on disk error.
      }
    }
    // Only relay/buffer agent traffic, not host-lifecycle notes/sterr.
    if (dir === 'note') return
    const line = JSON.stringify(msg)
    // Live relay to attached dashboard viewers.
    if (jsonStreamAttached && transport.isConnected()) {
      transport.send({
        type: 'json_stream_data',
        conversationId: cfg.conversationId,
        lines: [line],
        isBackfill: false,
      })
    }
    // Buffer for backfill on late attach. Skip streaming chunks
    // (they're already rendered via stream_delta) to keep buffer lean.
    try {
      const parsed = JSON.parse(line)
      if (parsed?.method === 'session/update') {
        const su = parsed.params?.update?.sessionUpdate as string | undefined
        if (su === 'agent_message_chunk' || su === 'agent_thought_chunk') return
      }
    } catch {
      /* keep unparseable lines */
    }
    jsonStreamBuffer.push(line)
    if (jsonStreamBuffer.length > 200) jsonStreamBuffer.splice(0, jsonStreamBuffer.length - 200)
  }

  log(
    `starting conv=${cfg.conversationId.slice(0, 8)} agent=${cfg.recipe.agentName} cmd=${cfg.recipe.agentCmd.join(' ')} cwd=${cfg.cwd} broker=${cfg.brokerUrl} tier=${cfg.recipe.toolPermission} mcp=${mcpWired ? 'on' : 'off'}${cfg.resumeSessionId ? ` resume=${cfg.resumeSessionId}` : ''}${traceFile ? ` trace=${traceFile}` : ''}`,
  )

  // ─── Spawn the agent subprocess ───────────────────────────────────────
  const [bin, ...args] = cfg.recipe.agentCmd
  const proc = Bun.spawn([bin, ...args], {
    cwd: cfg.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })

  // ─── JSON-RPC plumbing ────────────────────────────────────────────────
  const client = new JsonRpcClient({
    writer: { writeLine: line => proc.stdin.write(`${line}\n`) },
    onRequest: (req, respond, respondError) => {
      void handleAgentRequest(req, respond, respondError)
    },
    onNotify: notif => {
      if (notif.method === 'session/update') {
        void handleSessionUpdate(notif.params as AcpSessionUpdateParams)
      } else {
        debug(`ignoring notification: ${notif.method}`)
      }
    },
    onInvalid: (line, reason) => {
      debug(`invalid inbound: ${reason} (${line.slice(0, 200)})`)
      traceWrite('note', { invalid: true, reason, line: line.slice(0, 500) })
    },
    onTrace: (dir, msg) => traceWrite(dir, msg),
  })

  ;(async () => {
    const decoder = new TextDecoder()
    const reader = proc.stdout.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      client.feed(decoder.decode(value, { stream: true }))
    }
    client.rejectAllPending(new Error('agent stdout closed'))
    log(`agent stdout closed`)
  })().catch(e => log(`stdout pump error: ${(e as Error).message}`))

  ;(async () => {
    const decoder = new TextDecoder()
    const reader = proc.stderr.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const txt = decoder.decode(value, { stream: true })
      if (txt.trim()) {
        debug(`agent stderr: ${txt.trim().slice(0, 1000)}`)
        traceWrite('note', { stderr: txt.trim().slice(0, 4000) })
      }
    }
  })().catch(() => {})

  // ─── Translator state -- one per turn ────────────────────────────────
  let state: TranslatorState = createTranslatorState({ acpAgent: cfg.recipe.agentName })
  let acpSessionId: string | null = cfg.resumeSessionId ?? null
  let activeTurn: Promise<unknown> | null = null
  /** Cached set of model values the agent advertised in session/new's
   *  configOptions. Used to reject typos before they become silent-fail
   *  empty turns. Empty set means "no list available" -- skip validation. */
  let availableModels: Set<string> = new Set()

  // Build MCP server list (single 'claudwerk' entry pointing at our broker).
  const mcpServers: Array<{
    name: string
    type: 'http'
    url: string
    headers: Array<{ name: string; value: string }>
  }> = []
  if (mcpWired && brokerMcpUrl && cfg.brokerSecret) {
    mcpServers.push({
      name: cfg.recipe.mcpServerName,
      type: 'http',
      url: brokerMcpUrl,
      headers: [{ name: 'Authorization', value: `Bearer ${cfg.brokerSecret}` }],
    })
  }

  // ─── JSON stream relay state ──────────────────────────────────────────
  // When a dashboard viewer attaches to the JSON stream, we relay every
  // JSON-RPC line in both directions to the browser (like the Claude headless
  // host does). The buffer holds the last 200 non-noise lines for backfill
  // on late attach.
  let jsonStreamAttached = false
  const jsonStreamBuffer: string[] = []

  // ─── Broker transport ─────────────────────────────────────────────────
  let transport: HostTransport
  let terminating = false
  // Diff-dedup for tasks_update: agents replay the entire TodoWrite list on
  // every change, so without this we'd spam the broker with identical
  // messages every time the agent calls TodoWrite.
  let lastTasksJson: string | null = null

  function maybeEmitTasksUpdate(entries: TranscriptEntry[]) {
    const tasks = extractTodoTasksFromEntries(entries)
    if (!tasks) return
    const json = JSON.stringify(tasks)
    if (json === lastTasksJson) return
    lastTasksJson = json
    const msg: TasksUpdate = { type: 'tasks_update', conversationId: cfg.conversationId, tasks }
    transport.send(msg)
    debug(`tasks_update: ${tasks.length} tasks`)
  }
  const shutdown = (sig: string, code = 0) => {
    if (terminating) return
    terminating = true
    log(`shutdown: ${sig}`)
    try {
      transport.close()
    } catch {}
    try {
      proc.kill()
    } catch {}
    setTimeout(() => process.exit(code), 200)
  }
  function handleInbound(msg: BrokerMessage) {
    const t = (msg as { type?: string }).type
    if (t === 'terminate_conversation') {
      log('broker requested termination')
      shutdown('terminate_conversation')
      return
    }
    if (t === 'json_stream_attach') {
      jsonStreamAttached = true
      debug(`JSON stream attached, sending ${jsonStreamBuffer.length} backfill lines`)
      if (transport.isConnected() && jsonStreamBuffer.length > 0) {
        transport.send({
          type: 'json_stream_data',
          conversationId: cfg.conversationId,
          lines: jsonStreamBuffer.slice(-100),
          isBackfill: true,
        })
      }
      return
    }
    if (t === 'json_stream_detach') {
      jsonStreamAttached = false
      debug('JSON stream detached')
      return
    }
    if (t === 'interrupt' || (t === 'control' && (msg as { action?: string }).action === 'interrupt')) {
      log('interrupt requested')
      if (activeTurn) {
        client.notify('session/cancel')
      }
      return
    }
    if (t === 'control') {
      handleControl(msg as ControlDeliver)
      return
    }
    if (t !== 'input') return
    const input = (msg as { input?: unknown }).input
    if (typeof input !== 'string') return
    if (activeTurn) {
      log('input received while a turn is active -- queuing not yet supported, ignoring')
      return
    }
    activeTurn = handleTurn(input).finally(() => {
      activeTurn = null
    })
  }

  function handleControl(msg: ControlDeliver) {
    const { action, model, effort, permissionMode } = msg
    const source = msg.fromSession ? `inter-session:${msg.fromSession.slice(0, 8)}` : 'control-channel'
    switch (action) {
      case 'clear': {
        log(`clear requested (${source}) -- creating new session`)
        void handleClear()
        break
      }
      case 'quit': {
        log(`quit requested (${source})`)
        client.notify('session/cancel')
        shutdown('quit')
        break
      }
      case 'set_model': {
        if (!model) {
          log('set_model: no model value provided, ignoring')
          return
        }
        void handleSetConfig('model', model, source)
        break
      }
      case 'set_effort': {
        if (!effort) {
          log('set_effort: no effort value provided, ignoring')
          return
        }
        void handleSetConfig('effort', effort, source)
        break
      }
      case 'set_permission_mode': {
        if (!permissionMode) {
          log('set_permission_mode: no mode provided, ignoring')
          return
        }
        log(`set_permission_mode: "${permissionMode}" requested (${source}) -- not yet supported by ACP host`)
        break
      }
      default:
        debug(`control: unknown action "${action}"`)
    }
  }

  async function handleClear() {
    if (!acpSessionId) {
      log('clear: no active session, nothing to clear')
      return
    }
    // Cancel any in-flight turn before creating the new session.
    if (activeTurn) {
      client.notify('session/cancel')
    }
    try {
      const res = await client.call<SessionNewResult>('session/new', { cwd: cfg.cwd, mcpServers }, 30_000)
      const oldSessionId = acpSessionId
      acpSessionId = res.sessionId
      log(`clear: new session ${acpSessionId.slice(0, 8)} (was ${oldSessionId.slice(0, 8)})`)
      state = createTranslatorState({ acpAgent: cfg.recipe.agentName })
      transport.send({
        type: 'conversation_reset',
        conversationId: cfg.conversationId,
        project: cwdToProjectUri(cfg.cwd, cfg.recipe.agentName || 'acp'),
      })
      transport.setSessionId(acpSessionId, 'stream_json')
      availableModels = new Set()
      const modelOpt = res.configOptions?.find(o => o.id === 'model')
      if (modelOpt?.options?.length) {
        availableModels = new Set(modelOpt.options.map(o => o.value))
      }
      const currentModel = typeof modelOpt?.currentValue === 'string' ? modelOpt.currentValue : undefined
      if (currentModel) {
        transport.send({
          type: 'update_conversation_metadata',
          conversationId: cfg.conversationId,
          metadata: { acpCurrentModel: currentModel, acpAvailableModelCount: availableModels.size },
        })
      }
    } catch (e) {
      log(`clear: session/new failed: ${(e as Error).message}`)
      transport.sendTranscriptEntries(
        [
          {
            type: 'system',
            subtype: 'chat_api_error',
            level: 'error',
            content: `Failed to clear conversation: ${(e as Error).message}`,
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
          },
        ],
        false,
      )
    }
  }

  async function handleSetConfig(configId: string, value: string, source: string) {
    if (!acpSessionId) {
      log(`set_config: no active session, ignoring ${configId}=${value}`)
      return
    }
    if (configId === 'model' && availableModels.size > 0 && !availableModels.has(value)) {
      const sample = [...availableModels].slice(0, 6).join(', ')
      const msg = `Unknown model "${value}". Agent advertises ${availableModels.size} models (e.g. ${sample}). Check spelling or run \`opencode auth login\` for the relevant provider.`
      log(msg)
      transport.sendTranscriptEntries(
        [
          {
            type: 'system',
            subtype: 'chat_api_error',
            level: 'error',
            content: msg,
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
          },
        ],
        false,
      )
      return
    }
    log(`set_config: ${configId}=${value} (${source})`)
    try {
      const res = await client.call<{ configOptions?: Array<{ id?: string; currentValue?: unknown }> }>(
        'session/set_config_option',
        { sessionId: acpSessionId, configId, value },
        30_000,
      )
      const updated = res?.configOptions?.find(o => o?.id === configId)
      if (updated && typeof updated.currentValue === 'string' && updated.currentValue !== value) {
        throw new Error(
          `agent rejected ${configId} selection (requested "${value}", current "${updated.currentValue}")`,
        )
      }
      log(`set_config: ${configId}=${value} applied`)
      if (configId === 'model') {
        transport.send({
          type: 'update_conversation_metadata',
          conversationId: cfg.conversationId,
          metadata: { acpCurrentModel: value, acpAvailableModelCount: availableModels.size },
        })
      }
    } catch (e) {
      const msg = `Failed to set ${configId} "${value}": ${(e as Error).message}`
      log(msg)
      transport.sendTranscriptEntries(
        [
          {
            type: 'system',
            subtype: 'chat_api_error',
            level: 'error',
            content: msg,
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
          },
        ],
        false,
      )
    }
  }

  transport = createHostTransport({
    brokerUrl: cfg.brokerUrl,
    brokerSecret: cfg.brokerSecret,
    conversationId: cfg.conversationId,
    buildInitialMessage: () => buildBoot(cfg),
    onMessage: handleInbound,
    onConnected: () => log(`connected to broker conv=${cfg.conversationId.slice(0, 8)}`),
    onDisconnected: () => debug('broker disconnected'),
    onError: err => debug(`transport error: ${err.message}`),
    onDiag: (_kind, m, args) => debug(`diag: ${m} ${args ? JSON.stringify(args) : ''}`),
    trace: cfg.debug ? (dir, m) => debug(`${dir} ${(m as { type?: string }).type ?? '?'}`) : undefined,
  })

  // ─── Agent->client request handlers ──────────────────────────────────
  async function handleAgentRequest(
    req: { method: string; params?: unknown },
    respond: (result: unknown) => void,
    respondError: (code: number, message: string, data?: unknown) => void,
  ) {
    try {
      switch (req.method) {
        case 'fs/read_text_file': {
          const r = await handleFsRead(req.params as { path: string; line?: number; limit?: number })
          respond(r)
          return
        }
        case 'fs/write_text_file': {
          const r = await handleFsWrite(req.params as { path: string; content: string })
          respond(r)
          return
        }
        case 'session/request_permission': {
          const params = req.params as {
            toolCall: { toolCallId: string; kind?: string; title?: string }
            options: AcpPermissionOption[]
          }
          const decision = decidePermission(cfg.recipe.toolPermission, params.toolCall)
          if (decision.outcome.outcome === 'cancelled') {
            respond({ outcome: { outcome: 'cancelled' } })
            return
          }
          const action = decision.outcome.optionId === 'reject' ? 'reject' : 'allow'
          const optionId = pickOptionId(action, params.options)
          if (!optionId) {
            // Agent didn't offer the option we want; fall back to whatever
            // matches `cancelled` semantics so the agent moves on.
            log(`no matching option for action=${action}; cancelling`)
            respond({ outcome: { outcome: 'cancelled' } })
            return
          }
          debug(
            `permission decision: ${cfg.recipe.toolPermission}/${params.toolCall.kind ?? '?'} -> ${action} (${optionId})`,
          )
          respond({ outcome: { outcome: 'selected', optionId } })
          return
        }
        case 'terminal/create':
        case 'terminal/output':
        case 'terminal/wait_for_exit':
        case 'terminal/release':
        case 'terminal/kill':
          respondError(TERMINAL_NOT_IMPLEMENTED_ERROR.code, TERMINAL_NOT_IMPLEMENTED_ERROR.message)
          return
        default:
          respondError(-32601, `acp-host: method not implemented: ${req.method}`)
      }
    } catch (e) {
      respondError(-32603, `${req.method} handler failed: ${(e as Error).message}`)
    }
  }

  async function handleSessionUpdate(params: AcpSessionUpdateParams) {
    if (!params?.update) return
    const out = applyUpdate(params, state)
    // Stream deltas first so the dashboard's live buffer is updated before
    // the committed transcript entries land. (When an assistant entry
    // arrives, handleTranscriptEntries clears streamingText for that
    // conversation -- so emitting deltas after entries would be wasted.)
    for (const event of out.streamDeltas) {
      transport.send({ type: 'stream_delta', conversationId: cfg.conversationId, event })
    }
    if (out.entries.length > 0) {
      transport.sendTranscriptEntries(out.entries, false)
      maybeEmitTasksUpdate(out.entries)
    }
  }

  // ─── Bootstrap the ACP session ───────────────────────────────────────
  // Bootstrap is run exactly once -- both the startup path and the
  // first-input path may race to it; both share the same promise.
  let bootstrapPromise: Promise<void> | null = null
  function ensureBootstrapped(): Promise<void> {
    if (!bootstrapPromise) bootstrapPromise = bootstrap()
    return bootstrapPromise
  }
  async function bootstrap() {
    const initRes = await client.call<InitializeResult>(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
      },
      30_000,
    )
    log(
      `initialized agent=${initRes.agentInfo?.name ?? '?'}/${initRes.agentInfo?.version ?? '?'} acpVer=${initRes.protocolVersion}`,
    )

    if (acpSessionId) {
      try {
        await client.call('session/load', { sessionId: acpSessionId, cwd: cfg.cwd, mcpServers }, 30_000)
        log(`session loaded ${acpSessionId}`)
      } catch (e) {
        log(`session/load failed (${(e as Error).message}); falling back to session/new`)
        acpSessionId = null
      }
    }
    if (!acpSessionId) {
      const newRes = await client.call<SessionNewResult>('session/new', { cwd: cfg.cwd, mcpServers }, 30_000)
      acpSessionId = newRes.sessionId
      // Cache the available model values so we can validate user-requested
      // models locally before sending set_config_option. OpenCode silently
      // accepts bogus values otherwise, leading to empty-turn failures.
      const modelOpt = newRes.configOptions?.find(o => o.id === 'model')
      if (modelOpt?.options?.length) {
        availableModels = new Set(modelOpt.options.map(o => o.value))
      }
      // Capture the agent's current/default model so the dashboard can show
      // "Running on <X>" without having to round-trip through us. Stored on
      // agentHostMeta -- read on broker restart from SQLite.
      const currentModel = typeof modelOpt?.currentValue === 'string' ? modelOpt.currentValue : undefined
      if (currentModel) {
        transport.send({
          type: 'update_conversation_metadata',
          conversationId: cfg.conversationId,
          metadata: { acpCurrentModel: currentModel, acpAvailableModelCount: availableModels.size },
        })
      }
      log(`session created ${acpSessionId} model=${currentModel ?? '?'} (${availableModels.size} available)`)
      transport.setSessionId(acpSessionId, 'stream_json')
    } else {
      transport.setSessionId(acpSessionId, 'stream_json')
    }

    // Apply the initial model selection if the recipe asks for one.
    if (cfg.recipe.initialModel) {
      const requested = cfg.recipe.initialModel
      // Pre-flight: if the agent advertised an explicit model list and the
      // requested value isn't in it, reject locally with a helpful error
      // instead of letting OpenCode silently accept and fail mid-turn.
      if (availableModels.size > 0 && !availableModels.has(requested)) {
        const sample = [...availableModels].slice(0, 6).join(', ')
        const msg = `Unknown model "${requested}". Agent advertises ${availableModels.size} models (e.g. ${sample}, ...). Check spelling or run \`opencode auth login\` for the relevant provider.`
        log(msg)
        transport.sendTranscriptEntries(
          [
            {
              type: 'system',
              subtype: 'chat_api_error',
              level: 'error',
              content: msg,
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
            },
          ],
          false,
        )
        return // skip set_config_option; conversation continues with agent default
      }
      try {
        const setRes = await client.call<{ configOptions?: Array<{ id?: string; currentValue?: unknown }> }>(
          'session/set_config_option',
          { sessionId: acpSessionId, configId: 'model', value: requested },
          30_000,
        )
        // OpenCode (and likely other agents) return success even if the model
        // value is bogus -- the failure surfaces silently as an empty turn.
        // Inspect the returned configOptions to verify the model actually
        // applied. If the post-call currentValue doesn't match, treat as a
        // hard error so the user sees something useful.
        const updated = setRes?.configOptions?.find(o => o?.id === 'model')
        if (updated && typeof updated.currentValue === 'string' && updated.currentValue !== requested) {
          throw new Error(
            `agent ignored model selection (requested "${requested}", current "${updated.currentValue}") -- check spelling and provider availability`,
          )
        }
        log(`model set to ${requested}`)
      } catch (e) {
        const msg = `failed to set model "${requested}": ${(e as Error).message}`
        log(msg)
        transport.sendTranscriptEntries(
          [
            {
              type: 'system',
              subtype: 'chat_api_error',
              level: 'error',
              content: msg,
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
            },
          ],
          false,
        )
        // Don't throw -- let the conversation continue with the agent's
        // default model. The error is visible in the transcript so the user
        // can correct + restart.
      }
    }
  }

  // ─── Per-turn driver ─────────────────────────────────────────────────
  async function handleTurn(input: string) {
    // Reject empty / whitespace-only prompts at the host. OpenCode's
    // `session/prompt` hangs forever on empty input -- we'd rather emit a
    // clean error to the dashboard than block the conversation.
    if (input.trim().length === 0) {
      log('rejecting empty prompt')
      transport.sendTranscriptEntries(
        [
          {
            type: 'system',
            subtype: 'chat_api_error',
            level: 'error',
            content: 'Empty prompt rejected. Type a message and try again.',
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
          },
        ],
        false,
      )
      return
    }
    await ensureBootstrapped()
    // Echo the user message into the transcript so the dashboard sees it.
    const userEntry: TranscriptUserEntry = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: input },
    }
    transport.sendTranscriptEntries([userEntry], false)

    // Reset translator state for this turn.
    state = createTranslatorState()

    try {
      const res = await client.call<SessionPromptResult>(
        'session/prompt',
        {
          sessionId: acpSessionId,
          prompt: [{ type: 'text', text: input }],
        },
        30 * 60_000,
      ) // 30 minutes -- model may take a while on long turns
      if (res?.usage) applyPromptUsage(res.usage, state)
      if (res?.stopReason) state.stopReason = res.stopReason
    } catch (err) {
      log(`turn failed: ${(err as Error).message}`)
      transport.sendTranscriptEntries(
        [
          {
            type: 'system',
            subtype: 'chat_api_error',
            level: 'error',
            content: `acp-host turn failed: ${(err as Error).message}`,
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
          },
        ],
        false,
      )
    }

    // Always flush -- closes any in-flight text run, commits orphan tools,
    // emits the turn_duration system entry, and broadcasts a closing
    // `message_stop` so the dashboard's streaming buffer clears.
    const finalOut = flushTurn(state)
    for (const event of finalOut.streamDeltas) {
      transport.send({ type: 'stream_delta', conversationId: cfg.conversationId, event })
    }
    if (finalOut.entries.length > 0) {
      transport.sendTranscriptEntries(finalOut.entries, false)
      maybeEmitTasksUpdate(finalOut.entries)
    }
  }

  // ─── Wire it up ──────────────────────────────────────────────────────
  try {
    await ensureBootstrapped()
  } catch (err) {
    // Common case: terminate_conversation arrived during bootstrap, the
    // child got SIGTERM, JsonRpcClient rejected the in-flight call. The
    // shutdown path is already underway -- don't log FATAL.
    if (terminating) {
      debug(`bootstrap aborted by terminate (${(err as Error).message})`)
      return
    }
    log(`FATAL bootstrap: ${(err as Error).stack ?? err}`)
    transport.close()
    try {
      proc.kill()
    } catch {}
    process.exit(1)
  }

  if (initialPrompt) {
    debug('dispatching initial prompt')
    activeTurn = handleTurn(initialPrompt).finally(() => {
      activeTurn = null
    })
  }
  // Watch for agent process exit -- if the child dies, we have nothing left
  // to do. Surface the error to the broker and shut down.
  ;(async () => {
    const code = await proc.exited
    log(`agent process exited code=${code}`)
    transport.sendTranscriptEntries(
      [
        {
          type: 'system',
          subtype: 'chat_api_error',
          level: 'error',
          content: `ACP agent (${cfg.recipe.agentName}) exited unexpectedly with code ${code}`,
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
        },
      ],
      false,
    )
    setTimeout(() => process.exit(code ?? 1), 500)
  })()

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

main().catch(err => {
  process.stderr.write(`[acp-host] FATAL: ${(err as Error).stack ?? err}\n`)
  process.exit(1)
})
