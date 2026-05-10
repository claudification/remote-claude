#!/usr/bin/env bun
/**
 * opencode-agent-host -- agent host that wraps the OpenCode CLI.
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
 * The transport plumbing (WS reconnect, queue, heartbeat, ring buffer,
 * conversation_promote, protocol-upgrade-required) lives in
 * `src/shared/host-transport/`. This file owns only the OpenCode-specific
 * parts: NDJSON parsing, subprocess management, turn dispatch.
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
import { readFileSync } from 'node:fs'
import { createHostTransport, type HostTransport } from '../shared/host-transport'
import { cwdToProjectUri } from '../shared/project-uri'
import {
  AGENT_HOST_PROTOCOL_VERSION,
  type AgentHostBoot,
  type BrokerMessage,
  DEFAULT_BROKER_URL,
  type TranscriptEntry,
  type TranscriptUserEntry,
} from '../shared/protocol'
import { BUILD_VERSION } from '../shared/version'
import { createParserState, flushTurn, type OpenCodeEvent, parseNdjsonChunk, translateEvent } from './ndjson-parser'

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
      initialPrompt = readFileSync(process.env.RCLAUDE_INITIAL_PROMPT_FILE, 'utf-8')
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

/**
 * Spawn `opencode run` for one user input. Pipes stdout through the NDJSON
 * parser, calls onEntries(...) for transcript entries to broadcast.
 */
async function runOpenCodeTurn(opts: {
  cfg: CliConfig
  input: string
  sessionId: string | null
  onEntries: (entries: TranscriptEntry[]) => void
  onSessionId: (id: string) => void
}): Promise<{ exitCode: number }> {
  const { cfg, input, sessionId, onEntries, onSessionId } = opts
  const args = ['run', '--format', 'json', '--dir', cfg.cwd, '--model', cfg.model, '--dangerously-skip-permissions']
  if (sessionId) args.push('--session', sessionId)
  args.push(input)

  debug(`spawn: ${cfg.opencodeBin} ${args.join(' ')}`)

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
  if (state.pendingBlocks.length > 0) {
    onEntries(flushTurn(state))
  }
  return { exitCode }
}

async function main() {
  const cfg = parseConfig()
  log(`starting conv=${cfg.conversationId.slice(0, 8)} model=${cfg.model} cwd=${cfg.cwd} broker=${cfg.brokerUrl}`)

  let openCodeSessionId: string | null = null
  let activeTurn: Promise<unknown> | null = null
  let transport: HostTransport

  function handleInbound(msg: BrokerMessage) {
    const t = (msg as { type?: string }).type
    if (t === 'input') {
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
    trace: debugEnabled ? (dir, m) => debug(`${dir} ${(m as { type?: string }).type ?? '?'}`) : undefined,
  })

  async function handleTurn(input: string) {
    // Echo the user message into the transcript so the dashboard sees it.
    const userEntry: TranscriptUserEntry = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: input },
    }
    transport.sendTranscriptEntries([userEntry], false)

    const onSessionId = (id: string) => {
      if (openCodeSessionId === id) return
      openCodeSessionId = id
      transport.setSessionId(id, 'stream_json')
    }

    try {
      await runOpenCodeTurn({
        cfg,
        input,
        sessionId: openCodeSessionId,
        onEntries: entries => transport.sendTranscriptEntries(entries, false),
        onSessionId,
      })
    } catch (err) {
      log(`turn failed: ${(err as Error).message}`)
      transport.sendTranscriptEntries(
        [
          {
            type: 'system',
            subtype: 'chat_api_error',
            level: 'error',
            content: `opencode-host turn failed: ${(err as Error).message}`,
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
          },
        ],
        false,
      )
    }
  }

  if (cfg.initialPrompt) {
    debug('dispatching initial prompt')
    activeTurn = handleTurn(cfg.initialPrompt).finally(() => {
      activeTurn = null
    })
  }

  const shutdown = (sig: string) => {
    log(`shutdown: ${sig}`)
    transport.close()
    setTimeout(() => process.exit(0), 200)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(err => {
  log(`FATAL: ${(err as Error).stack ?? err}`)
  process.exit(1)
})
