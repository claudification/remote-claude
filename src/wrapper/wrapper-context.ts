/**
 * Shared context object passed to extracted wrapper modules.
 * Holds mutable references to shared state so modules can read/write
 * without needing globals or circular imports.
 */

import type { FSWatcher as ChokidarWatcher } from 'chokidar'
import type { HookEvent, TranscriptEntry } from '../shared/protocol'
import type { FileEditor } from './file-editor'
import type { PtyProcess } from './pty-spawn'
import type { StreamProcess } from './stream-backend'
import type { TranscriptWatcher } from './transcript-watcher'
import type { WsClient } from './ws-client'

export interface WrapperContext {
  // Identity
  readonly internalId: string
  readonly cwd: string

  // Mode flags (immutable after startup)
  readonly headless: boolean
  readonly channelEnabled: boolean
  readonly noConcentrator: boolean

  // Mutable session state
  claudeSessionId: string | null
  pendingClearFromId: string | null
  clearRequested: boolean
  terminalAttached: boolean
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
  readonly agentToolUseMap: Map<string, string>
  readonly pendingAskRequests: Map<string, { requestId: string; questions: unknown[] }>

  // Event queue
  readonly eventQueue: HookEvent[]

  // Diagnostics
  readonly diagBuffer: Array<{ t: number; type: string; msg: string; args?: unknown }>
  diagFlushTimer: ReturnType<typeof setTimeout> | null

  // Functions provided by index.ts
  diag: (type: string, msg: string, args?: unknown) => void
  flushDiag: () => void
  debug: (msg: string) => void
  connectToConcentrator: (sessionId: string) => void
  startTaskWatching: () => void
  startProjectWatching: () => void
  startTranscriptWatcher: (transcriptPath: string) => void
  startSubagentWatcher: (agentId: string, transcriptPath: string, live: boolean) => void
  stopSubagentWatcher: (agentId: string) => void
  sendTranscriptEntriesChunked: (entries: TranscriptEntry[], isInitial: boolean, agentId?: string) => void
}
