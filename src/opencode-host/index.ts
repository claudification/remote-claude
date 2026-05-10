#!/usr/bin/env bun
/**
 * opencode-host -- agent host that wraps the OpenCode CLI.
 *
 * Spawned by the sentinel when a user spawns a conversation with
 * `backend: 'opencode'`. Connects back to the broker via WebSocket using the
 * exact same wire protocol as the Claude agent host (rclaude); the broker
 * cannot tell the two apart.
 *
 * Lifecycle per conversation:
 *   1. Connect to broker, send agent_host_boot (agentHostType: 'opencode').
 *   2. Idle until the broker sends `input` (user message).
 *   3. Spawn `opencode run --format json --model X --dir CWD ...` as a
 *      subprocess. Pipe its stdout through ndjson-parser, emit transcript
 *      entries to the broker as we go.
 *   4. When the subprocess exits, return to idle. Capture the OpenCode
 *      session id (`ses_xxx`) so the next turn can resume with `--session`.
 *
 * One subprocess per turn -- OpenCode's `run` command is single-shot. For
 * multi-turn we resume; later we can swap to `opencode serve` + `--attach`
 * for lower per-turn latency (see plan-opencode-backend.md).
 *
 * Env vars (set by the sentinel):
 *   RCLAUDE_BROKER             ws://broker (default: ws://localhost:9999)
 *   RCLAUDE_SECRET             broker auth token
 *   RCLAUDE_CONVERSATION_ID    conversation UUID (broker primary key)
 *   OPENCODE_MODEL             model in OpenCode's provider/model format
 *   OPENROUTER_API_KEY etc.    forwarded to the opencode subprocess
 */

import { checkBunVersion } from '../shared/bun-version'

checkBunVersion()

import { randomUUID } from 'node:crypto'
import { cwdToProjectUri } from '../shared/project-uri'
import {
  AGENT_HOST_PROTOCOL_VERSION,
  type AgentHostBoot,
  type AgentHostMessage,
  type ConversationPromote,
  DEFAULT_BROKER_URL,
  type Heartbeat,
  type TranscriptEntries,
  type TranscriptEntry,
  type TranscriptUserEntry,
} from '../shared/protocol'
import { BUILD_VERSION } from '../shared/version'
import {
  createParserState,
  flushTurn,
  type OpenCodeEvent,
  type ParserState,
  parseNdjsonChunk,
  translateEvent,
} from './ndjson-parser'

const log = (msg: string) => process.stderr.write(`[opencode-host] ${msg}\n`)
const debugEnabled = !!process.env.OPENCODE_HOST_DEBUG
const debug = debugEnabled ? log : () => {}

interface CliConfig {
  brokerUrl: string
  brokerSecret: string | undefined
  conversationId: string
  cwd: string
  model: string
  initialPrompt: string | null
  title: string | null
  description: string | null
  /** Path to the `opencode` binary; defaults to looking up via PATH. */
  opencodeBin: string
}

function parseConfig(): CliConfig {
  const brokerUrl = process.env.RCLAUDE_BROKER || DEFAULT_BROKER_URL
  const brokerSecret = process.env.RCLAUDE_SECRET
  const conversationId = process.env.RCLAUDE_CONVERSATION_ID
  if (!conversationId) {
    log('FATAL: RCLAUDE_CONVERSATION_ID is required')
    process.exit(1)
  }
  const cwd = process.cwd()
  const model = process.env.OPENCODE_MODEL || process.env.RCLAUDE_MODEL || 'openrouter/openai/gpt-oss-20b:free'
  let initialPrompt: string | null = null
  if (process.env.RCLAUDE_INITIAL_PROMPT_FILE) {
    try {
      initialPrompt = require('node:fs').readFileSync(process.env.RCLAUDE_INITIAL_PROMPT_FILE, 'utf-8')
    } catch (err) {
      log(`Failed to read initial prompt file: ${(err as Error).message}`)
    }
  }
  return {
    brokerUrl,
    brokerSecret,
    conversationId,
    cwd,
    model,
    initialPrompt,
    title: process.env.CLAUDWERK_CONVERSATION_NAME || null,
    description: process.env.CLAUDWERK_CONVERSATION_DESCRIPTION || null,
    opencodeBin: process.env.OPENCODE_BIN || 'opencode',
  }
}

