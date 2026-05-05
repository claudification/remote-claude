/**
 * Transcript grouping public API: builds display groups from raw transcript
 * entries. Per-entry classification + per-group-type sub-handlers live in
 * grouping/process-entry.ts; this file holds the result map, the batch +
 * incremental drivers, and the React hook.
 */

import { useCallback, useMemo, useRef } from 'react'
import { record } from '@/lib/perf-metrics'
import type { TranscriptEntry } from '@/lib/types'
import { isUser } from './grouping/parsers'
import { applyPlanModeTags, processEntry } from './grouping/process-entry'
import type { DisplayGroup, GroupingState, TaskNotification } from './grouping/types'

// Re-export so existing call sites (`import { DisplayGroup } from '../grouping'`) keep working.
export type { DisplayGroup, GroupingState, TaskNotification }

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

// Group consecutive entries by role, filtering out noise
export function groupEntries(entries: TranscriptEntry[]): DisplayGroup[] {
  const state: GroupingState = { groups: [], current: null, pendingSkillName: undefined }
  for (const entry of entries) {
    processEntry(entry, state)
  }
  applyPlanModeTags(state.groups)
  return state.groups
}

// Incremental grouping hook: only processes new entries since last call.
// Transcript entries are append-only (except initial load which replaces all).
// IMPORTANT: returns new array/map references each time to avoid mutating
// data that React components are currently rendering (React error #300).
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
    const cache = cacheRef.current
    if (!Array.isArray(entries)) return cache.groups
    const t0 = performance.now()

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

    // Incremental groupEntries - clone groups + lastGroup before mutating so
    // currently-rendering React trees aren't disturbed (React error #300).
    const newGroups = [...cache.groups]
    let lastGroup = cache.lastGroup
    if (lastGroup && newGroups.length > 0) {
      lastGroup = { ...lastGroup, entries: [...lastGroup.entries] }
      newGroups[newGroups.length - 1] = lastGroup
    }

    // Drive the shared classifier with our cloned state. processEntry mutates
    // state.current so we read it back afterward to refresh cache.lastGroup.
    const state: GroupingState = {
      groups: newGroups,
      current: lastGroup,
      pendingSkillName: cache.pendingSkillName,
    }
    for (const entry of newEntries) {
      processEntry(entry, state)
    }
    lastGroup = state.current
    cache.pendingSkillName = state.pendingSkillName

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
