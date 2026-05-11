#!/usr/bin/env bun
/**
 * rclaude - Claude Code Session Agent Host
 * Wraps claude CLI with hook injection and broker forwarding
 *
 * This is the thin orchestrator. Each phase is delegated to a focused module:
 *   cli-args.ts          CLI parsing, env resolution, version detection
 *   diag-buffer.ts       Diagnostics batching
 *   task-watcher.ts      Task & project file watching
 *   broker-connection.ts WebSocket connection + all WS callbacks
 *   mcp-callbacks.ts     MCP channel callback wiring
 *   execute-control.ts   Control verb dispatch (clear/quit/interrupt/...)
 *   cleanup.ts           Shutdown, resource cleanup, signal handlers
 *   ensure-rclaude-dir.ts .rclaude directory bootstrap
 */

import { checkBunVersion } from '../shared/bun-version'

checkBunVersion()

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwdToProjectUri } from '../shared/project-uri'
import type { AgentHostMessage, HookEvent, TranscriptEntry } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'
import { type BrokerConnectionDeps, connectToBroker } from './broker-connection'
import { createCleanup, registerSignalHandlers } from './cleanup'
import {
  detectClaudeAuth,
  detectClaudeVersion,
  handlePassthroughSubcommand,
  isBrokerReady,
  parseCliArgs,
  readSpinnerVerbs,
  setTerminalTitle,
  wsToHttpUrl,
} from './cli-args'
import { debug, setDebugStderr } from './debug'
import { wireDiag } from './diag-buffer'
import { ensureRclaudeDir } from './ensure-rclaude-dir'
import { buildHeadlessSpawnOptions, sendAdHocPrompt } from './headless-lifecycle'
import { processHookEvent } from './hook-processor'
import { emitLaunchEvent, filterRelevantEnv } from './launch-events'
import { setLocalServerDebug, startLocalServer } from './local-server'
import { buildMcpCallbacksWithRules } from './mcp-callbacks'
import { initMcpChannel, setBrokerInfo, setClaudeCodeVersion, setDialogCwd } from './mcp-channel'
import { Osc52Parser } from './osc52-parser'
import { clearInteraction, sendInteraction } from './pending-interactions'
import { createRulesEngine } from './permission-rules'
import { buildSystemPrompt } from './prompt-builder'
import { type PtyProcess, setupTerminalPassthrough, spawnClaude } from './pty-spawn'
import { writeMergedSettings } from './settings-merge'
import { spawnStreamClaude } from './stream-backend'
import { readAndSendTasks, sendProjectChanged, startProjectWatching, startTaskWatching } from './task-watcher'
import {
  sendTranscriptEntriesChunked,
  startSubagentWatcher,
  startTranscriptWatcher,
  stopSubagentWatcher,
} from './transcript-manager'

