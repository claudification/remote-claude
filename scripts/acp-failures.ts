#!/usr/bin/env bun
/**
 * Failure-case smoke driver for plan-acp-agent-host.md Phase B.
 *
 * Exercises six known failure surfaces and reports what the broker / host
 * actually emits for each, so we know the user-visible error story is
 * acceptable before shipping. Mirrors scripts/acp-smoke.ts plumbing.
 *
 *   1. Invalid model name      -- session/set_config_option rejects?
 *   2. Unreachable model       -- model exists in opencode but auth/network missing
 *   3. acp-host bin missing    -- skipped here (sentinel-side concern)
 *   4. opencode CLI missing    -- skipped here (sentinel-side concern)
 *   5. terminate while idle    -- broker terminates before any turn (already covered)
 *   6. Broker rejects unknown  -- spawn message with garbage acpAgent
 *
 * Run: `bun scripts/acp-failures.ts`. Exits 0 on completion, prints a
 * per-case verdict.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BROKER_WS = process.env.BROKER_WS || 'ws://localhost:9999'
const SECRET = process.env.RCLAUDE_SECRET
const BIN = resolve(process.cwd(), 'bin/acp-host')
const CWD = '/tmp/acp-smoke-test'

if (!SECRET) {
  process.stderr.write('RCLAUDE_SECRET not set\n')
  process.exit(2)
}
if (!existsSync(CWD)) mkdirSync(CWD, { recursive: true })
if (!existsSync(`${CWD}/.rclaude-spawn`)) writeFileSync(`${CWD}/.rclaude-spawn`, '')

class WsClient {
  ws: WebSocket
  received: any[] = []
  open: Promise<void>
  constructor(url: string, secret: string) {
    this.ws = new WebSocket(`${url}/?secret=${encodeURIComponent(secret)}`)
    this.ws.onmessage = e => {
      try {
        this.received.push(JSON.parse(e.data as string))
      } catch {}
    }
    this.open = new Promise<void>((res, rej) => {
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ type: 'subscribe', protocolVersion: 2 }))
        res()
      }
      this.ws.onerror = e => rej(new Error(`ws error: ${(e as ErrorEvent).message ?? '?'}`))
    })
  }
  send(o: object) {
    this.ws.send(JSON.stringify(o))
  }
  async waitFor(predicate: (m: any) => boolean, timeoutMs = 30_000): Promise<any | null> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const hit = this.received.find(predicate)
      if (hit) return hit
      await new Promise(r => setTimeout(r, 50))
    }
    return null
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

function spawnHost(opts: {
  conversationId: string
  acpAgent?: string
  initialModel?: string | null
  toolPermission?: 'none' | 'safe' | 'full'
}): ChildProcess {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (
      k.startsWith('RCLAUDE_') ||
      k.startsWith('CLAUDWERK_') ||
      k === 'CLAUDECODE' ||
      k.startsWith('ACP_') ||
      k === 'OPENCODE_CONFIG'
    )
      continue
    env[k] = v
  }
  Object.assign(env, {
    RCLAUDE_BROKER: BROKER_WS,
    RCLAUDE_SECRET: SECRET,
    RCLAUDE_CONVERSATION_ID: opts.conversationId,
    RCLAUDE_CWD: CWD,
    ACP_AGENT_NAME: opts.acpAgent ?? 'opencode',
    ACP_AGENT_CMD_JSON: JSON.stringify(['opencode', 'acp']),
    ACP_TOOL_PERMISSION: opts.toolPermission ?? 'full',
    ACP_HOST_DEBUG: '1',
    ...(opts.initialModel ? { ACP_AGENT_INITIAL_MODEL: opts.initialModel } : {}),
  })
  return spawn(BIN, { cwd: CWD, stdio: 'inherit', env })
}

const verdicts: Array<{ case: string; result: string }> = []

async function caseInvalidModel() {
  const cid = `acp-fail-bad-model-${Date.now().toString(36)}`
  process.stderr.write(`\n=== CASE: invalid model name (cid=${cid}) ===\n`)
  const dash = new WsClient(BROKER_WS, SECRET!)
  await dash.open
  const proc = spawnHost({ conversationId: cid, initialModel: 'garbage/totally-not-a-model' })
  // Wait either for the conversation to register and a turn_duration to land, OR for the host to die.
  await dash.waitFor(m => m.type === 'conversation_update' && m.conversation?.id === cid, 15_000)
  dash.send({ type: 'channel_subscribe', channel: 'conversation:transcript', conversationId: cid })
  await dash.waitFor(m => m.type === 'channel_ack', 5_000)
  dash.received.length = 0
  dash.send({ type: 'send_input', conversationId: cid, input: 'Say "hello" briefly.' })
  // Wait for either turn_duration or system error
  const settled = await dash.waitFor(m => {
    if (m.type !== 'transcript_entries') return false
    const entries = m.entries ?? []
    return entries.some(
      (e: any) => e.type === 'system' && (e.subtype === 'turn_duration' || e.subtype === 'chat_api_error'),
    )
  }, 60_000)
  if (!settled) {
    verdicts.push({ case: 'invalid model', result: 'TIMEOUT (no terminal entry within 60s)' })
  } else {
    const e = (settled.entries as any[]).find(x => x.type === 'system')
    verdicts.push({ case: 'invalid model', result: `${e.subtype}: ${(e.content || '').slice(0, 200)}` })
  }
  try {
    proc.kill()
  } catch {}
  await new Promise(r => setTimeout(r, 500))
  dash.close()
}

async function caseUnknownAgent() {
  process.stderr.write(`\n=== CASE: unknown ACP agent name ===\n`)
  const cid = `acp-fail-unknown-${Date.now().toString(36)}`
  const proc = spawnHost({ conversationId: cid, acpAgent: 'codex' }) // codex isn't built into the recipe yet -- but the host doesn't know; it'll try to spawn `opencode acp` regardless because the cmd is in env. So this case ACTUALLY tests "host with bad agent name" (recipe lookup happens in the SENTINEL, not the host -- the host gets cmd directly). Skip.
  try {
    proc.kill()
  } catch {}
  verdicts.push({
    case: 'unknown ACP agent',
    result: 'SKIPPED (recipe lookup is sentinel-side; host receives cmd via env)',
  })
}

async function caseHostBinaryMissing() {
  verdicts.push({
    case: 'acp-host bin missing',
    result: 'SKIPPED (covered by sentinel-side check; host process never starts)',
  })
}

async function caseTerminateBeforeTurn() {
  process.stderr.write(`\n=== CASE: terminate before any turn ===\n`)
  const cid = `acp-fail-early-term-${Date.now().toString(36)}`
  const dash = new WsClient(BROKER_WS, SECRET!)
  await dash.open
  const proc = spawnHost({ conversationId: cid })
  await dash.waitFor(m => m.type === 'conversation_update' && m.conversation?.id === cid, 15_000)
  // Don't send any input. Terminate immediately.
  dash.send({ type: 'terminate_conversation', conversationId: cid })
  const t0 = Date.now()
  let exited = false
  while (Date.now() - t0 < 5_000) {
    try {
      process.kill(proc.pid!, 0)
    } catch {
      exited = true
      break
    }
    await new Promise(r => setTimeout(r, 100))
  }
  verdicts.push({
    case: 'terminate before turn',
    result: exited ? `clean exit in ${Date.now() - t0}ms` : 'STILL ALIVE after 5s',
  })
  try {
    proc.kill()
  } catch {}
  dash.close()
}

async function caseEmptyPrompt() {
  process.stderr.write(`\n=== CASE: empty prompt ===\n`)
  const cid = `acp-fail-empty-prompt-${Date.now().toString(36)}`
  const dash = new WsClient(BROKER_WS, SECRET!)
  await dash.open
  const proc = spawnHost({ conversationId: cid })
  await dash.waitFor(m => m.type === 'conversation_update' && m.conversation?.id === cid, 15_000)
  dash.send({ type: 'channel_subscribe', channel: 'conversation:transcript', conversationId: cid })
  await dash.waitFor(m => m.type === 'channel_ack', 5_000)
  dash.received.length = 0
  dash.send({ type: 'send_input', conversationId: cid, input: '' })
  const settled = await dash.waitFor(m => {
    if (m.type !== 'transcript_entries') return false
    const entries = m.entries ?? []
    return entries.some(
      (e: any) => e.type === 'system' && (e.subtype === 'turn_duration' || e.subtype === 'chat_api_error'),
    )
  }, 60_000)
  if (!settled) {
    verdicts.push({ case: 'empty prompt', result: 'TIMEOUT' })
  } else {
    const e = (settled.entries as any[]).find(x => x.type === 'system')
    verdicts.push({ case: 'empty prompt', result: `${e.subtype}: ${(e.content || '').slice(0, 120)}` })
  }
  try {
    proc.kill()
  } catch {}
  dash.close()
}

async function main() {
  await caseInvalidModel()
  await caseUnknownAgent()
  await caseHostBinaryMissing()
  await caseTerminateBeforeTurn()
  await caseEmptyPrompt()
  process.stderr.write('\n\n===== VERDICTS =====\n')
  for (const v of verdicts) process.stderr.write(`  ${v.case.padEnd(30)} : ${v.result}\n`)
  process.exit(0)
}
main().catch(e => {
  process.stderr.write(`FATAL: ${(e as Error).stack ?? e}\n`)
  process.exit(1)
})
