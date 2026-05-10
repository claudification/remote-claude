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
  DEFAULT_BROKER_URL,
  type TranscriptUserEntry,
} from '../shared/protocol'
import { BUILD_VERSION } from '../shared/version'
import { decidePermission, handleFsRead, handleFsWrite, pickOptionId, TERMINAL_NOT_IMPLEMENTED_ERROR, type AcpPermissionOption } from './agent-callbacks'
import { JsonRpcClient } from './jsonrpc'
import { parseHostConfig, RecipeParseError, type ParsedHostConfig } from './recipe'
import { applyPromptUsage, applyUpdate, createTranslatorState, flushTurn, type AcpSessionUpdateParams, type TranslatorState } from './translator'

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
    capabilities: ['headless', 'channel'],
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
    traceFile = process.env.ACP_HOST_TRACE_FILE || join(homedir(), '.rclaude', 'settings', `acp-${cfg.conversationId}.ndjsonl`)
    try {
      mkdirSync(dirname(traceFile), { recursive: true })
      appendFileSync(traceFile, JSON.stringify({ t: Date.now(), dir: 'note', msg: { type: 'host_start', conversationId: cfg.conversationId, agent: cfg.recipe.agentName } }) + '\n')
    } catch (e) {
      log(`could not open trace file ${traceFile}: ${(e as Error).message}`)
      traceFile = null
    }
  }
  const traceWrite = traceFile
    ? (dir: 'send' | 'recv' | 'note', msg: object) => {
        try {
          appendFileSync(traceFile!, JSON.stringify({ t: Date.now(), dir, msg }) + '\n')
        } catch {
          // Drop trace lines silently if disk fills -- we'd rather lose log
          // entries than crash the host on a write error.
        }
      }
    : () => {}

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
    writer: { writeLine: line => proc.stdin.write(line + '\n') },
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
  let state: TranslatorState = createTranslatorState()
  let acpSessionId: string | null = cfg.resumeSessionId ?? null
  let activeTurn: Promise<unknown> | null = null
  /** Cached set of model values the agent advertised in session/new's
   *  configOptions. Used to reject typos before they become silent-fail
   *  empty turns. Empty set means "no list available" -- skip validation. */
  let availableModels: Set<string> = new Set()

  // ─── Broker transport ─────────────────────────────────────────────────
  let transport: HostTransport
  let terminating = false
  const shutdown = (sig: string, code = 0) => {
    if (terminating) return
    terminating = true
    log(`shutdown: ${sig}`)
    try { transport.close() } catch {}
    try { proc.kill() } catch {}
    setTimeout(() => process.exit(code), 200)
  }
  function handleInbound(msg: BrokerMessage) {
    const t = (msg as { type?: string }).type
    if (t === 'terminate_conversation') {
      log('broker requested termination')
      shutdown('terminate_conversation')
      return
    }
    if (t !== 'input') return
    const input = (msg as { input?: unknown }).input
    if (typeof input !== 'string') return
    if (activeTurn) {
      log('input received while a turn is active -- queuing not yet supported, ignoring')
      return
    }
    activeTurn = handleTurn(input).finally(() => { activeTurn = null })
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
          const params = req.params as { toolCall: { toolCallId: string; kind?: string; title?: string }; options: AcpPermissionOption[] }
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
          debug(`permission decision: ${cfg.recipe.toolPermission}/${params.toolCall.kind ?? '?'} -> ${action} (${optionId})`)
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
    if (!params || !params.update) return
    const out = applyUpdate(params, state)
    if (out.entries.length > 0) {
      transport.sendTranscriptEntries(out.entries, false)
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
    const initRes = await client.call<InitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    }, 30_000)
    log(`initialized agent=${initRes.agentInfo?.name ?? '?'}/${initRes.agentInfo?.version ?? '?'} acpVer=${initRes.protocolVersion}`)

    // Build mcpServers list (single 'claudwerk' entry pointing at our broker).
    const mcpServers: Array<{ name: string; type: 'http'; url: string; headers: Array<{ name: string; value: string }> }> = []
    if (mcpWired && brokerMcpUrl && cfg.brokerSecret) {
      mcpServers.push({
        name: cfg.recipe.mcpServerName,
        type: 'http',
        url: brokerMcpUrl,
        headers: [{ name: 'Authorization', value: `Bearer ${cfg.brokerSecret}` }],
      })
    }

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
        return  // skip set_config_option; conversation continues with agent default
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
      const res = await client.call<SessionPromptResult>('session/prompt', {
        sessionId: acpSessionId,
        prompt: [{ type: 'text', text: input }],
      }, 30 * 60_000) // 30 minutes -- model may take a while on long turns
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

    // Always flush -- emits the assistant entry (if any blocks) + turn_duration system entry.
    transport.sendTranscriptEntries(flushTurn(state), false)
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
    try { proc.kill() } catch {}
    process.exit(1)
  }

  if (initialPrompt) {
    debug('dispatching initial prompt')
    activeTurn = handleTurn(initialPrompt).finally(() => { activeTurn = null })
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
  try { return readFileSync(path, 'utf8') } catch { return null }
}

main().catch(err => {
  process.stderr.write(`[acp-host] FATAL: ${(err as Error).stack ?? err}\n`)
  process.exit(1)
})