async function main() {
  const args = process.argv.slice(2)
  handlePassthroughSubcommand(args)

  const cli = await parseCliArgs(args)

  // Headless mode side-effects that must happen before anything else
  if (cli.headless) {
    setDebugStderr(true)
  }

  // Check broker reachability
  if (!cli.noBroker && !(await isBrokerReady(cli.brokerUrl))) {
    debug('Broker not reachable - running without it')
    cli.noBroker = true
  }
  debug(`Broker: ${cli.noBroker ? 'DISABLED' : 'ENABLED'} (url: ${cli.brokerUrl})`)

  const conversationId =
    process.env.RCLAUDE_CONVERSATION_ID ||
    process.env.RCLAUDE_SESSION_ID ||
    process.env.RCLAUDE_WRAPPER_ID ||
    randomUUID()
  const cwd = process.cwd()
  const rclaudeDir = ensureRclaudeDir(cwd)
  const permissionRules = createRulesEngine(cwd)

  const claudeVersion = detectClaudeVersion()
  setClaudeCodeVersion(claudeVersion)
  setDialogCwd(cwd)
  const claudeAuth = detectClaudeAuth()
  const spinnerVerbs = readSpinnerVerbs()

  const ctx: AgentHostContext = {
    conversationId,
    cwd,
    headless: cli.headless,
    channelEnabled: cli.channelEnabled,
    noBroker: cli.noBroker,

    claudeSessionId: null,
    pendingClearFromId: null,
    clearRequested: false,
    currentLaunchId: randomUUID(),
    currentLaunchPhase: 'initial',
    launchEvents: [],
    terminalAttached: false,
    jsonStreamAttached: false,
    jsonStreamBuffer: [],
    resumeId: cli.resumeId || null,
    syntheticUserUuids: new Map(),
    parentTranscriptPath: null,
    lastTasksJson: '',

    wsClient: null,
    ptyProcess: null,
    streamProc: null,
    fileEditor: null,

    taskWatcher: null,
    taskCandidateDirs: [],
    transcriptWatcher: null,
    projectWatcher: null,
    subagentWatchers: new Map(),
    bgTaskOutputWatchers: new Map(),

    pendingEditInputs: new Map(),
    pendingReadPaths: new Map(),
    agentToolUseMap: new Map(),
    pendingAskRequests: new Map(),
    toolNameByUseId: new Map(),
    outstandingInteractions: new Map(),

    pendingTranscriptEntries: [],
    eventQueue: [],
    diagBuffer: [],
    diagFlushTimer: null,

    // biome-ignore lint/style/noNonNullAssertion: deferred init, assigned by wireDiag
    diag: null!,
    // biome-ignore lint/style/noNonNullAssertion: deferred init, assigned by wireDiag
    flushDiag: null!,
    debug,
    // biome-ignore lint/style/noNonNullAssertion: deferred init
    connectToBroker: null!,
    // biome-ignore lint/style/noNonNullAssertion: deferred init
    startTaskWatching: null!,
    // biome-ignore lint/style/noNonNullAssertion: deferred init
    readTasks: null!,
    // biome-ignore lint/style/noNonNullAssertion: deferred init
    startProjectWatching: null!,
    // biome-ignore lint/style/noNonNullAssertion: deferred init
    sendProjectChanged: null!,
    startTranscriptWatcher: (path: string) => startTranscriptWatcher(ctx, path),
    startSubagentWatcher: (agentId: string, path: string, live: boolean) =>
      startSubagentWatcher(ctx, agentId, path, live),
    stopSubagentWatcher: (agentId: string) => stopSubagentWatcher(ctx, agentId),
    sendTranscriptEntriesChunked: (entries: TranscriptEntry[], isInitial: boolean, agentId?: string) =>
      sendTranscriptEntriesChunked(ctx, entries, isInitial, agentId),

    uploadBlob: cli.noBroker
      ? null
      : async (data: Uint8Array, mediaType: string) => {
          const httpUrl = wsToHttpUrl(cli.brokerUrl)
          try {
            const res = await fetch(`${httpUrl}/api/files`, {
              method: 'POST',
              headers: {
                'Content-Type': mediaType,
                ...(cli.brokerSecret ? { Authorization: `Bearer ${cli.brokerSecret}` } : {}),
              },
              body: data,
            })
            if (!res.ok) return null
            const json = (await res.json()) as { url?: string }
            return json.url || null
          } catch {
            return null
          }
        },
  }

  wireDiag(ctx)

  // Wire task/project watching onto context
  ctx.startTaskWatching = () => startTaskWatching(ctx)
  ctx.readTasks = () => readAndSendTasks(ctx)
  ctx.startProjectWatching = () => startProjectWatching(ctx)
  ctx.sendProjectChanged = () => sendProjectChanged(ctx)

  // Wire connectToBroker onto context
  const brokerDeps: BrokerConnectionDeps = {
    brokerUrl: cli.brokerUrl,
    brokerSecret: cli.brokerSecret,
    conversationId,
    cwd,
    configuredModel: cli.configuredModel,
    claudeArgs: cli.claudeArgs,
    claudeVersion,
    claudeAuth,
    spinnerVerbs,
    noTerminal: cli.noTerminal,
    headless: cli.headless,
    channelEnabled: cli.channelEnabled,
    isAdHoc: cli.isAdHoc,
    adHocTaskId: cli.adHocTaskId,
    adHocWorktree: cli.adHocWorktree,
    permissionRules,
  }
  ctx.connectToBroker = (ccSessionId: string | null) => {
    if (cli.noBroker) return
    connectToBroker(ctx, brokerDeps, ccSessionId)
  }

  // Init MCP channel with callbacks
  const devChannelConfirmed = { value: false }
  const osc52Parser = new Osc52Parser()
  ctx.diag('channel', `MCP enabled (channel input: ${cli.channelEnabled})`)

  // We need cleanup() before initMcpChannel (onExitConversation calls it),
  // but cleanup references localServer which comes after. Use a ref.
  let cleanupRef: (() => void) | null = null
  function cleanup() {
    cleanupRef?.()
  }

  const mcpCallbacks = buildMcpCallbacksWithRules(
    ctx,
    {
      brokerUrl: cli.brokerUrl,
      brokerSecret: cli.brokerSecret,
      noBroker: cli.noBroker,
      conversationId,
      cwd,
      headless: cli.headless,
      channelEnabled: cli.channelEnabled,
      cleanup,
    },
    permissionRules,
  )

  setBrokerInfo(cli.brokerUrl, cli.brokerSecret, cli.noBroker)
  initMcpChannel(mcpCallbacks, {
    ccSessionId: conversationId,
    conversationId,
    cwd,
    configuredModel: cli.configuredModel,
    headless: cli.headless,
    claudeVersion,
    claudeAuth,
  })

  // Wire debug logging into local server
  setLocalServerDebug(debug)

  // Start local HTTP server for hook callbacks + MCP endpoint
  const { server: localServer, port: localServerPort } = await startLocalServer({
    conversationId,
    mcpEnabled: true,
    onHookEvent(event: HookEvent) {
      processHookEvent(ctx, event)
    },
    onNotify(message: string, title?: string) {
      debug(`Notify: ${title ? `[${title}] ` : ''}${message}`)
      if (ctx.wsClient?.isConnected()) {
        ctx.wsClient.send({ type: 'notify', conversationId, message, title })
      }
    },
    onAskQuestion(request) {
      debug(`AskUserQuestion: ${request.questions.length} questions, toolUseId=${request.toolUseId.slice(0, 12)}`)
      sendInteraction(ctx, 'ask_question', request.toolUseId, {
        ...request,
        conversationId: ctx.conversationId,
      } as unknown as AgentHostMessage)
    },
    onAskTimeout(toolUseId: string) {
      clearInteraction(ctx, toolUseId)
    },
    hasDashboardSubscribers() {
      return ctx.wsClient?.isConnected() ?? false
    },
  })

  // Generate merged settings
  const settingsPath = await writeMergedSettings(conversationId, localServerPort, claudeVersion, rclaudeDir)

  // Connect to broker before CC spawn
  try {
    ctx.connectToBroker(null)
    ctx.wsClient?.sendBootEvent('agent_host_started', `cwd=${cwd} headless=${cli.headless}`)
    ctx.wsClient?.sendBootEvent('settings_merged', settingsPath)
  } catch (err) {
    debug(`early connect failed: ${err instanceof Error ? err.message : err}`)
  }

  setTerminalTitle(cwd)

  // Write system prompt
  const promptFile = join(rclaudeDir, 'settings', `prompt-${conversationId}.txt`)
  writeFileSync(
    promptFile,
    buildSystemPrompt({
      channelEnabled: cli.channelEnabled,
      headless: cli.headless,
      identity: {
        ccSessionId: conversationId,
        conversationId,
        cwd,
        configuredModel: cli.configuredModel,
        headless: cli.headless,
      },
    }),
  )
  cli.claudeArgs.push('--append-system-prompt', readFileSync(promptFile, 'utf-8'))

  // Prepare final claude args
  const brokerHttpUrl = cli.noBroker ? undefined : wsToHttpUrl(cli.brokerUrl)
  const mcpConfigPath = join(rclaudeDir, 'settings', `mcp-${conversationId}.json`)
  await Bun.write(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: { rclaude: { type: 'http', url: `http://localhost:${localServerPort}/mcp` } },
    }),
  )
  ctx.wsClient?.sendBootEvent('mcp_prepared', mcpConfigPath)

  // Naming is the broker's job. Agent-host only honors a name supplied by
  // the user (--name/-n in claudeArgs) or injected by the spawn pipeline via
  // CLAUDWERK_CONVERSATION_NAME (which cli-args.ts already converted to --name
  // before we reach here). Direct CLI launches without --name stay nameless --
  // unique slugs are reserved for control-panel-initiated spawns.
  const resolvedConversationName = process.env.CLAUDWERK_CONVERSATION_NAME || extractClaudeArgsName(cli.claudeArgs)
  debug(`Session name: ${resolvedConversationName || '(none)'} (user=${!!process.env.CLAUDWERK_CONVERSATION_NAME})`)

  const sessionDescription = process.env.CLAUDWERK_CONVERSATION_DESCRIPTION || undefined
  ctx.pendingConversationName = resolvedConversationName
    ? {
        name: resolvedConversationName,
        userSet: !!process.env.CLAUDWERK_CONVERSATION_NAME,
        description: sessionDescription,
      }
    : undefined
  if (resolvedConversationName && ctx.wsClient?.isConnected()) {
    ctx.wsClient.send({
      type: 'conversation_name',
      conversationId: ctx.claudeSessionId || conversationId,
      name: resolvedConversationName,
      userSet: !!process.env.CLAUDWERK_CONVERSATION_NAME,
      description: sessionDescription,
    } as AgentHostMessage)
    ctx.pendingConversationName = undefined
  }

  const finalClaudeArgs = [
    '--mcp-config',
    mcpConfigPath,
    '--disallowed-tools',
    'SendMessage',
    ...(cli.channelEnabled ? ['--dangerously-load-development-channels', 'server:rclaude'] : []),
    ...cli.claudeArgs,
  ]

  let cleanupTerminal = () => {}

  if (cli.headless) {
    spawnHeadless(ctx, {
      permissionRules,
      finalClaudeArgs,
      settingsPath,
      localServerPort,
      rclaudeDir,
      claudeVersion,
      mcpConfigPath,
      brokerHttpUrl,
      brokerSecret: cli.brokerSecret,
      customEnv: cli.customEnv,
      includePartialMessages: cli.includePartialMessages,
      channelEnabled: cli.channelEnabled,
      cwd,
      cleanup,
    })
  } else {
    const result = spawnPty(ctx, {
      finalClaudeArgs,
      settingsPath,
      conversationId,
      localServerPort,
      brokerHttpUrl,
      brokerSecret: cli.brokerSecret,
      customEnv: cli.customEnv,
      mcpConfigPath,
      channelEnabled: cli.channelEnabled,
      cwd,
      devChannelConfirmed,
      osc52Parser,
      cleanup,
    })
    if (!result) return // spawn failed, exit already scheduled
    cleanupTerminal = result.cleanupTerminal
  }

  // Wire the real cleanup now that we have all the pieces
  cleanupRef = createCleanup(ctx, {
    conversationId,
    rclaudeDir,
    promptFile,
    localServer,
    cleanupTerminal,
  })
  registerSignalHandlers(cleanup)
}

