/**
 * Shared context object passed to extracted wrapper modules.
 * Holds mutable references to shared state so modules can read/write
 * without needing globals or circular imports.
 */

import type { FSWatcher as ChokidarWatcher } from 'chokidar'
import type { AgentHostMessage, HookEvent, TranscriptEntry } from '../shared/protocol'
import type { FileEditor } from './file-editor'
import type { PtyProcess } from './pty-spawn'
import type { StreamProcess } from './stream-backend'
import type { TranscriptWatcher } from './transcript-watcher'
import type { WsClient } from './ws-client'

/**
 * An outstanding user-facing interaction whose response is held in broker
 * memory. Stored on the wrapper so we can re-send on every (re)connect — a
 * broker restart mid-interaction would otherwise strand CC/MCP forever.
 * Kinds: permission_request, ask_question, dialog_show, plan_approval.
 */
export interface OutstandingInteraction {
  kind: 'permission_request' | 'ask_question' | 'dialog_show' | 'plan_approval'
  id: string
  payload: AgentHostMessage
  createdAt: number
}

export interface AgentHostContext {
  // Identity
  readonly conversationId: string
  readonly cwd: string

  // Mode flags (immutable after startup)
  readonly headless: boolean
  readonly channelEnabled: boolean
  readonly noBroker: boolean

  // Mutable session state
  claudeSessionId: string | null
  pendingClearFromId: string | null
  clearRequested: boolean
  /** UUID for the currently-running launch. Rotates on every /clear reboot so
   *  the dashboard can group launch events into their own timeline. */
  currentLaunchId: string
  /** Phase of the current launch. 'initial' on first spawn, flips to 'reboot'
   *  when a /clear starts a new launch. The 'live' phase is never used by
   *  the wrapper itself -- it's reserved for broker-synthesized
   *  change events (model_changed, mcp_servers_changed, etc.) that are
   *  appended directly to the transcript server-side. */
  currentLaunchPhase: import('../shared/protocol').WrapperLaunchPhase
  /** Persistent, append-only log of every launch event emitted so far.
   *  Re-sent on WS reconnect so the dashboard catches up. */
  readonly launchEvents: Array<import('../shared/protocol').WrapperLaunchEvent>
  terminalAttached: boolean
  jsonStreamAttached: boolean
  readonly jsonStreamBuffer: string[]
  parentTranscriptPath: string | null
  lastTasksJson: string

  // Process references
  wsClient: WsClient | null
  ptyProcess: PtyProcess | null
  streamProc: StreamProcess | null
  fileEditor: FileEditor | null

  // Watchers
  taskWatcher: ChokidarWatcher | null
  taskCandidateDirs: string[]
  transcriptWatcher: TranscriptWatcher | null
  projectWatcher: ChokidarWatcher | null
  readonly subagentWatchers: Map<string, TranscriptWatcher>
  readonly bgTaskOutputWatchers: Map<string, { stop: () => void }>

  // Caches
  readonly pendingEditInputs: Map<string, { oldString: string; newString: string }>
  readonly pendingReadPaths: Map<string, string> // tool_use_id -> file_path for image upload
  readonly agentToolUseMap: Map<string, string>
  readonly pendingAskRequests: Map<string, { requestId: string; questions: unknown[] }>

  // Transcript entries received before claudeSessionId was set (e.g. initial prompt in headless mode).
  // Flushed by session-transition once claudeSessionId becomes available.
  readonly pendingTranscriptEntries: Array<{ entries: TranscriptEntry[]; isInitial: boolean; agentId?: string }>

  // Event queue
  readonly eventQueue: HookEvent[]

  // Pending session name (sent when WS connects)
  pendingConversationName?: { name: string; userSet: boolean; description?: string }

  // Outstanding user interactions (permission_request / ask_question /
  // dialog_show / plan_approval) keyed by their id. Full payload is kept
  // verbatim; re-sent on every (re)connect so a broker restart
  // mid-interaction doesn't strand CC/MCP waiting for a user response.
  readonly outstandingInteractions: Map<string, OutstandingInteraction>

  // Diagnostics
  readonly diagBuffer: Array<{ t: number; type: string; msg: string; args?: unknown }>
  diagFlushTimer: ReturnType<typeof setTimeout> | null

  // Functions provided by index.ts
  diag: (type: string, msg: string, args?: unknown) => void
  flushDiag: () => void
  debug: (msg: string) => void
  connectToBroker: (ccSessionId: string | null) => void
  startTaskWatching: () => void
  readTasks: () => void
  startProjectWatching: () => void
  sendProjectChanged: () => void
  startTranscriptWatcher: (transcriptPath: string) => void
  startSubagentWatcher: (agentId: string, transcriptPath: string, live: boolean) => void
  stopSubagentWatcher: (agentId: string) => void
  sendTranscriptEntriesChunked: (entries: TranscriptEntry[], isInitial: boolean, agentId?: string) => void

  // Upload a blob to the broker blob store, returns URL or null on failure
  uploadBlob: ((data: Uint8Array, mediaType: string) => Promise<string | null>) | null
}
