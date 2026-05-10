#!/usr/bin/env bun
/**
 * Manual smoke test: spawn bin/acp-host (the new generic ACP agent host),
 * point it at the local broker, drive a single turn from a dashboard-style
 * WS connection, and verify the transcript stream arrives.
 *
 * This is the "real" integration test for plan-acp-agent-host.md Phase B
 * before the staging e2e harness is wired in. Uses:
 *   - Local broker on ws://localhost:9999  (running via docker compose)
 *   - RCLAUDE_SECRET from env (loaded by the user's shell from ~/.secrets)
 *   - OPENROUTER_API_KEY from env
 *   - bin/acp-host (built via `bun run build:acp-agent-host`)
 *
 * Run with `bun scripts/acp-smoke.ts`. Exits 0 on success, non-zero on any
 * assertion failure.
 *
 * Disposable -- this is here so future-me can reproduce the run; CI uses
 * the staging e2e test (src/broker/__tests__/staging/acp-e2e.test.ts) once
 * landed.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { OPENCODE_RECIPE } from '../src/sentinel/acp-recipes'

const BROKER_WS = process.env.BROKER_WS || 'ws://localhost:9999'
const BROKER_HTTP = BROKER_WS.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
const SECRET = process.env.RCLAUDE_SECRET
const OPENROUTER = process.env.OPENROUTER_API_KEY
const BIN = resolve(process.cwd(), 'bin/acp-host')
const CWD = '/tmp/acp-smoke-test'
const CONV_ID = `acp-smoke-${Date.now().toString(36)}`

function fail(msg: string): never {
  process.stderr.write(`\n[smoke] FAIL: ${msg}\n`)
  process.exit(1)
}

if (!SECRET) fail('RCLAUDE_SECRET not in env')
if (!OPENROUTER) fail('OPENROUTER_API_KEY not in env')
if (!existsSync(BIN)) fail(`${BIN} not found -- run \`bun run build:acp-agent-host\` first`)

// Sanity: the broker is up.
const health = await fetch(`${BROKER_HTTP}/health`).catch(e => {
  fail(`broker /health unreachable: ${e.message}`)
})
if (!health.ok) fail(`broker /health returned ${health.status}`)

// Make a clean test cwd with the spawn marker.
if (!existsSync(CWD)) mkdirSync(CWD, { recursive: true })
if (!existsSync(`${CWD}/.rclaude-spawn`)) writeFileSync(`${CWD}/.rclaude-spawn`, '')

process.stderr.write(`[smoke] conv=${CONV_ID} cwd=${CWD} broker=${BROKER_WS} bin=${BIN}\n`)

// ─── Connect dashboard WS first ──────────────────────────────────────
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
    this.open = new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ type: 'subscribe', protocolVersion: 2 }))
        resolve()
      }
      this.ws.onerror = e => reject(new Error(`ws error: ${(e as ErrorEvent).message ?? 'unknown'}`))
      this.ws.onclose = () => {}
    })
  }
  send(o: object) {
    this.ws.send(JSON.stringify(o))
  }
  async waitFor(predicate: (m: any) => boolean, timeoutMs = 30_000, label?: string): Promise<any> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const hit = this.received.find(predicate)
      if (hit) return hit
      await new Promise(r => setTimeout(r, 50))
    }
    fail(`timeout waiting for ${label ?? 'message'} after ${timeoutMs}ms`)
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

const dash = new WsClient(BROKER_WS, SECRET)
await dash.open
process.stderr.write(`[smoke] dashboard connected\n`)

// ─── Apply the recipe's permission preamble (the sentinel does this in prod) ──
const TIER = 'safe' as const
const prepared = OPENCODE_RECIPE.prepare?.({ conversationId: CONV_ID, cwd: CWD, toolPermission: TIER }) ?? { env: {} }
process.stderr.write(`[smoke] recipe prepared: ${JSON.stringify(prepared.env)}\n`)

// ─── Spawn the ACP host ──────────────────────────────────────────────
const childEnv: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue
  if (k.startsWith('RCLAUDE_') || k.startsWith('CLAUDWERK_') || k === 'CLAUDECODE' || k.startsWith('ACP_')) continue
  childEnv[k] = v
}
Object.assign(childEnv, {
  RCLAUDE_BROKER: BROKER_WS,
  RCLAUDE_SECRET: SECRET,
  RCLAUDE_CONVERSATION_ID: CONV_ID,
  RCLAUDE_CWD: CWD,
  ACP_AGENT_NAME: 'opencode',
  ACP_AGENT_CMD_JSON: JSON.stringify(['opencode', 'acp']),
  ACP_AGENT_INITIAL_MODEL: 'openrouter/openai/gpt-oss-20b:free',
  ACP_TOOL_PERMISSION: TIER,
  ACP_HOST_DEBUG: '1',
  ...prepared.env,
})

const proc: ChildProcess = spawn(BIN, {
  cwd: CWD,
  stdio: 'inherit',
  env: childEnv,
})
process.stderr.write(`[smoke] spawned acp-host pid=${proc.pid}\n`)

const cleanup = () => {
  try {
    proc.kill()
  } catch {}
  dash.close()
}
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

// ─── Wait for conversation registration ───────────────────────────────
await dash.waitFor(
  m => m.type === 'conversation_update' && m.conversation?.id === CONV_ID,
  20_000,
  'conversation_update',
)
process.stderr.write(`[smoke] conversation registered\n`)

// Subscribe to transcript channel and clear backlog.
dash.send({ type: 'channel_subscribe', channel: 'conversation:transcript', conversationId: CONV_ID })
await dash.waitFor(m => m.type === 'channel_ack', 5_000, 'channel_ack')
dash.received.length = 0

// ─── Drive a single turn ──────────────────────────────────────────────
const PROMPT = 'Briefly: list two distinct directories visible via the read tool, then say done.'
dash.send({ type: 'send_input', conversationId: CONV_ID, input: PROMPT })
process.stderr.write(`[smoke] input sent: ${PROMPT}\n`)

// 1) assistant entry with text content
const assistantMsg = await dash.waitFor(
  m => {
    if (m.type !== 'transcript_entries') return false
    const entries = m.entries ?? []
    return entries.some(
      (e: any) =>
        e.type === 'assistant' &&
        Array.isArray(e.message?.content) &&
        e.message.content.some((b: any) => b.type === 'text' && !!b.text),
    )
  },
  120_000,
  'assistant transcript_entry with text',
)
const assistantTexts = (assistantMsg.entries as any[])
  .filter(e => e.type === 'assistant')
  .flatMap(e => (e.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text))
process.stderr.write(`[smoke] assistant text: ${JSON.stringify(assistantTexts)}\n`)

// 2) turn_duration system entry
const turnDoneMsg = await dash.waitFor(
  m => {
    if (m.type !== 'transcript_entries') return false
    const entries = m.entries ?? []
    return entries.some((e: any) => e.type === 'system' && e.subtype === 'turn_duration')
  },
  120_000,
  'turn_duration system entry',
)
const td = (turnDoneMsg.entries as any[]).find(e => e.type === 'system' && e.subtype === 'turn_duration')
process.stderr.write(`[smoke] turn_duration: ${td?.content}\n`)

// 3) /diag reflects agentHostType=acp + ACP session id
await new Promise(r => setTimeout(r, 300))
const diagRes = await fetch(`${BROKER_HTTP}/conversations/${CONV_ID}/diag`, {
  headers: { Authorization: `Bearer ${SECRET}` },
})
if (!diagRes.ok) fail(`/diag returned ${diagRes.status}`)
const diag = (await diagRes.json()) as any
process.stderr.write(`[smoke] diag agentHostType=${diag.agentHostType} project=${diag.project}\n`)
if (diag.agentHostType !== 'acp') fail(`expected agentHostType=acp, got ${diag.agentHostType}`)
const sessionId = diag.agentHostMeta?.ccSessionId ?? diag.agentHostMeta?.openCodeSessionId
process.stderr.write(`[smoke] sessionId: ${sessionId}\n`)
if (typeof sessionId !== 'string' || !sessionId.startsWith('ses_')) {
  fail(`expected ses_ prefixed session id, got ${JSON.stringify(sessionId)}`)
}

// 4) terminate_conversation: dashboard kill -> host shuts down its agent process
process.stderr.write(`[smoke] testing terminate_conversation\n`)
const acpHostPid = proc.pid!
dash.send({ type: 'terminate_conversation', conversationId: CONV_ID })
const t0 = Date.now()
while (Date.now() - t0 < 5000) {
  // Check if the bin/acp-host process has exited
  try {
    process.kill(acpHostPid, 0)
  } catch {
    // ESRCH -- process gone.
    process.stderr.write(`[smoke] acp-host pid=${acpHostPid} exited within ${Date.now() - t0}ms\n`)
    break
  }
  await new Promise(r => setTimeout(r, 100))
}
try {
  process.kill(acpHostPid, 0)
  fail(`acp-host pid=${acpHostPid} still alive 5s after terminate_conversation`)
} catch {}

process.stderr.write(`\n[smoke] ALL ASSERTIONS PASSED\n`)
cleanup()
process.exit(0)
