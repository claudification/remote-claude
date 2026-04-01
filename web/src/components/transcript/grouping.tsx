/**
 * Transcript grouping logic: builds display groups from raw transcript entries.
 * Handles result mapping, task notifications, incremental grouping, and entry filtering.
 */

import { useMemo, useRef } from 'react'
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
  type: 'user' | 'assistant' | 'system' | 'compacting' | 'compacted'
  timestamp: string
  entries: TranscriptEntry[]
  notifications?: TaskNotification[]
  queued?: boolean // user interject waiting to be consumed
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
export function parseTaskNotifications(text: string): TaskNotification[] {
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

// Group consecutive entries by role, filtering out noise
export function groupEntries(entries: TranscriptEntry[]): DisplayGroup[] {
  const groups: DisplayGroup[] = []
  let current: DisplayGroup | null = null

  for (const entry of entries) {
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

    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    const msgEntry = entry as TranscriptUserEntry | TranscriptAssistantEntry
    const content = msgEntry.message?.content
    if (!content) continue

    if (entry.type === 'user' && Array.isArray(content)) {
      if (content.some(c => c.type === 'tool_result')) continue
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
      )
        continue
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
          (c.type === 'thinking' && (c.thinking?.trim() || c.text?.trim())) ||
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
  }>({ len: 0, resultMap: new Map(), groups: [], lastGroup: null })

  return useMemo(() => {
    const cache = cacheRef.current

    // Full reset if entries shrunk (initial load replaced everything, or session switch)
    const isReset = entries.length < cache.len
    if (isReset) {
      cache.len = 0
      cache.resultMap = new Map()
      cache.groups = []
      cache.lastGroup = null
    }

    // Nothing new - return stable references
    if (entries.length === cache.len) {
      return { resultMap: cache.resultMap, groups: cache.groups }
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

      if (entry.type !== 'user' && entry.type !== 'assistant') continue
      const msgEntry = entry as TranscriptUserEntry | TranscriptAssistantEntry
      const content = msgEntry.message?.content
      if (!content) continue

      if (entry.type === 'user' && Array.isArray(content)) {
        if (content.some(c => c.type === 'tool_result')) continue
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
        )
          continue
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
            (c.type === 'thinking' && (c.thinking?.trim() || c.text?.trim())) ||
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
    return { resultMap: newResultMap, groups: newGroups }
  }, [entries])
}
