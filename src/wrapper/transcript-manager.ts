/**
 * Transcript Manager
 * Handles transcript watcher lifecycle, chunked sending, edit patch augmentation,
 * TodoWrite interception, background task output watching, and subagent watchers.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { structuredPatch as computeStructuredPatch } from 'diff'
import type { TaskInfo, TasksUpdate, TranscriptEntry } from '../shared/protocol'
import { debug as _debug, DEBUG } from './debug'
import { createTranscriptWatcher } from './transcript-watcher'
import type { WrapperContext } from './wrapper-context'

const debug = (msg: string) => _debug(msg)

const TRANSCRIPT_CHUNK_SIZE = 50 // entries per chunk (was 200 -- smaller to avoid oversized WS frames)
const MAX_SUBAGENT_WATCHERS = 50
const MAX_BG_TASK_WATCHERS = 50

/**
 * Augment entries with structuredPatch for Edit diffs.
 * Two paths: (1) JSONL entries already have toolUseResult.oldString/newString -> compute directly
 * (2) Stream entries: assistant has tool_use.input, user has tool_result -> cache input, apply on result
 */
export function augmentEditPatches(ctx: WrapperContext, entries: TranscriptEntry[]): TranscriptEntry[] {
  for (const entry of entries) {
    const e = entry as Record<string, unknown>

    // Path 1: toolUseResult with oldString/newString -- recompute structuredPatch with
    // proper file line numbers using originalFile when available
    const tur = e.toolUseResult as Record<string, unknown> | undefined
    if (tur?.oldString && tur?.newString) {
      try {
        const oldStr = tur.oldString as string
        const newStr = tur.newString as string
        const originalFile = tur.originalFile as string | undefined
        if (originalFile) {
          // Diff the full file: original vs original-with-edit-applied
          const modifiedFile = originalFile.replace(oldStr, newStr)
          const patch = computeStructuredPatch('file', 'file', originalFile, modifiedFile, '', '', { context: 3 })
          if (patch.hunks.length > 0) tur.structuredPatch = patch.hunks
        } else if (!tur.structuredPatch) {
          // No original file -- fall back to snippet diff (oldStart: 1)
          const patch = computeStructuredPatch('file', 'file', oldStr, newStr, '', '', { context: 3 })
          if (patch.hunks.length > 0) tur.structuredPatch = patch.hunks
        }
      } catch {}
      continue
    }

    // Path 2a: assistant entry with Edit tool_use -> cache old_string/new_string
    const msg = (e as { message?: { content?: unknown[] } }).message
    if (entry.type === 'assistant' && Array.isArray(msg?.content)) {
      for (const block of msg.content as Record<string, unknown>[]) {
        if (block.type === 'tool_use' && block.name === 'Edit' && block.id) {
          const input = block.input as Record<string, unknown> | undefined
          if (input?.old_string && input?.new_string) {
            ctx.pendingEditInputs.set(block.id as string, {
              oldString: input.old_string as string,
              newString: input.new_string as string,
            })
          }
        }
      }
    }

    // Path 2b: user entry with tool_result -> look up cached input, compute patch
    if (entry.type === 'user' && Array.isArray(msg?.content)) {
      for (const block of msg.content as Record<string, unknown>[]) {
        if (block.type === 'tool_result' && block.tool_use_id && !block.is_error) {
          const cached = ctx.pendingEditInputs.get(block.tool_use_id as string)
          if (cached) {
            ctx.pendingEditInputs.delete(block.tool_use_id as string)
            try {
              const patch = computeStructuredPatch('file', 'file', cached.oldString, cached.newString, '', '', {
                context: 3,
              })
              if (patch.hunks.length > 0) {
                // Attach to toolUseResult (create if missing)
                if (!e.toolUseResult) e.toolUseResult = {}
                ;(e.toolUseResult as Record<string, unknown>).structuredPatch = patch.hunks
              }
            } catch {}
          }
        }
      }
    }
  }
  return entries
}

/**
 * Scan transcript entries for TodoWrite tool_use blocks and synthesize
 * them into tasks_update WS messages (same format as CC's native tasks).
 */
export function interceptTodoWrite(ctx: WrapperContext, entries: TranscriptEntry[]) {
  if (!ctx.claudeSessionId || !ctx.wsClient?.isConnected()) return
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const msg = (entry as Record<string, unknown>).message as Record<string, unknown> | undefined
    const content = msg?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_use' || block.name !== 'TodoWrite') continue
      const input = block.input as { todos?: Array<{ content: string; status: string; activeForm?: string }> }
      if (!Array.isArray(input?.todos)) continue
      const STATUS_MAP: Record<string, TaskInfo['status']> = {
        pending: 'pending',
        in_progress: 'in_progress',
        completed: 'completed',
      }
      const tasks: TaskInfo[] = input.todos.map((todo, i) => ({
        id: `todo-${i}`,
        subject: todo.content,
        description: todo.activeForm,
        status: STATUS_MAP[todo.status] || 'pending',
        updatedAt: Date.now(),
      }))
      const msg: TasksUpdate = { type: 'tasks_update', sessionId: ctx.claudeSessionId, tasks }
      ctx.wsClient?.send(msg)
      debug(`TodoWrite intercepted: ${tasks.length} items -> tasks_update`)
    }
  }
}

