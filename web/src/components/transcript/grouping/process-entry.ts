/**
 * Per-entry classifier shared by groupEntries (batch) and useIncrementalGroups
 * (incremental). Both originally inlined the same ~200-line switch over entry
 * types -- this collapses that duplication into one named function with a
 * sub-handler per group type.
 *
 * processEntry mutates `state.groups`, `state.current`, and
 * `state.pendingSkillName`. Returning void keeps the call sites tight at both
 * callers (one `processEntry(entry, state)` per loop iteration).
 */
import type { TranscriptAssistantEntry, TranscriptEntry, TranscriptUserEntry } from '@/lib/types'
import { extractSkillName, isQueue, isSkillContent, parseTaskNotifications } from './parsers'
import type { DisplayGroup, GroupingState } from './types'

function handleBoot(entry: TranscriptEntry, state: GroupingState): void {
  const last = state.groups[state.groups.length - 1]
  if (last?.type === 'boot') {
    last.entries.push(entry)
  } else {
    state.current = null
    state.groups.push({ type: 'boot', timestamp: entry.timestamp || '', entries: [entry] })
  }
}

function handleLaunch(entry: TranscriptEntry, state: GroupingState): void {
  // Collect entries by launchId. A single /clear produces steps spread across
  // time (killed -> mcp_reset -> ... -> ready) and we want them all in one
  // card, but a subsequent reboot gets its own card.
  const launchId = (entry as { launchId: string }).launchId
  const last = state.groups[state.groups.length - 1]
  const lastLaunchId = (last?.entries[0] as { launchId?: string } | undefined)?.launchId
  if (last?.type === 'launch' && lastLaunchId === launchId) {
    last.entries.push(entry)
  } else {
    state.current = null
    state.groups.push({ type: 'launch', timestamp: entry.timestamp || '', entries: [entry] })
  }
}

function handleCompact(entry: TranscriptEntry, state: GroupingState): void {
  state.current = null
  // When compacted arrives, replace the preceding compacting group
  if (
    entry.type === 'compacted' &&
    state.groups.length > 0 &&
    state.groups[state.groups.length - 1].type === 'compacting'
  ) {
    state.groups[state.groups.length - 1] = {
      type: 'compacted',
      timestamp: entry.timestamp || '',
      entries: [entry],
    }
  } else {
    state.groups.push({
      type: entry.type as 'compacting' | 'compacted',
      timestamp: entry.timestamp || '',
      entries: [entry],
    })
  }
}

// queue-operation: enqueue = user interject, remove = consumed by Claude.
// enqueue creates a queued user group; remove clears the queued flag on
// the most recent queued group (FIFO - multiple enqueues, bulk remove).
function handleQueue(entry: TranscriptEntry, state: GroupingState): void {
  if (!isQueue(entry)) return
  if (entry.operation === 'enqueue' && entry.content) {
    // Task-notifications are enqueued too but shouldn't float as queued.
    // They're fire-and-forget system notifications - render inline immediately.
    // Their dequeue entries may never arrive (different consumption path).
    if (entry.content.startsWith('<task-notification>')) {
      const notifications = parseTaskNotifications(entry.content)
      if (notifications.length > 0) {
        state.current = null
        state.groups.push({
          type: 'system',
          timestamp: entry.timestamp || '',
          entries: [entry],
          notifications,
        })
      }
    } else {
      const synthetic: TranscriptUserEntry = {
        type: 'user',
        timestamp: entry.timestamp,
        message: { role: 'user', content: entry.content },
      }
      state.current = { type: 'user', timestamp: entry.timestamp || '', entries: [synthetic], queued: true }
      state.groups.push(state.current)
    }
  } else if (entry.operation === 'remove' || entry.operation === 'dequeue' || entry.operation === 'popAll') {
    for (const g of state.groups) {
      if (g.queued) {
        g.queued = false
        if (entry.operation !== 'popAll') break
      }
    }
  }
}

