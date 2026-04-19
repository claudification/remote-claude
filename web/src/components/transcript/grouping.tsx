/**
 * Transcript grouping logic: builds display groups from raw transcript entries.
 * Handles result mapping, task notifications, incremental grouping, and entry filtering.
 */

import { useCallback, useMemo, useRef } from 'react'
import { record } from '@/lib/perf-metrics'
import type { TranscriptAssistantEntry, TranscriptEntry, TranscriptQueueEntry, TranscriptUserEntry } from '@/lib/types'

function isUser(e: TranscriptEntry): e is TranscriptUserEntry {
  return e.type === 'user'
}

function isQueue(e: TranscriptEntry): e is TranscriptQueueEntry {
  return e.type === 'queue-operation'
}

export interface TaskNotification {
  taskId: string
  summary: string
  status: 'completed' | 'failed' | 'killed' | string
  result?: string
  toolUseId?: string
  outputFile?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
}

export interface DisplayGroup {
  type: 'user' | 'assistant' | 'system' | 'compacting' | 'compacted' | 'skill' | 'boot' | 'launch'
  timestamp: string
  entries: TranscriptEntry[]
  notifications?: TaskNotification[]
  localCommandOutput?: string
  systemSubtype?: string // system message subtype (api_retry, informational, etc.)
  queued?: boolean // user interject waiting to be consumed
  skillName?: string // skill/command name for 'skill' groups
  planMode?: boolean // entries produced while session was in plan mode
}

// Build map of tool_use_id -> result
export function buildResultMap(entries: TranscriptEntry[]) {
  const map = new Map<string, { result: string; extra?: Record<string, unknown>; isError?: boolean }>()
  for (const entry of entries) {
    if (!isUser(entry)) continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        map.set(block.tool_use_id, {
          result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          extra: entry.toolUseResult as Record<string, unknown> | undefined,
          isError: block.is_error === true,
        })
      }
    }
  }
  return map
}

// Parse <task-notification> XML into structured data using DOMParser
function parseTaskNotifications(text: string): TaskNotification[] {
  const results: TaskNotification[] = []
  const blockRegex = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g
  let blockMatch: RegExpExecArray | null = blockRegex.exec(text)
  while (blockMatch !== null) {
    const xml = `<root>${blockMatch[1]}</root>`
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml')
      const taskId = doc.querySelector('task-id')?.textContent?.trim() || ''
      const status = doc.querySelector('status')?.textContent?.trim() || ''
      const summary = doc.querySelector('summary')?.textContent?.trim() || ''
      const result = doc.querySelector('result')?.textContent?.trim() || undefined
      const toolUseId = doc.querySelector('tool-use-id')?.textContent?.trim() || undefined
      const outputFile = doc.querySelector('output-file')?.textContent?.trim() || undefined

      // Parse usage block: <usage><total_tokens>N</total_tokens><tool_uses>N</tool_uses><duration_ms>N</duration_ms></usage>
      let usage: TaskNotification['usage']
      const usageEl = doc.querySelector('usage')
      if (usageEl) {
        const totalTokens = Number.parseInt(usageEl.querySelector('total_tokens')?.textContent || '0', 10)
        const toolUses = Number.parseInt(usageEl.querySelector('tool_uses')?.textContent || '0', 10)
        const durationMs = Number.parseInt(usageEl.querySelector('duration_ms')?.textContent || '0', 10)
        if (totalTokens || toolUses || durationMs) {
          usage = { totalTokens, toolUses, durationMs }
        }
      }

      if (taskId || summary) {
        results.push({ taskId, status, summary, result, toolUseId, outputFile, usage })
      }
    } catch {
      // Malformed XML - skip
    }
    blockMatch = blockRegex.exec(text)
  }
  return results
}

// Extract skill/command name from a user entry that precedes skill content injection.
// Path A: tool_result with toolUseResult.commandName (Skill tool)
// Path B: <command-message>name</command-message> (direct /slash command)
function extractSkillName(entry: TranscriptUserEntry): string | undefined {
  const extra = entry.toolUseResult as Record<string, unknown> | undefined
  if (extra?.commandName) return extra.commandName as string
  const text = typeof entry.message?.content === 'string' ? entry.message.content : ''
  const match = text.match(/<command-message>([^<]+)<\/command-message>/)
  return match?.[1]
}

