#!/usr/bin/env bun
/**
 * Phase A.5 follow-up spike. Resolves the three open questions from
 * .claude/docs/spike-acp-opencode.md before plan-acp-agent-host.md Phase B
 * starts:
 *
 *   1. Does `session/set_config_option` change the model? Spec says yes
 *      (configId="model", value="provider/model") but we never sent it.
 *   2. Does `mcpServers` on session/new actually open a connection? We stand
 *      up a tiny HTTP listener and observe the request hit it.
 *   3. What makes OpenCode emit `session/request_permission`? Try a few
 *      configurations to find the trigger.
 *
 * Output: .claude/docs/spike-acp-opencode/phase-a5/{summary.json,trace.ndjson,...}
 *
 * Re-run: `bun scripts/acp-spike-phase-a5.ts` (no API key needed for #1 + #2;
 *         #3 needs OPENROUTER_API_KEY because it runs a turn).
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'

const OUT_DIR = join(process.cwd(), '.claude/docs/spike-acp-opencode/phase-a5')
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

class AcpClient {
  private nextId = 1
  private pending = new Map<number | string, (res: JsonRpcRes) => void>()
  notifications: JsonRpcNotify[] = []
  sessionUpdateListeners: Array<(n: JsonRpcNotify) => void> = []
  permissionRequests: Array<JsonRpcReq> = []
  private buf = ''

  constructor(public child: ChildProcess) {
    child.stdout!.on('data', d => this.onData(d))
    child.stderr!.on('data', d => trace('note', { stderr: d.toString() }))
  }

  private onData(d: Buffer) {
    this.buf += d.toString()
    while (true) {
      const idx = this.buf.indexOf('\n')
      if (idx === -1) break
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (!line.trim()) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        trace('note', { parse_error: line })
        continue
      }
      trace('recv', msg)
      if (msg.id !== undefined && msg.method !== undefined) {
        // Agent-to-client request
        this.handleAgentRequest(msg as JsonRpcReq)
      } else if (msg.id !== undefined) {
        const cb = this.pending.get(msg.id)
        if (cb) {
          this.pending.delete(msg.id)
          cb(msg as JsonRpcRes)
        }
      } else if (msg.method !== undefined) {
        this.notifications.push(msg as JsonRpcNotify)
        if (msg.method === 'session/update') {
          for (const cb of this.sessionUpdateListeners) {
            try {
              cb(msg)
            } catch {}
          }
        }
      }
    }
  }

  private writeLine(obj: unknown) {
    this.child.stdin!.write(JSON.stringify(obj) + '\n')
  }

  private handleAgentRequest(req: JsonRpcReq) {
    const respond = (result: unknown) => {
      const res: JsonRpcRes = { jsonrpc: '2.0', id: req.id, result }
      trace('send', res)
      this.writeLine(res)
    }
    const respondError = (code: number, message: string) => {
      const res: JsonRpcRes = { jsonrpc: '2.0', id: req.id, error: { code, message } }
      trace('send', res)
      this.writeLine(res)
    }
    if (req.method === 'session/request_permission') {
      this.permissionRequests.push(req)
      // Allow once so the run completes -- we want to observe the request, not block it.
      respond({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
      return
    }
    if (req.method === 'fs/read_text_file') {
      try {
        const text = readFileSync((req.params as any).path, 'utf8')
        respond({ content: text })
      } catch (e) {
        respondError(-32000, (e as Error).message)
      }
      return
    }
    respondError(-32601, `spike: ${req.method} not implemented`)
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++
    const req: JsonRpcReq = { jsonrpc: '2.0', id, method, params }
    trace('send', req)
    this.writeLine(req)
    return new Promise<T>((resolve, reject) => {
      const to = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout ${method} ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, res => {
        clearTimeout(to)
        if (res.error) reject(new Error(`${method} rpc error: ${JSON.stringify(res.error)}`))
        else resolve(res.result as T)
      })
    })
  }

  close() {
    try {
      this.child.kill()
    } catch {}
  }
}

function spawnOpencode(env: Record<string, string | undefined> = {}) {
  const child = spawn('opencode', ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
  return new AcpClient(child)
}

async function initialize(c: AcpClient) {
  return await c.call(
    'initialize',
    {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
    },
    30_000,
  )
}

interface MockMcpServer {
  url: string
  requests: Array<{ method: string; path: string; headers: Record<string, string>; body: string }>
  close: () => Promise<void>
}

function startMockMcp(): Promise<MockMcpServer> {
  return new Promise(resolve => {
    const reqs: MockMcpServer['requests'] = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = ''
      req.on('data', c => {
        body += c
      })
      req.on('end', () => {
        reqs.push({
          method: req.method ?? '',
          path: req.url ?? '',
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')]),
          ),
          body,
        })
        // Respond as a no-tool MCP server -- enough for opencode to see the connection succeed.
        res.writeHead(200, { 'content-type': 'application/json' })
        // Try to parse and emit a JSON-RPC response shape if it's an MCP initialize/list_tools
        try {
          const j = JSON.parse(body || '{}')
          if (j.method === 'initialize') {
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: j.id,
                result: {
                  protocolVersion: '2024-11-05',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'mock-mcp', version: '0' },
                },
              }),
            )
            return
          }
          if (j.method === 'tools/list') {
            res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { tools: [] } }))
            return
          }
          res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? null, result: {} }))
        } catch {
          res.end('{}')
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr !== 'object' || !addr) throw new Error('no addr')
      const url = `http://127.0.0.1:${addr.port}/mcp`
      resolve({
        url,
        requests: reqs,
        close: () => new Promise(r => server.close(() => r(undefined))),
      })
    })
  })
}

async function probe1_setConfigOption() {
  process.stderr.write('\n[probe1] session/set_config_option model write-back\n')
  const c = spawnOpencode()
  try {
    await initialize(c)
    const newRes = await c.call<any>('session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = newRes.sessionId
    const initialModel = (newRes.configOptions ?? []).find((o: any) => o.id === 'model')
    if (!initialModel) return { ok: false, error: 'no model configOption in session/new response' }

    // Pick a different model from currentValue.
    const currentValue = initialModel.currentValue
    const altOption = initialModel.options.find((o: any) => o.value !== currentValue)
    if (!altOption) return { ok: false, error: 'no alternative model in options' }

    process.stderr.write(`[probe1] current=${currentValue} -> ${altOption.value}\n`)

    let setRes: any
    let setErr: string | null = null
    try {
      setRes = await c.call(
        'session/set_config_option',
        {
          sessionId,
          configId: 'model',
          value: altOption.value,
        },
        30_000,
      )
    } catch (e) {
      setErr = (e as Error).message
    }

    writeFileSync(
      join(OUT_DIR, 'probe1-set-config-option.json'),
      JSON.stringify({ initialModel, altOption, setRes, setErr }, null, 2),
    )
    return { ok: !setErr, currentValue, altValue: altOption.value, setRes, setErr }
  } finally {
    c.close()
  }
}

async function probe2_mcpConnects() {
  process.stderr.write('\n[probe2] real mcpServers connection\n')
  const mock = await startMockMcp()
  process.stderr.write(`[probe2] mock MCP listening at ${mock.url}\n`)
  const c = spawnOpencode()
  try {
    await initialize(c)
    const newRes = await c.call<any>(
      'session/new',
      {
        cwd: process.cwd(),
        mcpServers: [
          {
            name: 'mock-mcp',
            type: 'http',
            url: mock.url,
            headers: [{ name: 'Authorization', value: 'Bearer test-secret' }],
          },
        ],
      },
      30_000,
    )
    process.stderr.write(`[probe2] session ${newRes.sessionId}, waiting 3s for connection...\n`)
    await new Promise(r => setTimeout(r, 3_000))

    const reqs = mock.requests.slice()
    writeFileSync(join(OUT_DIR, 'probe2-mock-mcp-requests.json'), JSON.stringify(reqs, null, 2))
    return { ok: reqs.length > 0, requestCount: reqs.length, firstRequest: reqs[0] ?? null }
  } finally {
    c.close()
    await mock.close()
  }
}

async function probe3_requestPermissionTrigger() {
  process.stderr.write('\n[probe3] what triggers session/request_permission\n')
  if (!process.env.OPENROUTER_API_KEY) {
    return { ok: false, skipped: 'OPENROUTER_API_KEY not set; skipped' }
  }
  // OpenCode has a permission system controlled via opencode.json:
  //   permission: { bash: "ask", edit: "ask", ... }
  // We write such a config and check that bash invocations now go through
  // session/request_permission. If they do, that's the wiring path for our
  // 'safe' tier under ACP.
  const cfgDir = join(OUT_DIR, 'probe3-config')
  mkdirSync(cfgDir, { recursive: true })
  const cfgPath = join(cfgDir, 'opencode.json')
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        permission: { bash: 'ask', edit: 'ask', write: 'ask' },
      },
      null,
      2,
    ),
  )

  const c = spawnOpencode({ OPENCODE_CONFIG: cfgPath, OPENCODE_DISABLE_PROJECT_CONFIG: 'true' })
  try {
    await initialize(c)
    const newRes = await c.call<any>('session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = newRes.sessionId

    let promptResult: any
    try {
      promptResult = await c.call(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: 'Run `echo PROBE_TRIGGER_OK` via the bash tool. Then say done.' }],
        },
        90_000,
      )
    } catch (e) {
      promptResult = { error: (e as Error).message }
    }

    writeFileSync(
      join(OUT_DIR, 'probe3-prompt-result.json'),
      JSON.stringify(
        { promptResult, permissionRequestCount: c.permissionRequests.length, permissionRequests: c.permissionRequests },
        null,
        2,
      ),
    )

    return {
      ok: c.permissionRequests.length > 0,
      permissionRequestCount: c.permissionRequests.length,
      firstPermissionRequest: c.permissionRequests[0] ?? null,
    }
  } finally {
    c.close()
  }
}

async function main() {
  const summary: Record<string, unknown> = {}
  try {
    summary.probe1 = await probe1_setConfigOption()
  } catch (e) {
    summary.probe1 = { ok: false, error: (e as Error).message }
  }
  try {
    summary.probe2 = await probe2_mcpConnects()
  } catch (e) {
    summary.probe2 = { ok: false, error: (e as Error).message }
  }
  try {
    summary.probe3 = await probe3_requestPermissionTrigger()
  } catch (e) {
    summary.probe3 = { ok: false, error: (e as Error).message }
  }
  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
  process.stderr.write(`\n[phase-a5] DONE -- artifacts in ${OUT_DIR}\n`)
  process.stderr.write(JSON.stringify(summary, null, 2) + '\n')
  setTimeout(() => process.exit(0), 200)
}

main().catch(err => {
  process.stderr.write(`[phase-a5] FATAL: ${(err as Error).stack ?? err}\n`)
  setTimeout(() => process.exit(1), 200)
})