/**
 * Send transcript entries to concentrator in fixed-size chunks.
 */
export function sendTranscriptEntriesChunked(
  ctx: WrapperContext,
  entries: TranscriptEntry[],
  isInitial: boolean,
  agentId?: string,
) {
  if (!ctx.claudeSessionId || !ctx.wsClient?.isConnected()) {
    debug(`Cannot send ${entries.length} entries: sessionId=${!!ctx.claudeSessionId} ws=${ctx.wsClient?.isConnected()}`)
    return
  }
  // Intercept TodoWrite tool calls and synthesize as tasks
  if (!agentId) interceptTodoWrite(ctx, entries)

  // Augment Edit tool results with structuredPatch for diff rendering
  const augmented = augmentEditPatches(ctx, entries)
  const send = (chunk: TranscriptEntry[], initial: boolean) =>
    agentId
      ? ctx.wsClient?.sendSubagentTranscript(agentId, chunk, initial)
      : ctx.wsClient?.sendTranscriptEntries(chunk, initial)

  // Split into fixed-size chunks to avoid oversized WS frames
  for (let i = 0; i < augmented.length; i += TRANSCRIPT_CHUNK_SIZE) {
    const chunk = augmented.slice(i, i + TRANSCRIPT_CHUNK_SIZE)
    send(chunk, isInitial && i === 0)
  }
}

function extractEntryText(entry: TranscriptEntry): string {
  const content = (entry as Record<string, unknown>).message
    ? ((entry as Record<string, unknown>).message as Record<string, unknown>)?.content
    : undefined
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c: unknown) => typeof c === 'string' || (c as Record<string, unknown>)?.type === 'text')
    .map((c: unknown) => (typeof c === 'string' ? c : (c as Record<string, string>).text))
    .join('')
}

// Watch a background task .output file and stream chunks to concentrator
export function startBgTaskOutputWatcher(ctx: WrapperContext, taskId: string, outputPath: string) {
  if (ctx.bgTaskOutputWatchers.has(taskId)) return

  // Evict oldest bg task watcher if at capacity
  if (ctx.bgTaskOutputWatchers.size >= MAX_BG_TASK_WATCHERS) {
    const oldest = ctx.bgTaskOutputWatchers.keys().next().value
    if (oldest) {
      debug(`BG task watcher limit (${MAX_BG_TASK_WATCHERS}) reached, evicting: ${oldest}`)
      ctx.bgTaskOutputWatchers.get(oldest)?.stop()
    }
  }

  ctx.diag('bgout', `Watching output for bg task ${taskId}`, { taskId, outputPath })

  let offset = 0
  let totalBytes = 0
  let stopped = false
  let retries = 0
  const MAX_RETRIES = 20 // 20 x 500ms = 10s max wait for file to appear

  async function readChunk() {
    if (stopped || !ctx.wsClient?.isConnected()) return
    try {
      const file = Bun.file(outputPath)
      const size = file.size
      if (size > offset) {
        const slice = file.slice(offset, size)
        const text = await slice.text()
        offset = size
        totalBytes += text.length
        if (text) {
          ctx.wsClient?.sendBgTaskOutput(taskId, text, false)
        }
      }
    } catch {
      // File might not exist yet
      if (retries++ < MAX_RETRIES) return // will retry on next poll
      ctx.diag('bgout', 'Gave up waiting for output file', { taskId, retries: MAX_RETRIES })
      stopWatcher()
    }
  }

  // Poll every 500ms - simple and reliable for output files
  const interval = setInterval(readChunk, 500)

  function stopWatcher() {
    if (stopped) return
    stopped = true
    clearInterval(interval)
    ctx.bgTaskOutputWatchers.delete(taskId)
    // Do a final read to catch any remaining output
    readChunk().then(() => {
      if (ctx.wsClient?.isConnected()) {
        ctx.wsClient.sendBgTaskOutput(taskId, '', true)
      }
      ctx.diag('bgout', 'Watcher stopped', { taskId, totalBytes })
    })
  }

  ctx.bgTaskOutputWatchers.set(taskId, { stop: stopWatcher })
}

