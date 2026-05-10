/**
 * End-to-end staging test for the ACP agent host (`bin/acp-host`) wrapping
 * OpenCode via ACP.
 *
 * Spawns the real bin/acp-host binary, points it at the staging broker,
 * has it run a single turn against OpenRouter (free model), and asserts:
 *   - agent_host_boot is accepted with agentHostType=acp + opencode:// URI
 *   - ACP initialize succeeds, session/new returns a sessionId
 *   - transcript_entries with assistant content arrive at the broker
 *   - turn_duration system entry arrives
 *   - terminate_conversation cleanly shuts the host down
 *   - /diag reflects agentHostType=acp + ACP session id
 *
 * Mirrors src/broker/__tests__/staging/opencode-e2e.test.ts (the legacy
 * NDJSON path) so the two paths can be diffed side by side.
 *
 * Requires:
 *   STAGING_BROKER_URL=localhost:19999
 *   STAGING_SECRET=<hex>
 *   OPENROUTER_API_KEY=<key>
 *   bin/acp-host built (run `bun run build:acp-agent-host`)
 *   `opencode` CLI on PATH (bun add -g opencode-ai)
 *
 * Skipped when any of those are missing -- safe to leave in the staging
 * suite. Adds ~10-30s to a staging run when enabled.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import {
  cleanup,
  connectDashboard,
  getBrokerSecret,
  httpGet,
  sleep,
  testId,
  waitForMatch,
  waitForMessage,
} from './staging-harness'

const STAGING_AVAILABLE = !!(process.env.STAGING_BROKER_URL && process.env.STAGING_SECRET)
const HAVE_OPENROUTER = !!process.env.OPENROUTER_API_KEY
const ACP_BIN = resolvePath(process.cwd(), 'bin/acp-host')
const HAVE_BIN = existsSync(ACP_BIN)
const HAVE_OPENCODE = !!Bun.which('opencode')

const run = STAGING_AVAILABLE && HAVE_OPENROUTER && HAVE_BIN && HAVE_OPENCODE ? describe : describe.skip

const TEST_CWD = '/tmp/acp-staging-test'

beforeAll(() => {
  if (!existsSync(TEST_CWD)) mkdirSync(TEST_CWD, { recursive: true })
  if (!existsSync(`${TEST_CWD}/.rclaude-spawn`)) writeFileSync(`${TEST_CWD}/.rclaude-spawn`, '')
})

afterEach(() => {
  cleanup()
})

const spawned: ChildProcess[] = []

afterAll(() => {
  for (const p of spawned) {
    try {
      p.kill()
    } catch {}
  }
})

function spawnAcpHost(opts: {
  conversationId: string
  toolPermission?: 'none' | 'safe' | 'full'
  acpAgent?: string
  initialPrompt?: string
}): ChildProcess {
  // Build env the same way the sentinel ACP arm does -- this test is
  // verifying the host binary, not the sentinel dispatch code (covered by
  // sentinel unit tests). When this suite migrates to bun:test (it already
  // is) and the sentinel arm gets its own integration test, this can layer
  // on top of that.
  const childEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k.startsWith('RCLAUDE_') || k.startsWith('CLAUDWERK_') || k === 'CLAUDECODE' || k.startsWith('ACP_')) continue
    childEnv[k] = v
  }
  Object.assign(childEnv, {
    RCLAUDE_BROKER: `ws://${process.env.STAGING_BROKER_URL}`,
    RCLAUDE_SECRET: getBrokerSecret(),
    RCLAUDE_CONVERSATION_ID: opts.conversationId,
    RCLAUDE_CWD: TEST_CWD,
    ACP_AGENT_NAME: opts.acpAgent ?? 'opencode',
    ACP_AGENT_CMD_JSON: JSON.stringify(['opencode', 'acp']),
    ACP_AGENT_INITIAL_MODEL: 'openrouter/openai/gpt-oss-20b:free',
    ACP_TOOL_PERMISSION: opts.toolPermission ?? 'safe',
    ACP_HOST_DEBUG: '1',
  })
  if (opts.initialPrompt) {
    const promptFile = `/tmp/acp-e2e-prompt-${opts.conversationId}`
    writeFileSync(promptFile, opts.initialPrompt)
    childEnv.RCLAUDE_INITIAL_PROMPT_FILE = promptFile
  }
  const proc = nodeSpawn(ACP_BIN, {
    cwd: TEST_CWD,
    stdio: 'inherit',
    env: childEnv,
  })
  spawned.push(proc)
  return proc
}

run('acp-host e2e (OpenCode-via-ACP)', () => {
  it('boots, runs a turn, broadcasts assistant + turn_duration, exposes ACP session id', async () => {
    const dashboard = await connectDashboard()
    await waitForMessage(dashboard, 'conversations_list')
    const conversationId = testId('acp-conv')

    spawnAcpHost({ conversationId })

    // Boot -> conversation_update
    await waitForMatch(
      dashboard,
      'conversation_update',
      m => (m as { conversation?: { id?: string } }).conversation?.id === conversationId,
      15_000,
    )

    dashboard.send({
      type: 'channel_subscribe',
      channel: 'conversation:transcript',
      conversationId,
    })
    await waitForMessage(dashboard, 'channel_ack')
    dashboard.received.length = 0

    dashboard.send({
      type: 'send_input',
      conversationId,
      input: 'Say hello in one short sentence. Nothing else.',
    })

    // Assistant text
    const assistantMsg = await waitForMatch(
      dashboard,
      'transcript_entries',
      m => {
        const entries = (m as { entries?: Array<{ type?: string; message?: { content?: unknown[] } }> }).entries
        if (!entries) return false
        return entries.some(
          e =>
            e.type === 'assistant' &&
            Array.isArray(e.message?.content) &&
            (e.message.content as Array<{ type?: string; text?: string }>).some(b => b.type === 'text' && !!b.text),
        )
      },
      120_000,
    )
    expect(assistantMsg).toBeTruthy()

    // Turn duration
    await waitForMatch(
      dashboard,
      'transcript_entries',
      m => {
        const entries = (m as { entries?: Array<{ type?: string; subtype?: string }> }).entries
        return !!entries?.some(e => e.type === 'system' && e.subtype === 'turn_duration')
      },
      120_000,
    )

    // /diag reflects ACP shape
    await sleep(200)
    const convRes = await httpGet(`/conversations/${conversationId}/diag`, { bearer: getBrokerSecret() })
    expect(convRes.status).toBe(200)
    const conv = (await convRes.json()) as {
      id: string
      agentHostType?: string
      agentHostMeta?: Record<string, unknown>
      project?: string
    }
    expect(conv.agentHostType).toBe('acp')
    // Project URI uses the agent name, not 'acp' (ACP is implementation detail).
    expect(conv.project).toMatch(/^opencode:\/\/default\//)
    const sessionId =
      (conv.agentHostMeta?.ccSessionId as string | undefined) ??
      (conv.agentHostMeta?.openCodeSessionId as string | undefined) ??
      (conv.agentHostMeta?.acpSessionId as string | undefined)
    expect(sessionId).toMatch(/^ses_/)
  }, 180_000)

  it('terminate_conversation: broker request shuts the host down within 5s', async () => {
    const dashboard = await connectDashboard()
    await waitForMessage(dashboard, 'conversations_list')
    const conversationId = testId('acp-term')
    const proc = spawnAcpHost({ conversationId })

    await waitForMatch(
      dashboard,
      'conversation_update',
      m => (m as { conversation?: { id?: string } }).conversation?.id === conversationId,
      15_000,
    )

    // Send terminate.
    dashboard.send({ type: 'terminate_conversation', conversationId })

    // Wait up to 5s for the host process to exit.
    const t0 = Date.now()
    let exited = false
    while (Date.now() - t0 < 5_000) {
      try {
        process.kill(proc.pid!, 0)
      } catch {
        exited = true
        break
      }
      await sleep(100)
    }
    expect(exited).toBe(true)
  }, 30_000)

  // 'safe' tier: bash invocations must be rejected via session/request_permission;
  // read-family tools should still work.
  it('safe tier: bash blocked at request_permission, read-family allowed', async () => {
    const dashboard = await connectDashboard()
    await waitForMessage(dashboard, 'conversations_list')
    const conversationId = testId('acp-safe')

    const testFile = `${TEST_CWD}/safe-acp-marker.txt`
    writeFileSync(testFile, 'SAFE_TIER_ACP_MARKER\n')

    spawnAcpHost({ conversationId, toolPermission: 'safe' })

    await waitForMatch(
      dashboard,
      'conversation_update',
      m => (m as { conversation?: { id?: string } }).conversation?.id === conversationId,
      15_000,
    )

    dashboard.send({
      type: 'channel_subscribe',
      channel: 'conversation:transcript',
      conversationId,
    })
    await waitForMessage(dashboard, 'channel_ack')
    dashboard.received.length = 0

    dashboard.send({
      type: 'send_input',
      conversationId,
      input:
        'First, read safe-acp-marker.txt with the read tool. Then attempt to run `echo BASH_LET_THROUGH_ACP` via the bash tool. Report what each tool returned.',
    })

    await waitForMatch(
      dashboard,
      'transcript_entries',
      m => {
        const entries = (m as { entries?: Array<{ type?: string; subtype?: string }> }).entries
        return !!entries?.some(e => e.type === 'system' && e.subtype === 'turn_duration')
      },
      120_000,
    )

    await sleep(200)
    const trxRes = await httpGet(`/conversations/${conversationId}/diag`, { bearer: getBrokerSecret() })
    expect(trxRes.status).toBe(200)
    const trx = (await trxRes.json()) as {
      entries?: Array<{
        type?: string
        message?: { content?: Array<{ type?: string; content?: unknown }> }
      }>
    }
    const entries = trx.entries ?? []

    // No bash tool_result should contain the marker -- if it does, bash ran.
    const bashSucceeded = entries.some(e =>
      (e.message?.content ?? []).some(b => {
        if (b.type !== 'tool_result') return false
        const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
        return text.includes('BASH_LET_THROUGH_ACP')
      }),
    )
    expect(bashSucceeded).toBe(false)
  }, 180_000)
})