/** Pull `--name X` / `-n X` out of claudeArgs, if present. */
function extractClaudeArgsName(claudeArgs: string[]): string | undefined {
  for (let i = 0; i < claudeArgs.length - 1; i++) {
    if (claudeArgs[i] === '--name' || claudeArgs[i] === '-n') return claudeArgs[i + 1]
  }
  return undefined
}

interface HeadlessSpawnDeps {
  permissionRules: ReturnType<typeof createRulesEngine>
  finalClaudeArgs: string[]
  settingsPath: string
  localServerPort: number
  rclaudeDir: string
  claudeVersion: string | undefined
  mcpConfigPath: string
  brokerHttpUrl: string | undefined
  brokerSecret: string | undefined
  customEnv: Record<string, string>
  includePartialMessages: boolean
  channelEnabled: boolean
  cwd: string
  cleanup: () => void
}

function spawnHeadless(ctx: AgentHostContext, deps: HeadlessSpawnDeps) {
  debug('Starting in HEADLESS mode (stream-json)')
  ctx.diag('headless', 'Stream-JSON backend active')

  const headlessSpawnOptions = buildHeadlessSpawnOptions({
    ctx,
    permissionRules: deps.permissionRules,
    finalClaudeArgs: deps.finalClaudeArgs,
    settingsPath: deps.settingsPath,
    localServerPort: deps.localServerPort,
    rclaudeDir: deps.rclaudeDir,
    claudeVersion: deps.claudeVersion,
    mcpConfigPath: deps.mcpConfigPath,
    brokerUrl: deps.brokerHttpUrl,
    brokerSecret: deps.brokerSecret,
    spawnStreamClaude,
    cleanup: deps.cleanup,
    env: Object.keys(deps.customEnv).length ? deps.customEnv : undefined,
    includePartialMessages: deps.includePartialMessages,
  })

  ctx.wsClient?.sendBootEvent('claude_spawning', `headless ${deps.finalClaudeArgs.length} args`)
  emitLaunchEvent(ctx, 'launch_started', {
    detail: `headless (${deps.finalClaudeArgs.length} args)`,
    raw: {
      args: deps.finalClaudeArgs,
      env: filterRelevantEnv(process.env, deps.customEnv),
      cwd: deps.cwd,
      headless: true,
      channelEnabled: deps.channelEnabled,
      mcpConfigPath: deps.mcpConfigPath,
      settingsPath: deps.settingsPath,
    },
  })
  ctx.streamProc = spawnStreamClaude(headlessSpawnOptions)
  ctx.streamProc.forwardStdin()
  ctx.wsClient?.sendBootEvent('claude_started', `pid=${ctx.streamProc.proc.pid}`, {
    pid: ctx.streamProc.proc.pid,
  })
  ctx.wsClient?.sendBootEvent('awaiting_init', 'Waiting for stream-json system:init')
  sendAdHocPrompt(ctx)
}