// Scan transcript entries for background task IDs and start output watchers
export function scanForBgTasks(ctx: WrapperContext, entries: TranscriptEntry[]) {
  for (const entry of entries) {
    const tur = (entry as Record<string, unknown>).toolUseResult as Record<string, unknown> | undefined
    if (!tur?.backgroundTaskId) continue
    const taskId = tur.backgroundTaskId as string
    if (ctx.bgTaskOutputWatchers.has(taskId)) continue

    const text = extractEntryText(entry)
    const pathMatch = text.match(/Output is being written to: (\S+\.output)/)
    if (pathMatch) {
      startBgTaskOutputWatcher(ctx, taskId, pathMatch[1])
    } else {
      debug(`[bgout] Found backgroundTaskId ${taskId} but no output path in content`)
    }
  }

  // Also check for task completions to stop watchers
  for (const entry of entries) {
    const text = extractEntryText(entry)
    if (!text.includes('<task-notification>')) continue
    const re = /<task-id>([^<]+)<\/task-id>/g
    let match: RegExpExecArray | null = re.exec(text)
    while (match !== null) {
      const watcher = ctx.bgTaskOutputWatchers.get(match[1])
      if (watcher) {
        ctx.diag('bgout', 'Task completed, stopping watcher', { taskId: match[1] })
        watcher.stop()
      }
      match = re.exec(text)
    }
  }
}

/**
 * Start the main transcript watcher for a JSONL file.
 */
export function startTranscriptWatcher(ctx: WrapperContext, transcriptPath: string) {
  if (ctx.headless) {
    debug('Skipping transcript watcher in headless mode (data comes from stdout stream)')
    return
  }
  if (ctx.transcriptWatcher) {
    debug('Transcript watcher already running, skipping')
    return
  }

  ctx.transcriptWatcher = createTranscriptWatcher({
    debug: DEBUG ? (msg: string) => debug(`[tw] ${msg}`) : undefined,
    onEntries(entries, isInitial) {
      sendTranscriptEntriesChunked(ctx, entries, isInitial)
      // Scan for background tasks to watch their output files
      scanForBgTasks(ctx, entries)
    },
    onNewFile(filename) {
      ctx.diag('watch', 'New transcript file detected', { filename })
    },
    onError(err) {
      debug(`Transcript watcher error: ${err.message}`)
    },
  })

  ctx.transcriptWatcher
    .start(transcriptPath)
    .then(() => {
      ctx.diag('watch', 'Transcript watcher started', transcriptPath)
    })
    .catch(err => {
      ctx.diag('error', 'Transcript watcher failed to start', { path: transcriptPath, error: String(err) })
    })
}

/**
 * Start a subagent transcript watcher. If live=true, watches for new entries;
 * if live=false, reads the complete file once and closes.
 */
export function startSubagentWatcher(ctx: WrapperContext, agentId: string, transcriptPath: string, live: boolean) {
  // Subagent transcripts are separate files even in headless mode -
  // agent output does NOT appear inline in the parent stdout stream
  if (ctx.subagentWatchers.has(agentId)) return

  // Evict oldest live watchers if at capacity (prevents unbounded growth if SubagentStop never fires)
  if (ctx.subagentWatchers.size >= MAX_SUBAGENT_WATCHERS) {
    const oldest = ctx.subagentWatchers.keys().next().value
    if (oldest) {
      debug(`Subagent watcher limit (${MAX_SUBAGENT_WATCHERS}) reached, evicting: ${oldest.slice(0, 7)}`)
      const evicted = ctx.subagentWatchers.get(oldest)
      evicted?.stop()
      ctx.subagentWatchers.delete(oldest)
    }
  }

  const watcher = createTranscriptWatcher({
    debug: DEBUG ? (msg: string) => debug(`[tw:${agentId.slice(0, 7)}] ${msg}`) : undefined,
    onEntries(entries, isInitial) {
      if (ctx.claudeSessionId && ctx.wsClient?.isConnected()) {
        sendTranscriptEntriesChunked(ctx, entries, isInitial, agentId)
        debug(`Sent ${entries.length} subagent transcript entries for ${agentId.slice(0, 7)} (live=${live})`)
      }
    },
    onError(err) {
      debug(`Subagent watcher error (${agentId.slice(0, 7)}): ${err.message}`)
    },
  })

  ctx.subagentWatchers.set(agentId, watcher)
  watcher
    .start(transcriptPath)
    .then(() => {
      if (!live) {
        // Non-live (SubagentStop): file is complete, read once and close
        watcher.stop()
        ctx.subagentWatchers.delete(agentId)
        debug(`Subagent transcript read complete, watcher closed: ${agentId.slice(0, 7)}`)
      }
      // Live mode: keep watching via chokidar for new entries
    })
    .catch(err => {
      debug(`Failed to start subagent watcher: ${err}`)
    })
  debug(`${live ? 'Live watching' : 'Reading'} subagent transcript: ${agentId.slice(0, 7)}`)
}

export function stopSubagentWatcher(ctx: WrapperContext, agentId: string) {
  const watcher = ctx.subagentWatchers.get(agentId)
  if (watcher) {
    watcher.stop()
    ctx.subagentWatchers.delete(agentId)
    debug(`Stopped live subagent watcher: ${agentId.slice(0, 7)}`)
  }
}