function buildBoot(cfg: CliConfig): AgentHostBoot {
  return {
    type: 'agent_host_boot',
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    conversationId: cfg.conversationId,
    project: cwdToProjectUri(cfg.cwd),
    capabilities: ['headless', 'channel'],
    claudeArgs: [],
    version: `opencode-host/${BUILD_VERSION.gitHashShort}`,
    buildTime: BUILD_VERSION.buildTime,
    agentHostType: 'opencode',
    title: cfg.title || undefined,
    description: cfg.description || undefined,
    startedAt: Date.now(),
    configuredModel: cfg.model,
  }
}

interface BrokerConnection {
  send(msg: AgentHostMessage | Record<string, unknown>): void
  emitTranscript(entries: TranscriptEntry[]): void
  close(): void
}

function connectBroker(cfg: CliConfig, onInput: (text: string) => void): BrokerConnection {
  const wsUrl = cfg.brokerSecret
    ? `${cfg.brokerUrl}${cfg.brokerUrl.includes('?') ? '&' : '?'}secret=${encodeURIComponent(cfg.brokerSecret)}`
    : cfg.brokerUrl

  let ws: WebSocket | null = null
  let connected = false
  let shouldReconnect = true
  let reconnectAttempts = 0
  const queue: unknown[] = []
  const MAX_QUEUE = 5000
  let heartbeat: ReturnType<typeof setInterval> | null = null

  function flushQueue() {
    while (queue.length > 0 && ws && connected) {
      const m = queue.shift()
      try {
        ws.send(JSON.stringify(m))
      } catch {
        queue.unshift(m)
        return
      }
    }
  }

  function send(msg: AgentHostMessage | Record<string, unknown>) {
    if (ws && connected) {
      try {
        ws.send(JSON.stringify(msg))
        return
      } catch {
        /* fall through */
      }
    }
    if (queue.length < MAX_QUEUE) queue.push(msg)
  }

  function connect() {
    debug(`connecting to ${cfg.brokerUrl.replace(/secret=[^&]+/, 'secret=***')}`)
    ws = new WebSocket(wsUrl)
    ws.onopen = () => {
      connected = true
      reconnectAttempts = 0
      log(`connected to broker conv=${cfg.conversationId.slice(0, 8)}`)
      send(buildBoot(cfg))
      flushQueue()
      heartbeat = setInterval(() => {
        if (!connected) return
        const hb: Heartbeat = {
          type: 'heartbeat',
          conversationId: cfg.conversationId,
          timestamp: Date.now(),
        }
        try {
          ws?.send(JSON.stringify(hb))
        } catch {
          /* dead socket */
        }
      }, 30_000)
    }
    ws.onclose = () => {
      connected = false
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      if (!shouldReconnect) return
      reconnectAttempts++
      const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempts, 6), 60_000)
      log(`broker disconnected; reconnecting in ${delay}ms`)
      setTimeout(connect, delay)
    }
    ws.onerror = e => {
      const evt = e as ErrorEvent
      debug(`ws error: ${evt.message ?? evt.error ?? 'unknown'}`)
    }
    ws.onmessage = ev => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(ev.data as string) as Record<string, unknown>
      } catch {
        return
      }
      const t = msg.type
      if (t === 'input' && typeof msg.input === 'string') {
        onInput(msg.input)
      } else if (t === 'protocol_upgrade_required') {
        log(`broker requested protocol upgrade: ${msg.reason}`)
        shouldReconnect = false
        process.exit(2)
      }
    }
  }
  connect()

  return {
    send,
    emitTranscript(entries: TranscriptEntry[]) {
      if (entries.length === 0) return
      const msg: TranscriptEntries = {
        type: 'transcript_entries',
        conversationId: cfg.conversationId,
        entries,
        isInitial: false,
      }
      send(msg)
    },
    close() {
      shouldReconnect = false
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      try {
        ws?.close()
      } catch {
        /* dead */
      }
    },
  }
}

/**
 * Spawn `opencode run` for one user input. Pipes stdout through the NDJSON
 * parser, calls onEntries(...) for transcript entries to broadcast.
 *
 * Resolves when the subprocess exits. Resolves with the captured session id
 * if any (used for `--session` on the next turn).
 */