// System messages (slash commands, api retries, informational, state changes, etc.)
// Returns true if the entry was handled (incl. silently skipped).
function handleSystem(entry: TranscriptEntry, state: GroupingState): boolean {
  if (entry.type !== 'system' || !(entry as Record<string, unknown>).subtype) return false
  const sub = (entry as Record<string, unknown>).subtype as string
  // Skip internal/noise subtypes
  if (sub === 'file_snapshot' || sub === 'post_turn_summary') return true
  // Skip subagent task progress/notification -- belong in agent transcript, not parent
  if (sub === 'task_progress' || sub === 'task_notification') return true
  // CC emits system/status as a per-API-request activity heartbeat (apiStatus
  // + permissionMode). Already converted to dedicated wire signals
  // (sendConversationStatus('active'), plan_mode_changed) at the agent host.
  // The raw entry still flows to the broker and is persisted -- visible in
  // events log + JsonInspector -- but pure noise in the transcript view.
  if (sub === 'status') return true

  const content = (entry as Record<string, unknown>).content as string | undefined
  // Skip raw slash command input entries (the output entry has the useful info)
  if (sub === 'local_command' && content?.includes('<command-name>')) return true

  // Inline into the current assistant run if active. Without this, every
  // system blip (api_retry, turn_duration, informational, etc.) splits a
  // run of tool calls into one-robot-per-call by resetting state.current.
  // Folding the entry into state.current.entries keeps a single avatar +
  // timestamp header while preserving timeline order -- the renderer
  // walks entries in order and emits an inline 'system' RenderItem for
  // each system entry it encounters in an assistant group.
  //
  // away_summary is the one exception: it renders as a full-width bordered
  // recap card that would look wrong nested inside an assistant body, so
  // it always gets its own group.
  if (state.current?.type === 'assistant' && sub !== 'away_summary') {
    state.current.entries.push(entry)
    return true
  }

  state.current = null
  state.groups.push({
    type: 'system',
    timestamp: entry.timestamp || '',
    entries: [entry],
    ...(sub === 'local_command' && content ? { localCommandOutput: content } : {}),
    systemSubtype: sub,
  })
  return true
}

// Returns true when the user entry was handled (via skip, dedup, skill, or
// notification path). Caller falls through to assistant/user merge logic when
// false.
function handleUser(entry: TranscriptEntry, state: GroupingState): boolean {
  if (entry.type !== 'user') return false
  const userEntry = entry as TranscriptUserEntry
  const content = userEntry.message?.content

  if (Array.isArray(content)) {
    // Capture skill name from Skill tool_result before skipping (Path A)
    if (content.some(c => c.type === 'tool_result')) {
      const name = extractSkillName(userEntry)
      if (name) state.pendingSkillName = name
      return true
    }
  }

  const textContent =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('')
        : ''

  // CC injects blocked-hook feedback (a Stop/SubagentStop hook's `reason`) as a
  // plain user entry whose first text block is "<Event> hook feedback:\n
  // <reason>". It is NOT flagged isMeta, and the content arrives as a text-block
  // array, not a string -- so match the extracted textContent. The trailing \n
  // anchor keeps a real user message that merely opens with the phrase (no
  // newline) from being caught. Hook machinery, not a user turn -> system line.
  if (/^[A-Za-z]+ hook feedback:\n/.test(textContent.trimStart())) {
    state.current = null
    state.groups.push({
      type: 'system',
      timestamp: entry.timestamp || '',
      entries: [entry],
      systemSubtype: 'hook_feedback',
    })
    return true
  }

  // Deduplicate: queue-operation enqueue creates a synthetic user group,
  // then the real user entry arrives with the same text. The synthetic has
  // no uuid (created by us), while real entries have one. Replace synthetic
  // with real to avoid showing the message twice.
  if (textContent) {
    for (let gi = state.groups.length - 1; gi >= 0; gi--) {
      const g = state.groups[gi]
      if (g.type !== 'user') continue
      const synth = g.entries[0] as unknown as Record<string, unknown> | undefined
      if (synth && !synth.uuid) {
        const synthMsg = synth as unknown as TranscriptUserEntry
        const synthText = typeof synthMsg.message?.content === 'string' ? synthMsg.message.content : undefined
        if (synthText === textContent) {
          state.groups.splice(gi, 1)
          // Reset current if it pointed at the spliced group
          if (state.current === g) state.current = null
          break
        }
      }
      break // only check the most recent user group
    }
  }

  if (textContent.includes('<system-reminder>')) return true
  if (
    textContent.includes('<command-name>') ||
    textContent.includes('<local-command-caveat>') ||
    textContent.includes('<local-command-stdout>')
  ) {
    // Capture skill name from /slash command before skipping (Path B)
    const name = extractSkillName(userEntry)
    if (name) state.pendingSkillName = name
    return true
  }

  // Detect skill content injection (the big markdown dump after Skill tool or /slash command)
  if (isSkillContent(userEntry) && state.pendingSkillName) {
    state.current = null
    state.groups.push({
      type: 'skill',
      timestamp: entry.timestamp || '',
      entries: [entry],
      skillName: state.pendingSkillName,
    })
    state.pendingSkillName = undefined
    return true
  }
  state.pendingSkillName = undefined

  if (textContent.includes('<task-notification>')) {
    const notifications = parseTaskNotifications(textContent)
    if (notifications.length > 0) {
      // Dedup: queue-operation enqueue already created a system group with same notifications
      const prevSystem = state.groups[state.groups.length - 1]
      const isDuplicate =
        prevSystem?.type === 'system' &&
        prevSystem.notifications?.length === notifications.length &&
        notifications.every(n => prevSystem.notifications?.some(p => p.taskId === n.taskId && p.status === n.status))
      if (!isDuplicate) {
        state.current = null
        state.groups.push({
          type: 'system',
          timestamp: entry.timestamp || '',
          entries: [entry],
          notifications,
        })
      }
      return true
    }
  }
  return false
}

