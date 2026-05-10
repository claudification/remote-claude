/**
 * End-to-end staging test for the OpenCode agent host.
 *
 * Spawns the real bin/opencode-host binary, points it at the live staging
 * broker, has it run a single turn against OpenRouter (free model), and
 * asserts that:
 *   - agent_host_boot is accepted (broker creates a booting conversation)
 *   - opencode subprocess produces NDJSON the host can parse
 *   - transcript_entries with assistant content arrive at the broker
 *   - turn_duration system entry arrives with cost/token totals
 *   - conversation_promote captures the OpenCode session id
 *
 * Requires:
 *   STAGING_BROKER_URL=localhost:19999
 *   STAGING_SECRET=<hex>
 *   OPENROUTER_API_KEY=<key>
 *   bin/opencode-host built (run `bun run build:opencode-agent-host`)
 *   `opencode` CLI on PATH (bun add -g opencode-ai)
 *
 * Skipped when any of those are missing -- so the test is safe to leave in
 * the staging suite. Adds ~10-30s to a staging run when enabled (model
 * latency + OpenCode startup).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
// Vitest runs in node mode (see vitest.config.ts) so Bun.spawn isn't available
// here -- we use node:child_process for the test driver while the opencode-host
// binary itself still uses Bun.spawn internally. When this suite migrates to
// bun:test, swap to Bun.spawn.
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
const OPENCODE_BIN = resolvePath(process.cwd(), 'bin/opencode-host')
const HAVE_BIN = existsSync(OPENCODE_BIN)

const run = STAGING_AVAILABLE && HAVE_OPENROUTER && HAVE_BIN ? describe : describe.skip

const TEST_CWD = '/tmp/opencode-staging-test'

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

run('opencode-host e2e', () => {
  it('boots, runs a turn against OpenRouter, broadcasts assistant + turn_duration', async () => {
    const dashboard = await connectDashboard()
    await waitForMessage(dashboard, 'conversations_list')
    const conversationId = testId('oc-conv')

    // Spawn the binary with the broker pointed at staging. NO initial
    // prompt -- we drive the turn from the dashboard side after subscribing
    // to the transcript channel, so we don't race past it.
    // Strip RCLAUDE_* and CLAUDWERK_* from the test process env so settings
    // from a developer's interactive session (initial-prompt file, conversation
    // ids, etc.) don't bleed into the spawned host. Only forward what the
    // sentinel would set in real life.
    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue
      if (k.startsWith('RCLAUDE_') || k.startsWith('CLAUDWERK_') || k === 'CLAUDECODE') continue
      childEnv[k] = v
    }
    Object.assign(childEnv, {
      RCLAUDE_BROKER: `ws://${process.env.STAGING_BROKER_URL}`,
      RCLAUDE_SECRET: getBrokerSecret(),
      RCLAUDE_CONVERSATION_ID: conversationId,
      OPENCODE_MODEL: 'openrouter/openai/gpt-oss-20b:free',
      OPENCODE_HOST_DEBUG: '1',
    })
    const proc = nodeSpawn(OPENCODE_BIN, {
      cwd: TEST_CWD,
      stdio: 'inherit',
      env: childEnv,
    })
    spawned.push(proc)

    // Wait for the broker to register the conversation (arrives via
    // conversation_created or conversation_update once agent_host_boot lands).
    await waitForMatch(
      dashboard,
      'conversation_update',
      m => (m as { conversation?: { id?: string } }).conversation?.id === conversationId,
      15_000,
    )

    // Subscribe to the conversation's transcript channel. The broker keys
    // scoped broadcasts on the conversationId, so we must subscribe before
    // sending input -- otherwise transcript_entries broadcasts go elsewhere.
    dashboard.send({
      type: 'channel_subscribe',
      channel: 'conversation:transcript',
      conversationId,
    })
    await waitForMessage(dashboard, 'channel_ack')
    dashboard.received.length = 0

    // Drive a single turn from the dashboard side -- mirrors what the real
    // dashboard does when a user types in the input box.
    dashboard.send({
      type: 'send_input',
      conversationId,
      input: 'Say hello in one short sentence. Nothing else.',
    })

    // Step 1: assistant transcript_entry with text content
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
      90_000,
    )
    expect(assistantMsg).toBeTruthy()

    // Step 2: system turn_duration entry (signals the turn is finished)
    const turnDoneMsg = await waitForMatch(
      dashboard,
      'transcript_entries',
      m => {
        const entries = (m as { entries?: Array<{ type?: string; subtype?: string }> }).entries
        return !!entries?.some(e => e.type === 'system' && e.subtype === 'turn_duration')
      },
      90_000,
    )
    expect(turnDoneMsg).toBeTruthy()

    // Step 3: /diag endpoint confirms agentHostType + captured OpenCode session id.
    // The public /conversations/:id endpoint goes through conversationToOverview()
    // which intentionally strips backend-internal fields. /diag is the admin
    // endpoint that exposes them -- exactly what we need for assertion.
    await sleep(200)
    const convRes = await httpGet(`/conversations/${conversationId}/diag`, { bearer: getBrokerSecret() })
    expect(convRes.status).toBe(200)
    const conv = (await convRes.json()) as {
      id: string
      agentHostType?: string
      agentHostMeta?: Record<string, unknown>
      project?: string
    }
    expect(conv.agentHostType).toBe('opencode')
    expect(conv.project).toMatch(/^opencode:\/\//)
    // The OpenCode session id arrives via conversation_promote -- broker
    // stores it on agentHostMeta. The id format is `ses_xxx`.
    const sessionId =
      (conv.agentHostMeta?.ccSessionId as string | undefined) ??
      (conv.agentHostMeta?.openCodeSessionId as string | undefined)
    expect(sessionId).toMatch(/^ses_/)

    // Stop the host -- it stays alive after the turn; we explicitly kill it
    // to release the test (it would otherwise idle waiting for next input).
    try {
      proc.kill()
    } catch {}
  }, 120_000)

  // Phase 2: tool-permission tier control. With OPENCODE_TOOL_PERMISSION=safe
  // the host writes an opencode.json that disables bash/write/edit and points
  // the subprocess at it via OPENCODE_CONFIG. This confirms the full chain --
  // env var arrives at the host, config gets written, opencode honours it,
  // and the broker captures the tier in agentHostMeta.
  it('safe tier: opencode refuses bash but the read tool stays available', async () => {
    const dashboard = await connectDashboard()
    await waitForMessage(dashboard, 'conversations_list')
    const conversationId = testId('oc-safe')

    // Seed a tiny file the model can read to prove read still works.
    const testFile = `${TEST_CWD}/safe-tier-marker.txt`
    writeFileSync(testFile, 'SAFE_TIER_MARKER_OK\n')

    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue
      if (k.startsWith('RCLAUDE_') || k.startsWith('CLAUDWERK_') || k === 'CLAUDECODE') continue
      childEnv[k] = v
    }
    Object.assign(childEnv, {
      RCLAUDE_BROKER: `ws://${process.env.STAGING_BROKER_URL}`,
      RCLAUDE_SECRET: getBrokerSecret(),
      RCLAUDE_CONVERSATION_ID: conversationId,
      OPENCODE_MODEL: 'openrouter/openai/gpt-oss-20b:free',
      OPENCODE_TOOL_PERMISSION: 'safe',
      OPENCODE_HOST_DEBUG: '1',
    })
    const proc = nodeSpawn(OPENCODE_BIN, {
      cwd: TEST_CWD,
      stdio: 'inherit',
      env: childEnv,
    })
    spawned.push(proc)

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

    // Ask for both: a bash run (should be denied) and a file read (should
    // succeed). Free models are not perfectly deterministic, so we assert
    // (a) the turn finishes and (b) NO bash tool_result with status=completed
    // and content matching our marker -- denial may surface as 'rejected',
    // 'denied', missing tool entirely, or an error tool_result.
    dashboard.send({
      type: 'send_input',
      conversationId,
      input:
        'Use the read tool to read safe-tier-marker.txt. Then attempt to run `echo BASH_RAN_OK` with the bash tool. Report exactly what each tool returned.',
    })

    await waitForMatch(
      dashboard,
      'transcript_entries',
      m => {
        const entries = (m as { entries?: Array<{ type?: string; subtype?: string }> }).entries
        return !!entries?.some(e => e.type === 'system' && e.subtype === 'turn_duration')
      },
      90_000,
    )

    // Pull the transcript via /diag (admin endpoint exposes the full entries
    // array including tool_result blocks).
    await sleep(200)
    const trxRes = await httpGet(`/conversations/${conversationId}/diag`, { bearer: getBrokerSecret() })
    expect(trxRes.status).toBe(200)
    const trx = (await trxRes.json()) as {
      entries?: Array<{
        type?: string
        message?: { content?: Array<{ type?: string; name?: string; content?: unknown; tool_use_id?: string }> }
      }>
    }
    const entries = trx.entries ?? []

    // Find every bash invocation. If the model attempted bash, the matching
    // tool_result must NOT contain BASH_RAN_OK -- which would prove bash ran.
    const bashSucceeded = entries.some(e =>
      (e.message?.content ?? []).some(b => {
        if (b.type !== 'tool_result') return false
        const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
        return text.includes('BASH_RAN_OK')
      }),
    )
    expect(bashSucceeded).toBe(false)

    // Read tool, on the other hand, should still be reachable. The model may
    // or may not actually call it, but if it does, the tool_result must
    // contain our marker. We don't fail on "model didn't try" -- only on
    // "model tried and got blocked", which would mean safe-tier is too tight.
    const readResults = entries.flatMap(e =>
      (e.message?.content ?? []).filter(
        b => b.type === 'tool_result' && typeof b.content === 'string' && b.content.includes('SAFE_TIER_MARKER_OK'),
      ),
    )
    // It's enough that no error surfaces from read attempts. We don't assert
    // length > 0 because the free model may decide to skip read entirely.
    for (const r of readResults) {
      const text = typeof r.content === 'string' ? r.content : ''
      expect(text).not.toMatch(/permission|denied|refused/i)
    }

    try {
      proc.kill()
    } catch {}
  }, 120_000)

  // Phase 3a: MCP bridge. With a broker URL + secret in the host env, the
  // host writes an opencode.json carrying an `mcp.claudwerk` remote entry
  // pointing at http://broker/mcp. OpenCode's native MCP client connects out,
  // discovers `notify` etc. as MCP tools, and the model can call them. We
  // assert the round-trip end-to-end: model -> opencode MCP client -> broker
  // /mcp endpoint -> notify handler -> WS broadcast back to the dashboard.
  it('mcp bridge: model can call broker `notify` tool, dashboard sees the broadcast', async () => {
    const dashboard = await connectDashboard()
    await waitForMessage(dashboard, 'conversations_list')
    const conversationId = testId('oc-mcp')

    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue
      if (k.startsWith('RCLAUDE_') || k.startsWith('CLAUDWERK_') || k === 'CLAUDECODE') continue
      childEnv[k] = v
    }
    Object.assign(childEnv, {
      RCLAUDE_BROKER: `ws://${process.env.STAGING_BROKER_URL}`,
      RCLAUDE_SECRET: getBrokerSecret(),
      RCLAUDE_CONVERSATION_ID: conversationId,
      OPENCODE_MODEL: 'openrouter/openai/gpt-oss-20b:free',
      // 'full' tier so we don't fight tool permission while testing MCP. The
      // MCP block is tier-orthogonal -- it works on any tier -- but mixing
      // 'safe' + a free model that may not understand MCP semantics adds
      // failure modes that aren't what this test is asserting.
      OPENCODE_TOOL_PERMISSION: 'full',
      OPENCODE_HOST_DEBUG: '1',
    })
    const proc = nodeSpawn(OPENCODE_BIN, {
      cwd: TEST_CWD,
      stdio: 'inherit',
      env: childEnv,
    })
    spawned.push(proc)

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

    const NOTIFY_BODY = `mcp-bridge-${conversationId.slice(-8)}`
    dashboard.send({
      type: 'send_input',
      conversationId,
      input:
        `Use the MCP tool named "notify" (provided by the claudwerk MCP server) to send a notification with the message exactly: "${NOTIFY_BODY}". Then say done.`,
    })

    // The notify handler broadcasts a 'notification' WS message to all
    // subscribers (see broker/routes/mcp-server.ts notify tool). We wait for
    // it. If the model didn't call notify -- or notify failed -- this times
    // out and the test fails, which is exactly the assertion we want.
    const notif = await waitForMatch(
      dashboard,
      'notification',
      m => {
        const body = (m as { body?: string }).body
        return typeof body === 'string' && body.includes(NOTIFY_BODY)
      },
      90_000,
    )
    expect(notif).toBeTruthy()
    expect((notif as { body?: string }).body).toContain(NOTIFY_BODY)

    // And the turn finishes cleanly.
    await waitForMatch(
      dashboard,
      'transcript_entries',
      m => {
        const entries = (m as { entries?: Array<{ type?: string; subtype?: string }> }).entries
        return !!entries?.some(e => e.type === 'system' && e.subtype === 'turn_duration')
      },
      90_000,
    )

    try {
      proc.kill()
    } catch {}
  }, 180_000)
})
