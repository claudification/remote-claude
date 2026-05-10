#!/usr/bin/env bun
/**
 * ACP spike: drive `opencode acp` over stdio JSON-RPC and capture raw protocol
 * traces for plan-acp-agent-host.md Phase A. Output goes to
 * .claude/docs/spike-acp-opencode/ as raw JSON files plus a summary log.
 *
 * Disposable. Not wired into anything. Re-run with `bun scripts/acp-spike.ts`.
 *
 * Requires: OPENROUTER_API_KEY in env, opencode-ai 1.14.x on PATH.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT_DIR = join(process.cwd(), '.claude/docs/spike-acp-opencode')
mkdirSync(OUT_DIR, { recursive: true })
const TRACE_PATH = join(OUT_DIR, 'trace.ndjson')
writeFileSync(TRACE_PATH, '')

const trace = (dir: 'send' | 'recv' | 'note', msg: unknown) => {
  appendFileSync(TRACE_PATH, JSON.stringify({ t: Date.now(), dir, msg }) + '\n')
}

interface JsonRpcReq {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}
interface JsonRpcRes {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}
interface JsonRpcNotify {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

const child = spawn('opencode', ['acp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

child.stderr.on('data', d => {
  const s = d.toString()
  process.stderr.write(`[opencode stderr] ${s}`)
  trace('note', { stderr: s })
})

child.on('exit', (code, sig) => {
  process.stderr.write(`[opencode exit code=${code} sig=${sig}]\n`)
})

let nextId = 1
const pending = new Map<number | string, (res: JsonRpcRes) => void>()
const notifications: JsonRpcNotify[] = []
const sessionUpdateListeners: Array<(n: JsonRpcNotify) => void> = []

function writeLine(obj: unknown) {
  child.stdin.write(JSON.stringify(obj) + '\n')
}

function handleAgentRequest(req: JsonRpcReq) {
  // The agent may call back into the client. Provide minimal sane responses
  // so it doesn't stall.
  const respond = (result: unknown) => {
    const res: JsonRpcRes = { jsonrpc: '2.0', id: req.id, result }
    trace('send', res)
    writeLine(res)
  }
  const respondError = (code: number, message: string) => {
    const res: JsonRpcRes = { jsonrpc: '2.0', id: req.id, error: { code, message } }
    trace('send', res)
    writeLine(res)
  }
  switch (req.method) {
    case 'fs/read_text_file': {
      const p = (req.params as any)?.path
      try {
        const text = readFileSync(p, 'utf8')
        respond({ content: text })
      } catch (e) {
        respondError(-32000, `read failed: ${(e as Error).message}`)
      }
      return
    }
    case 'fs/write_text_file': {
      // Don't actually write anything during the spike.
      respondError(-32001, 'spike: write disabled')
      return
    }
    case 'session/request_permission': {
      // Auto-allow once for the spike so we observe the protocol shape but
      // don't grant blanket access.
      respond({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
      return
    }
    case 'terminal/create':
    case 'terminal/output':
    case 'terminal/wait_for_exit':
    case 'terminal/release':
    case 'terminal/kill': {
      respondError(-32601, 'spike: terminal not implemented')
      return
    }
    default:
      respondError(-32601, `spike: method not implemented: ${req.method}`)
  }
}

let buf = ''
child.stdout.on('data', d => {
  buf += d.toString()
  let idx: number
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    if (!line.trim()) continue
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch (e) {
      trace('note', { parse_error: line })
      continue
    }
    trace('recv', msg)
    if (msg.id !== undefined && msg.method !== undefined) {
      // Agent -> client request
      handleAgentRequest(msg as JsonRpcReq)
    } else if (msg.id !== undefined) {
      // Response to a client -> agent call
      const cb = pending.get(msg.id)
      if (cb) {
        pending.delete(msg.id)
        cb(msg as JsonRpcRes)
      }
    } else if (msg.method !== undefined) {
      // Notification from agent
      const n = msg as JsonRpcNotify
      notifications.push(n)
      if (n.method === 'session/update') {
        for (const cb of sessionUpdateListeners) {
          try { cb(n) } catch {}
        }
      }
    }
  }
})

function call<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
  const id = nextId++
  const req: JsonRpcReq = { jsonrpc: '2.0', id, method, params }
  trace('send', req)
  writeLine(req)
  return new Promise<T>((resolve, reject) => {
    const to = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout ${method} after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, res => {
      clearTimeout(to)
      if (res.error) reject(new Error(`${method} rpc error: ${JSON.stringify(res.error)}`))
      else resolve(res.result as T)
    })
  })
}

async function main() {
  const summary: Record<string, unknown> = {}
  const t0 = Date.now()

  // 1. initialize
  process.stderr.write('[spike] initialize\n')
  const initRes = await call<any>('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
    },
  }, 30_000)
  summary.initialize = initRes
  summary.cold_boot_ms = Date.now() - t0
  writeFileSync(join(OUT_DIR, 'initialize.json'), JSON.stringify(initRes, null, 2))
  process.stderr.write(`[spike] initialize ok in ${summary.cold_boot_ms}ms\n`)

  // 2. session/new -- baseline, no MCP
  process.stderr.write('[spike] session/new (baseline)\n')
  const newRes = await call<any>('session/new', {
    cwd: process.cwd(),
    mcpServers: [],
  }, 30_000)
  summary.session_new = newRes
  writeFileSync(join(OUT_DIR, 'session-new.json'), JSON.stringify(newRes, null, 2))
  const sessionId = newRes.sessionId
  process.stderr.write(`[spike] session: ${sessionId}\n`)

  // 2b. capture available_commands_update
  // Wait briefly for any post-create notifications to land.
  await new Promise(r => setTimeout(r, 1_000))
  const cmdNotif = notifications.find(n =>
    n.method === 'session/update' &&
    (n.params as any)?.update?.sessionUpdate === 'available_commands_update'
  )
  if (cmdNotif) {
    writeFileSync(join(OUT_DIR, 'available-commands.json'), JSON.stringify(cmdNotif, null, 2))
    summary.available_commands_present = true
    const cmds: any[] = (cmdNotif.params as any)?.update?.availableCommands ?? []
    summary.available_commands_count = cmds.length
    summary.has_model_command = cmds.some(c => c?.name === 'model' || c?.name === '/model')
    summary.command_names = cmds.map(c => c?.name)
  } else {
    summary.available_commands_present = false
  }

  // 3. session/prompt -- single turn
  process.stderr.write('[spike] session/prompt\n')
  const PROMPT = 'In one short reply: list files via the bash tool with `ls`, then say done.'
  const promptStart = Date.now()
  const updateLog: any[] = []

  const liveListener = (n: JsonRpcNotify) => {
    updateLog.push({ t: Date.now() - promptStart, params: n.params })
  }
  sessionUpdateListeners.push(liveListener)

  let promptResult: any
  try {
    promptResult = await call('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: PROMPT }],
    }, 120_000)
  } catch (e) {
    process.stderr.write(`[spike] session/prompt failed: ${(e as Error).message}\n`)
    promptResult = { error: (e as Error).message }
  }
  summary.session_prompt_ms = Date.now() - promptStart
  summary.session_prompt_result = promptResult
  // Stop capturing
  const i = sessionUpdateListeners.indexOf(liveListener)
  if (i >= 0) sessionUpdateListeners.splice(i, 1)

  writeFileSync(join(OUT_DIR, 'session-prompt-result.json'), JSON.stringify(promptResult, null, 2))
  writeFileSync(join(OUT_DIR, 'session-update-stream.json'), JSON.stringify(updateLog, null, 2))
  process.stderr.write(`[spike] prompt done in ${summary.session_prompt_ms}ms, ${updateLog.length} session/update events\n`)

  // Collect distinct event subtypes
  const subtypes = new Set<string>()
  for (const u of updateLog) {
    const sub = (u.params?.update?.sessionUpdate) ?? '<no-sub>'
    subtypes.add(sub)
  }
  summary.session_update_subtypes = [...subtypes]

  // 4. Streaming granularity
  const chunkEvents = updateLog.filter(u => u.params?.update?.sessionUpdate === 'agent_message_chunk')
  if (chunkEvents.length > 1) {
    const deltas: number[] = []
    for (let j = 1; j < chunkEvents.length; j++) deltas.push(chunkEvents[j].t - chunkEvents[j - 1].t)
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length
    const totalChars = chunkEvents.reduce((acc, c) => {
      const block = c.params?.update?.content
      if (block && typeof block === 'object' && 'text' in block) acc += String((block as any).text ?? '').length
      return acc
    }, 0)
    summary.streaming = {
      chunks: chunkEvents.length,
      total_chars: totalChars,
      avg_ms_between_chunks: Math.round(avg),
      avg_chars_per_chunk: chunkEvents.length ? Math.round(totalChars / chunkEvents.length) : 0,
      first_chunk_t: chunkEvents[0].t,
      last_chunk_t: chunkEvents[chunkEvents.length - 1].t,
    }
  } else {
    summary.streaming = { chunks: chunkEvents.length, note: 'fewer than 2 chunks; no granularity measurable' }
  }

  // 5. Cost / token reporting
  const costish = updateLog.filter(u => /cost|token|usage/i.test(JSON.stringify(u)))
  writeFileSync(join(OUT_DIR, 'cost-shaped-events.json'), JSON.stringify(costish, null, 2))
  summary.cost_events_found = costish.length

  // Tool call events -- extract shape
  const toolEvents = updateLog.filter(u => {
    const s = u.params?.update?.sessionUpdate ?? ''
    return s === 'tool_call' || s === 'tool_call_update'
  })
  writeFileSync(join(OUT_DIR, 'tool-call-events.json'), JSON.stringify(toolEvents, null, 2))
  summary.tool_call_events = toolEvents.length

  // 6. MCP via ACP -- array shape (per ACP spec)
  process.stderr.write('[spike] testing mcpServers (array shape)\n')
  try {
    const mcpRes = await call<any>('session/new', {
      cwd: process.cwd(),
      mcpServers: [
        {
          name: 'spike-test',
          type: 'http',
          url: 'http://127.0.0.1:1/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer test' }],
        },
      ],
    }, 30_000)
    summary.mcp_array_session_new = { ok: true, sessionId: mcpRes.sessionId }
    writeFileSync(join(OUT_DIR, 'mcp-array-session-new.json'), JSON.stringify(mcpRes, null, 2))
  } catch (e) {
    summary.mcp_array_session_new = { ok: false, error: (e as Error).message }
    process.stderr.write(`[spike] mcp array failed: ${(e as Error).message}\n`)
  }

  // 7. MCP via ACP -- alternative shape (sse)
  process.stderr.write('[spike] testing mcpServers (sse)\n')
  try {
    const mcpRes2 = await call<any>('session/new', {
      cwd: process.cwd(),
      mcpServers: [
        {
          name: 'spike-test-sse',
          type: 'sse',
          url: 'http://127.0.0.1:1/sse',
          headers: [{ name: 'Authorization', value: 'Bearer test' }],
        },
      ],
    }, 30_000)
    summary.mcp_sse_session_new = { ok: true, sessionId: mcpRes2.sessionId }
    writeFileSync(join(OUT_DIR, 'mcp-sse-session-new.json'), JSON.stringify(mcpRes2, null, 2))
  } catch (e) {
    summary.mcp_sse_session_new = { ok: false, error: (e as Error).message }
  }

  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
  writeFileSync(join(OUT_DIR, 'all-notifications.json'), JSON.stringify(notifications, null, 2))

  process.stderr.write(`\n[spike] DONE -- artifacts in ${OUT_DIR}\n`)
  child.kill()
  setTimeout(() => process.exit(0), 200)
}

main().catch(err => {
  process.stderr.write(`[spike] FATAL: ${(err as Error).stack ?? err}\n`)
  child.kill()
  setTimeout(() => process.exit(1), 200)
})