// Merge a user-or-assistant entry into the current run-of-same-type group.
// Pre-filters empty / noise content blocks.
function mergeMessageEntry(entry: TranscriptEntry, state: GroupingState): void {
  const msgEntry = entry as TranscriptUserEntry | TranscriptAssistantEntry
  const content = msgEntry.message?.content

  if (Array.isArray(content)) {
    const hasContent = content.some(
      c =>
        (c.type === 'text' && c.text?.trim()) ||
        (c.type === 'thinking' && (c.thinking?.trim() || c.text?.trim() || c.signature)) ||
        c.type === 'tool_use',
    )
    if (!hasContent) return
  }

  const type = entry.type as 'user' | 'assistant'
  if (state.current && state.current.type === type) {
    state.current.entries.push(entry)
  } else {
    state.current = { type, timestamp: entry.timestamp || '', entries: [entry] }
    state.groups.push(state.current)
  }
}

/**
 * Apply one entry to the grouping state. Mutates state.
 *
 * Order of checks mirrors the original inline switch in groupEntries; do not
 * reorder without updating both callers + the tests covering grouping.
 */
export function processEntry(entry: TranscriptEntry, state: GroupingState): void {
  if (entry.type === 'boot') {
    handleBoot(entry, state)
    return
  }
  if (entry.type === 'launch') {
    handleLaunch(entry, state)
    return
  }
  if (entry.type === 'spawn_notification') {
    state.current = null
    state.groups.push({ type: 'spawn_notification', timestamp: entry.timestamp || '', entries: [entry] })
    return
  }
  if (entry.type === 'compacting' || entry.type === 'compacted') {
    handleCompact(entry, state)
    return
  }
  if (isQueue(entry)) {
    handleQueue(entry, state)
    return
  }
  if (handleSystem(entry, state)) return

  if (entry.type !== 'user' && entry.type !== 'assistant') return
  const msgEntry = entry as TranscriptUserEntry | TranscriptAssistantEntry
  const content = msgEntry.message?.content
  if (!content) return

  if (handleUser(entry, state)) return

  if (typeof content === 'string' && !content.trim()) return

  mergeMessageEntry(entry, state)
}

/**
 * Tag every group between EnterPlanMode and ExitPlanMode tool-use blocks with
 * `planMode = true`. Run after all entries are grouped.
 */
export function applyPlanModeTags(groups: DisplayGroup[]): void {
  let pm = false
  for (const g of groups) {
    for (const e of g.entries) {
      const blocks = (e as Record<string, unknown>).message
        ? ((e as Record<string, unknown>).message as Record<string, unknown>)?.content
        : undefined
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b.type === 'tool_use' && b.name === 'EnterPlanMode') pm = true
          if (b.type === 'tool_use' && b.name === 'ExitPlanMode') pm = false
        }
      }
    }
    if (pm) g.planMode = true
  }
}