interface PtySpawnDeps {
  finalClaudeArgs: string[]
  settingsPath: string
  conversationId: string
  localServerPort: number
  brokerHttpUrl: string | undefined
  brokerSecret: string | undefined
  customEnv: Record<string, string>
  mcpConfigPath: string
  channelEnabled: boolean
  cwd: string
  devChannelConfirmed: { value: boolean }
  osc52Parser: InstanceType<typeof Osc52Parser>
  cleanup: () => void
}

function spawnPty(ctx: AgentHostContext, deps: PtySpawnDeps): { cleanupTerminal: () => void } | null {
  ctx.wsClient?.sendBootEvent('claude_spawning', `pty ${deps.finalClaudeArgs.length} args`)
  emitLaunchEvent(ctx, 'launch_started', {
    detail: `pty (${deps.finalClaudeArgs.length} args)`,
    raw: {
      args: deps.finalClaudeArgs,
      env: filterRelevantEnv(process.env, deps.customEnv),
      cwd: deps.cwd,
      headless: false,
      channelEnabled: deps.channelEnabled,
      mcpConfigPath: deps.mcpConfigPath,
      settingsPath: deps.settingsPath,
    },
  })
  const ptySpawnedAt = Date.now()
  try {
    ctx.ptyProcess = spawnClaude({
      args: deps.finalClaudeArgs,
      settingsPath: deps.settingsPath,
      conversationId: deps.conversationId,
      localServerPort: deps.localServerPort,
      brokerUrl: deps.brokerHttpUrl,
      brokerSecret: deps.brokerSecret,
      env: Object.keys(deps.customEnv).length ? deps.customEnv : undefined,
      onData(data) {
        handlePtyData(ctx, deps, data)
      },
      onExit(code) {
        handlePtyExit(ctx, deps, code, ptySpawnedAt)
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    debug(`PTY spawn failed: ${msg}`)
    ctx.wsClient?.send({
      type: 'spawn_failed',
      conversationId: deps.conversationId,
      project: cwdToProjectUri(deps.cwd),
      error: `PTY spawn failed: ${msg}`,
    })
    setTimeout(() => {
      deps.cleanup()
      process.exit(1)
    }, 500)
    return null
  }

  ctx.wsClient?.sendBootEvent('claude_started', `pid=${ctx.ptyProcess?.proc.pid ?? 'unknown'}`, {
    pid: ctx.ptyProcess?.proc.pid,
  })
  ctx.wsClient?.sendBootEvent('awaiting_init', 'Waiting for SessionStart hook')

  return {
    cleanupTerminal: setupTerminalPassthrough(ctx.ptyProcess as PtyProcess),
  }
}

function handlePtyData(ctx: AgentHostContext, deps: PtySpawnDeps, data: string) {
  if (deps.channelEnabled && !deps.devChannelConfirmed.value) {
    const plain = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b[=>?][0-9]*[a-zA-Z]/g, '')
    if (plain.includes('Entertoconfirm')) {
      deps.devChannelConfirmed.value = true
      setTimeout(() => {
        debug('[channel] Sending Enter to confirm dev channel warning')
        ctx.ptyProcess?.write('\r')
      }, 300)
      ctx.diag('channel', 'Auto-confirmed dev channel warning')
    }
  }

  const cleaned = deps.osc52Parser.write(data, capture => {
    if (ctx.wsClient?.isConnected()) {
      const sid = ctx.claudeSessionId || deps.conversationId
      ctx.wsClient.send({
        type: 'clipboard_capture',
        conversationId: sid,
        contentType: capture.contentType,
        text: capture.text,
        base64: capture.contentType === 'image' ? capture.base64 : undefined,
        mimeType: capture.mimeType,
        timestamp: Date.now(),
      })
      ctx.diag(
        'clipboard',
        `${capture.contentType}${capture.mimeType ? ` (${capture.mimeType})` : ''} ${capture.text ? `${capture.text.length} chars` : `${capture.base64.length} b64 bytes`}`,
      )
    }
  })

  if (ctx.terminalAttached && ctx.claudeSessionId && ctx.wsClient?.isConnected()) {
    ctx.wsClient.sendTerminalData(cleaned)
  }
}

function handlePtyExit(ctx: AgentHostContext, deps: PtySpawnDeps, code: number | null, ptySpawnedAt: number) {
  const elapsedMs = Date.now() - ptySpawnedAt
  if (elapsedMs < 10_000 && code !== 0) {
    debug(`PTY early exit: code=${code} elapsed=${elapsedMs}ms - reporting spawn_failed`)
    ctx.wsClient?.send({
      type: 'spawn_failed',
      conversationId: deps.conversationId,
      project: cwdToProjectUri(deps.cwd),
      exitCode: code,
      elapsedMs,
      error: `Claude process exited in ${elapsedMs}ms (exit ${code}) - likely hook, config, or binary failure`,
    })
  }

  if (ctx.claudeSessionId) {
    ctx.wsClient?.sendConversationEnd(code === 0 ? 'normal' : `exit_code_${code}`)
  }
  deps.cleanup()
  process.exit(code ?? 0)
}

main().catch(error => {
  debug(`Fatal bootstrap error: ${error instanceof Error ? error.stack || error.message : error}`)
  process.exit(1)
})
