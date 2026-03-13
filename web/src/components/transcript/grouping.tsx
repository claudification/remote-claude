/**
 * Transcript grouping logic: builds display groups from raw transcript entries.
 * Handles result mapping, task notifications, incremental grouping, and entry filtering.
 */

import { useMemo, useRef } from 'react'
import type { TranscriptEntry } from '@/lib/types'

export interface TaskNotification {
  taskId: string
  summary: string
  status: 'completed' | 'failed' | string
  result?: string
}

export interface DisplayGroup {
  type: 'user' | 'assistant' | 'system' | 'compacting' | 'compacted'
  timestamp: string
  entries: TranscriptEntry[]
  notifications?: TaskNotification[]
}

// Build map of tool_use_id -> result
export function buildResultMap(entries: TranscriptEntry[]) {
  const map = new Map<string, { result: string; extra?: Record<string, unknown> }>()
  for (const entry of entries) {
    if (entry.type !== 'user') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        map.set(block.tool_use_id, {
          result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          extra: entry.toolUseResult,
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
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const xml = `<root>${blockMatch[1]}</root>`
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml')
      const taskId = doc.querySelector('task-id')?.textContent?.trim() || ''
      const status = doc.querySelector('status')?.textContent?.trim() || ''
      const summary = doc.querySelector('summary')?.textContent?.trim() || ''
      const result = doc.querySelector('result')?.textContent?.trim() || undefined
      if (taskId || summary) {
        results.push({ taskId, status, summary, result })
      }
    } catch {
      // Malformed XML - skip
    }
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
      groups.push({
        type: entry.type as 'compacting' | 'compacted',
        timestamp: entry.timestamp || '',
        entries: [entry],
      })
      continue
    }

    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    const content = entry.message?.content
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
          current = null
          groups.push({
            type: 'system',
            timestamp: entry.timestamp || '',
            entries: [entry],
            notifications,
          })
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
    resultMap: Map<string, { result: string; extra?: Record<string, unknown> }>
    groups: DisplayGroup[]
    lastGroup: DisplayGroup | null
  }>({ len: 0, resultMap: new Map(), groups: [], lastGroup: null })

  return useMemo(() => {
    const cache = cacheRef.current

    // Full reset if entries shrunk (initial load replaced everything, or session switch)
    if (entries.length < cache.len) {
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
      if (entry.type !== 'user') continue
      const content = entry.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          newResultMap.set(block.tool_use_id, {
            result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            extra: entry.toolUseResult,
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
        const g: DisplayGroup = {
          type: entry.type as 'compacting' | 'compacted',
          timestamp: entry.timestamp || '',
          entries: [entry],
        }
        newGroups.push(g)
        continue
      }

      if (entry.type !== 'user' && entry.type !== 'assistant') continue
      const content = entry.message?.content
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
            lastGroup = null
            newGroups.push({ type: 'system', timestamp: entry.timestamp || '', entries: [entry], notifications })
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

    cache.groups = newGroups
    cache.lastGroup = lastGroup
    return { resultMap: newResultMap, groups: newGroups }
  }, [entries])
}