async function runOpenCodeTurn(opts: {
  cfg: CliConfig
  input: string
  sessionId: string | null
  onEntries: (entries: TranscriptEntry[]) => void
  onSessionId: (id: string) => void
}): Promise<{ exitCode: number; finalState: ParserState }> {
  const { cfg, input, sessionId, onEntries, onSessionId } = opts
  const args = ['run', '--format', 'json', '--dir', cfg.cwd, '--model', cfg.model, '--dangerously-skip-permissions']
  if (sessionId) args.push('--session', sessionId)
  args.push(input)

  debug(`spawn: ${cfg.opencodeBin} ${args.join(' ')}`)

  // Use Bun.spawn so we get a stream<Uint8Array> for stdout
  const proc = Bun.spawn([cfg.opencodeBin, ...args], {
    cwd: cfg.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })

  const decoder = new TextDecoder()
  const state = createParserState()
  let carry = ''

  const stdoutPromise = (async () => {
    const reader = proc.stdout.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      carry = parseNdjsonChunk(chunk, carry, (event: OpenCodeEvent) => {
        const out = translateEvent(event, state)
        if (state.sessionId) onSessionId(state.sessionId)
        if (out.entries.length > 0) onEntries(out.entries)
      })
    }
    // Flush trailing partial line as a parse pass; defensive.
    if (carry.length > 0) {
      parseNdjsonChunk('\n', carry, (event: OpenCodeEvent) => {
        const out = translateEvent(event, state)
        if (state.sessionId) onSessionId(state.sessionId)
        if (out.entries.length > 0) onEntries(out.entries)
      })
      carry = ''
    }
  })()

  const stderrPromise = (async () => {
    const reader = proc.stderr.getReader()
    let stderr = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      stderr += decoder.decode(value, { stream: true })
    }
    if (stderr.trim() && debugEnabled) {
      log(`opencode stderr: ${stderr.trim().slice(0, 1000)}`)
    }
    return stderr
  })()

  const [exitCode] = await Promise.all([proc.exited, stdoutPromise, stderrPromise])
  debug(`opencode exited code=${exitCode} session=${state.sessionId ?? 'none'}`)
  // If the process exited without a terminal step_finish, drain whatever was
  // accumulated so the user still sees partial output.
  if (state.pendingBlocks.length > 0) {
    onEntries(flushTurn(state))
  }
  return { exitCode, finalState: state }
}

async function main() {
  const cfg = parseConfig()
  log(`starting conv=${cfg.conversationId.slice(0, 8)} model=${cfg.model} cwd=${cfg.cwd} broker=${cfg.brokerUrl}`)

  let openCodeSessionId: string | null = null
  let activeTurn: Promise<unknown> | null = null

  const broker = connectBroker(cfg, input => {
    if (activeTurn) {
      log('input received while a turn is active -- queuing not yet supported, ignoring')
      return
    }
    activeTurn = handleTurn(input).finally(() => {
      activeTurn = null
    })
  })

  async function handleTurn(input: string) {
    // Echo the user message into the transcript so the dashboard sees it.
    const userEntry: TranscriptUserEntry = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: input },
    }
    broker.emitTranscript([userEntry])

    const onSessionId = (id: string) => {
      if (openCodeSessionId === id) return
      openCodeSessionId = id
      // Promote the conversation -- mirrors how the Claude host announces a
      // CC session id once it knows one. The broker stores it on
      // agentHostMeta.openCodeSessionId via the conversation_promote handler.
      const promote: ConversationPromote = {
        type: 'conversation_promote',
        conversationId: cfg.conversationId,
        ccSessionId: id,
        source: 'stream_json',
      }
      broker.send(promote)
    }

    try {
      await runOpenCodeTurn({
        cfg,
        input,
        sessionId: openCodeSessionId,
        onEntries: entries => broker.emitTranscript(entries),
        onSessionId,
      })
    } catch (err) {
      log(`turn failed: ${(err as Error).message}`)
      broker.emitTranscript([
        {
          type: 'system',
          subtype: 'chat_api_error',
          level: 'error',
          content: `opencode-host turn failed: ${(err as Error).message}`,
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
        },
      ])
    }
  }

  // If the sentinel passed an initial prompt, dispatch it now.
  if (cfg.initialPrompt) {
    debug('dispatching initial prompt')
    activeTurn = handleTurn(cfg.initialPrompt).finally(() => {
      activeTurn = null
    })
  }

  // Keep the process alive. Signals are handled below.
  const shutdown = (sig: string) => {
    log(`shutdown: ${sig}`)
    broker.close()
    setTimeout(() => process.exit(0), 200)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(err => {
  log(`FATAL: ${(err as Error).stack ?? err}`)
  process.exit(1)
})