// Detect if a user entry is a skill content injection (the big markdown dump)
function isSkillContent(entry: TranscriptUserEntry): boolean {
  if (!entry.isMeta) return false
  const content = entry.message?.content
  if (Array.isArray(content)) {
    const text = content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('')
    return text.length > 300 && (!!entry.sourceToolUseID || text.startsWith('#') || text.startsWith('Base directory'))
  }
  return false
}

// Group consecutive entries by role, filtering out noise
export function groupEntries(entries: TranscriptEntry[]): DisplayGroup[] {
  const groups: DisplayGroup[] = []
  let current: DisplayGroup | null = null
  let pendingSkillName: string | undefined

  for (const entry of entries) {
    if (entry.type === 'boot') {
      // Collect consecutive boot entries into a single timeline group.
      const lastGroup = groups[groups.length - 1]
      if (lastGroup?.type === 'boot') {
        lastGroup.entries.push(entry)
      } else {
        current = null
        groups.push({
          type: 'boot',
          timestamp: entry.timestamp || '',
          entries: [entry],
        })
      }
      continue
    }

    if (entry.type === 'launch') {
      // Collect entries by launchId. A single /clear produces steps spread
      // across time (killed -> mcp_reset -> ... -> ready) and we want them
      // all in one card, but a subsequent reboot gets its own card.
      const launchId = (entry as { launchId: string }).launchId
      const lastGroup = groups[groups.length - 1]
      const lastLaunchId = (lastGroup?.entries[0] as { launchId?: string } | undefined)?.launchId
      if (lastGroup?.type === 'launch' && lastLaunchId === launchId) {
        lastGroup.entries.push(entry)
      } else {
        current = null
        groups.push({
          type: 'launch',
          timestamp: entry.timestamp || '',
          entries: [entry],
        })
      }
      continue
    }

    if (entry.type === 'compacting' || entry.type === 'compacted') {
      current = null
      // When compacted arrives, replace the preceding compacting group
      if (entry.type === 'compacted' && groups.length > 0 && groups[groups.length - 1].type === 'compacting') {
        groups[groups.length - 1] = {
          type: 'compacted',
          timestamp: entry.timestamp || '',
          entries: [entry],
        }
      } else {
        groups.push({
          type: entry.type as 'compacting' | 'compacted',
          timestamp: entry.timestamp || '',
          entries: [entry],
        })
      }
      continue
    }

    // queue-operation: enqueue = user interject, remove = consumed by Claude.
    // enqueue creates a queued user group; remove clears the queued flag on
    // the most recent queued group (FIFO - multiple enqueues, bulk remove).
    if (isQueue(entry)) {
      if (entry.operation === 'enqueue' && entry.content) {
        // Task-notifications are enqueued too but shouldn't float as queued.
        // They're fire-and-forget system notifications - render inline immediately.
        // Their dequeue entries may never arrive (different consumption path).
        if (entry.content.startsWith('<task-notification>')) {
          const notifications = parseTaskNotifications(entry.content)
          if (notifications.length > 0) {
            current = null
            groups.push({
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
          current = { type: 'user', timestamp: entry.timestamp || '', entries: [synthetic], queued: true }
          groups.push(current)
        }
      } else if (entry.operation === 'remove' || entry.operation === 'dequeue' || entry.operation === 'popAll') {
        for (const g of groups) {
          if (g.queued) {
            g.queued = false
            if (entry.operation !== 'popAll') break
          }
        }
      }
      continue
    }

    // System messages (slash commands, api retries, informational, state changes, etc.)
    if (entry.type === 'system' && (entry as Record<string, unknown>).subtype) {
      const sub = (entry as Record<string, unknown>).subtype as string
      // Skip internal/noise subtypes
      if (sub === 'file_snapshot' || sub === 'post_turn_summary') continue
      // Skip subagent task progress/notification -- these belong in the agent transcript, not parent
      if (sub === 'task_progress' || sub === 'task_notification') continue
      current = null
      const content = (entry as Record<string, unknown>).content as string | undefined
      // Skip raw slash command input entries (the output entry has the useful info)
      if (sub === 'local_command' && content?.includes('<command-name>')) continue
      groups.push({
        type: 'system',
        timestamp: entry.timestamp || '',
        entries: [entry],
        ...(sub === 'local_command' && content ? { localCommandOutput: content } : {}),
        systemSubtype: sub,
      })
      continue
    }

    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    const msgEntry = entry as TranscriptUserEntry | TranscriptAssistantEntry
    const content = msgEntry.message?.content
    if (!content) continue

    if (entry.type === 'user' && Array.isArray(content)) {
      // Capture skill name from Skill tool_result before skipping (Path A)
      if (content.some(c => c.type === 'tool_result')) {
        const name = extractSkillName(entry as TranscriptUserEntry)
        if (name) pendingSkillName = name
        continue
      }
    }
    if (typeof content === 'string' && !content.trim()) continue

    if (entry.type === 'user') {
      const textContent =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join('')
            : ''

      // Deduplicate: queue-operation enqueue creates a synthetic user group,
      // then the real user entry arrives with the same text. The synthetic has
      // no uuid (created by us), while real entries have one. Replace synthetic
      // with real to avoid showing the message twice.
      if (textContent) {
        for (let gi = groups.length - 1; gi >= 0; gi--) {
          const g = groups[gi]
          if (g.type !== 'user') continue
          const synth = g.entries[0] as unknown as Record<string, unknown> | undefined
          if (synth && !synth.uuid) {
            const synthMsg = synth as unknown as TranscriptUserEntry
            const synthText = typeof synthMsg.message?.content === 'string' ? synthMsg.message.content : undefined
            if (synthText === textContent) {
              groups.splice(gi, 1)
              // Reset current if it pointed at the spliced group
              if (current === g) current = null
              break
            }
          }
          break // only check the most recent user group
        }
      }

      if (textContent.includes('<system-reminder>')) continue
      if (
        textContent.includes('<command-name>') ||
        textContent.includes('<local-command-caveat>') ||
        textContent.includes('<local-command-stdout>')
      ) {
        // Capture skill name from /slash command before skipping (Path B)
        const name = extractSkillName(entry as TranscriptUserEntry)
        if (name) pendingSkillName = name
        continue
      }

      // Detect skill content injection (the big markdown dump after Skill tool or /slash command)
      if (isSkillContent(entry as TranscriptUserEntry) && pendingSkillName) {
        current = null
        groups.push({
          type: 'skill',
          timestamp: entry.timestamp || '',
          entries: [entry],
          skillName: pendingSkillName,
        })
        pendingSkillName = undefined
        continue
      }
      pendingSkillName = undefined
      if (textContent.includes('<task-notification>')) {
        const notifications = parseTaskNotifications(textContent)
        if (notifications.length > 0) {
          // Dedup: queue-operation enqueue already created a system group with same notifications
          const prevSystem = groups[groups.length - 1]
          const isDuplicate =
            prevSystem?.type === 'system' &&
            prevSystem.notifications?.length === notifications.length &&
            notifications.every(n =>
              prevSystem.notifications?.some(p => p.taskId === n.taskId && p.status === n.status),
            )
          if (!isDuplicate) {
            current = null
            groups.push({
              type: 'system',
              timestamp: entry.timestamp || '',
              entries: [entry],
              notifications,
            })
          }
          continue
        }
      }
    }

    if (Array.isArray(content)) {
      const hasContent = content.some(
        c =>
          (c.type === 'text' && c.text?.trim()) ||
          (c.type === 'thinking' && (c.thinking?.trim() || c.text?.trim() || c.signature)) ||
          c.type === 'tool_use',
      )
      if (!hasContent) continue
    }

    const type = entry.type as 'user' | 'assistant'
    if (current && current.type === type) {
      current.entries.push(entry)
    } else {
      current = { type, timestamp: entry.timestamp || '', entries: [entry] }
      groups.push(current)
    }
  }

  // Tag groups between EnterPlanMode and ExitPlanMode tool calls
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

  return groups
}

// Incremental grouping hook: only processes new entries since last call
// Transcript entries are append-only (except initial load which replaces all)
// IMPORTANT: returns new array/map references each time to avoid mutating
// data that React components are currently rendering (React error #300)
export function useIncrementalGroups(entries: TranscriptEntry[]) {
  const cacheRef = useRef<{
    len: number
    resultMap: Map<string, { result: string; extra?: Record<string, unknown>; isError?: boolean }>
    groups: DisplayGroup[]
    lastGroup: DisplayGroup | null
    pendingSkillName?: string
  }>({ len: 0, resultMap: new Map(), groups: [], lastGroup: null })

  const entriesRef = useRef(entries)
  const groups = useMemo(() => {
    const t0 = performance.now()
    const cache = cacheRef.current

    // Full reset if entries shrunk OR array was replaced entirely (HTTP refetch)
    const isReset = entries.length < cache.len || (entries !== entriesRef.current && entries.length <= cache.len)
    entriesRef.current = entries
    if (isReset) {
      cache.len = 0
      cache.resultMap = new Map()
      cache.groups = []
      cache.lastGroup = null
      cache.pendingSkillName = undefined
    }

    // Nothing new - return stable references
    if (entries.length === cache.len) {
      return cache.groups
    }

    // Process only the new entries
    const newEntries = entries.slice(cache.len)
    cache.len = entries.length

    // Incremental buildResultMap - clone before mutating so existing renders aren't affected
    const newResultMap = new Map(cache.resultMap)
    for (const entry of newEntries) {
      if (!isUser(entry)) continue
      const content = entry.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          newResultMap.set(block.tool_use_id, {
            result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            extra: entry.toolUseResult as Record<string, unknown> | undefined,
            isError: block.is_error === true,
          })
        }
      }
    }
    cache.resultMap = newResultMap

    // Incremental groupEntries - build new array (spread existing + new groups)
    const newGroups = [...cache.groups]
    let lastGroup = cache.lastGroup
    if (lastGroup && newGroups.length > 0) {
      lastGroup = { ...lastGroup, entries: [...lastGroup.entries] }
      newGroups[newGroups.length - 1] = lastGroup
    }

    for (const entry of newEntries) {
      // Boot and launch timeline entries -- same rules as batch grouper.
      // Both the incremental path (here) and the batch `groupEntries` must
      // recognise these or the LaunchTimeline / BootTimeline never renders.
      if (entry.type === 'boot') {
        const prev = newGroups[newGroups.length - 1]
        if (prev?.type === 'boot') {
          prev.entries.push(entry)
        } else {
          lastGroup = null
          newGroups.push({ type: 'boot', timestamp: entry.timestamp || '', entries: [entry] })
        }
        continue
      }

      if (entry.type === 'launch') {
        const launchId = (entry as { launchId?: string }).launchId
        const prev = newGroups[newGroups.length - 1]
        const prevLaunchId = (prev?.entries[0] as { launchId?: string } | undefined)?.launchId
        if (prev?.type === 'launch' && prevLaunchId === launchId) {
          prev.entries.push(entry)
        } else {
          lastGroup = null
          newGroups.push({ type: 'launch', timestamp: entry.timestamp || '', entries: [entry] })
        }
        continue
      }

      if (entry.type === 'compacting' || entry.type === 'compacted') {
        lastGroup = null
        // When compacted arrives, replace the preceding compacting group
        if (
          entry.type === 'compacted' &&
          newGroups.length > 0 &&
          newGroups[newGroups.length - 1].type === 'compacting'
        ) {
          newGroups[newGroups.length - 1] = {
            type: 'compacted',
            timestamp: entry.timestamp || '',
            entries: [entry],
          }
        } else {
          newGroups.push({
            type: entry.type as 'compacting' | 'compacted',
            timestamp: entry.timestamp || '',
            entries: [entry],
          })
        }
        continue
      }

      // queue-operation: enqueue/remove (see batch grouper for full explanation)
      if (isQueue(entry)) {
        if (entry.operation === 'enqueue' && entry.content) {
          if (entry.content.startsWith('<task-notification>')) {
            const notifications = parseTaskNotifications(entry.content)
            if (notifications.length > 0) {
              lastGroup = null
              newGroups.push({
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
            lastGroup = { type: 'user', timestamp: entry.timestamp || '', entries: [synthetic], queued: true }
            newGroups.push(lastGroup)
          }
        } else if (entry.operation === 'remove' || entry.operation === 'dequeue' || entry.operation === 'popAll') {
          for (const g of newGroups) {
            if (g.queued) {
              g.queued = false
              if (entry.operation !== 'popAll') break
            }
          }
        }
        continue
      }

      // System messages (slash commands, api retries, informational, state changes, etc.)
      if (entry.type === 'system' && (entry as Record<string, unknown>).subtype) {
        const sub = (entry as Record<string, unknown>).subtype as string
        if (sub === 'file_snapshot' || sub === 'post_turn_summary') continue
        const lcContent = (entry as Record<string, unknown>).content as string | undefined
        if (sub === 'local_command' && lcContent?.includes('<command-name>')) continue
        lastGroup = null
        newGroups.push({
          type: 'system',
          timestamp: entry.timestamp || '',
          entries: [entry],
          ...(sub === 'local_command' && lcContent ? { localCommandOutput: lcContent } : {}),
          systemSubtype: sub,
        })
        continue
      }

      if (entry.type !== 'user' && entry.type !== 'assistant') continue
      const msgEntry = entry as TranscriptUserEntry | TranscriptAssistantEntry
      const content = msgEntry.message?.content
      if (!content) continue

      if (entry.type === 'user' && Array.isArray(content)) {
        // Capture skill name from Skill tool_result before skipping (Path A)
        if (content.some(c => c.type === 'tool_result')) {
          const name = extractSkillName(entry as TranscriptUserEntry)
          if (name) cache.pendingSkillName = name
          continue
        }
      }
      if (typeof content === 'string' && !content.trim()) continue

      if (entry.type === 'user') {
        const textContent =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .filter(c => c.type === 'text')
                  .map(c => c.text)
                  .join('')
              : ''

        // Deduplicate queue-operation synthetic (same as batch grouper)
        if (textContent) {
          for (let gi = newGroups.length - 1; gi >= 0; gi--) {
            const g = newGroups[gi]
            if (g.type !== 'user') continue
            const synth = g.entries[0] as unknown as Record<string, unknown> | undefined
            if (synth && !synth.uuid) {
              const synthMsg = synth as unknown as TranscriptUserEntry
              const synthText = typeof synthMsg.message?.content === 'string' ? synthMsg.message.content : undefined
              if (synthText === textContent) {
                newGroups.splice(gi, 1)
                if (lastGroup === g) lastGroup = null
                break
              }
            }
            break
          }
        }

        if (textContent.includes('<system-reminder>')) continue
        if (
          textContent.includes('<command-name>') ||
          textContent.includes('<local-command-caveat>') ||
          textContent.includes('<local-command-stdout>')
        ) {
          // Capture skill name from /slash command before skipping (Path B)
          const name = extractSkillName(entry as TranscriptUserEntry)
          if (name) cache.pendingSkillName = name
          continue
        }

        // Detect skill content injection
        if (isSkillContent(entry as TranscriptUserEntry) && cache.pendingSkillName) {
          lastGroup = null
          newGroups.push({
            type: 'skill',
            timestamp: entry.timestamp || '',
            entries: [entry],
            skillName: cache.pendingSkillName,
          })
          cache.pendingSkillName = undefined
          continue
        }
        cache.pendingSkillName = undefined
        if (textContent.includes('<task-notification>')) {
          const notifications = parseTaskNotifications(textContent)
          if (notifications.length > 0) {
            const prevSystem = newGroups[newGroups.length - 1]
            const isDuplicate =
              prevSystem?.type === 'system' &&
              prevSystem.notifications?.length === notifications.length &&
              notifications.every(n =>
                prevSystem.notifications?.some(p => p.taskId === n.taskId && p.status === n.status),
              )
            if (!isDuplicate) {
              lastGroup = null
              newGroups.push({ type: 'system', timestamp: entry.timestamp || '', entries: [entry], notifications })
            }
            continue
          }
        }
      }

      if (Array.isArray(content)) {
        const hasContent = content.some(
          c =>
            (c.type === 'text' && c.text?.trim()) ||
            (c.type === 'thinking' && (c.thinking?.trim() || c.text?.trim() || c.signature)) ||
            c.type === 'tool_use',
        )
        if (!hasContent) continue
      }

      const type = entry.type as 'user' | 'assistant'
      if (lastGroup && lastGroup.type === type) {
        lastGroup.entries.push(entry)
      } else {
        lastGroup = { type, timestamp: entry.timestamp || '', entries: [entry] }
        newGroups.push(lastGroup)
      }
    }

    // On initial/reset load, clear any orphaned queued flags. Historical data
    // may have enqueue entries whose remove/dequeue was evicted from the 500-entry
    // ring buffer, leaving stale "queued" groups that will never be consumed.
    if (isReset) {
      for (const g of newGroups) {
        if (g.queued) g.queued = false
      }
    }

    cache.groups = newGroups
    cache.lastGroup = lastGroup
    const elapsed = performance.now() - t0
    record('grouping', 'incrementalGroup', elapsed, `${newEntries.length} entries -> ${newGroups.length} groups`)
    if (elapsed > 5 || newEntries.length > 10) {
      console.log(`[grouping] ${newEntries.length} new entries -> ${newGroups.length} groups (${elapsed.toFixed(1)}ms)`)
    }
    return newGroups
  }, [entries])

  // Stable lookup function -- never changes identity, reads from the ref's live Map
  const getResult = useCallback((id: string) => cacheRef.current.resultMap.get(id), [])

  return { getResult, groups }
}
