/**
 * Diff/Patch/Merge utilities for file editor
 * Thin agent host around the `diff` npm package
 */

import { applyPatch, createPatch, structuredPatch } from 'diff'

/**
 * Compute a unified diff between two strings
 */
export function computeUnifiedDiff(oldText: string, newText: string, filename = 'file'): string {
  return createPatch(filename, oldText, newText, '', '', { context: 3 })
}

/**
 * Apply a unified diff to text. Returns the result or null if it can't be applied cleanly.
 */
export function applyUnifiedDiff(text: string, diff: string): { result: string; applied: boolean } {
  const result = applyPatch(text, diff)
  if (result === false) {
    return { result: text, applied: false }
  }
  return { result, applied: true }
}

/**
 * 3-way merge: given a common base, "ours" (user changes) and "theirs" (disk/Claude changes),
 * produce a merged result. Non-overlapping changes merge cleanly. Overlapping changes
 * produce conflict markers.
 */
export function merge3way(base: string, ours: string, theirs: string): { result: string; hasConflicts: boolean } {
  const baseLines = splitLines(base)
  const ourLines = splitLines(ours)
  const theirLines = splitLines(theirs)

  // Compute diffs from base to each side
  const ourChanges = computeLineChanges(baseLines, ourLines)
  const theirChanges = computeLineChanges(baseLines, theirLines)

  const result: string[] = []
  let hasConflicts = false
  let baseIdx = 0

  // Merge change regions
  const allRegions = mergeRegions(ourChanges, theirChanges, baseLines.length)

  for (const region of allRegions) {
    // Copy unchanged lines before this region
    while (baseIdx < region.baseStart) {
      result.push(baseLines[baseIdx])
      baseIdx++
    }

    if (region.type === 'ours') {
      result.push(...region.lines)
      baseIdx = region.baseEnd
    } else if (region.type === 'theirs') {
      result.push(...region.lines)
      baseIdx = region.baseEnd
    } else if (region.type === 'both-same') {
      // Both sides made the same change
      result.push(...region.lines)
      baseIdx = region.baseEnd
    } else if (region.type === 'conflict') {
      hasConflicts = true
      result.push('<<<<<<< yours')
      result.push(...region.ourLines)
      result.push('=======')
      result.push(...region.theirLines)
      result.push('>>>>>>> theirs')
      baseIdx = region.baseEnd
    }
  }

  // Copy remaining unchanged lines
  while (baseIdx < baseLines.length) {
    result.push(baseLines[baseIdx])
    baseIdx++
  }

  return { result: joinLines(result), hasConflicts }
}

// --- Internal helpers ---

function splitLines(text: string): string[] {
  if (text === '') return []
  return text.split('\n')
}

function joinLines(lines: string[]): string {
  return lines.join('\n')
}

interface LineChange {
  baseStart: number // inclusive
  baseEnd: number // exclusive
  newLines: string[]
}

/**
 * Compute line-level changes from base to modified using the diff library's structured patch
 */
function computeLineChanges(baseLines: string[], modifiedLines: string[]): LineChange[] {
  const patch = structuredPatch('file', 'file', joinLines(baseLines), joinLines(modifiedLines), '', '', { context: 0 })
  const changes: LineChange[] = []

  for (const hunk of patch.hunks) {
    let basePos = hunk.oldStart - 1 // 0-indexed
    let newLines: string[] = []
    let removeCount = 0
    let changeStart = basePos

    for (const line of hunk.lines) {
      if (line.startsWith('-')) {
        removeCount++
        basePos++
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1))
      } else if (line.startsWith(' ')) {
        // Context line (shouldn't happen with context: 0, but handle it)
        if (removeCount > 0 || newLines.length > 0) {
          changes.push({ baseStart: changeStart, baseEnd: changeStart + removeCount, newLines })
          removeCount = 0
          newLines = []
        }
        basePos++
        changeStart = basePos
      }
    }

    if (removeCount > 0 || newLines.length > 0) {
      changes.push({ baseStart: changeStart, baseEnd: changeStart + removeCount, newLines })
    }
  }

  return changes
}

type MergeRegion =
  | { type: 'ours'; baseStart: number; baseEnd: number; lines: string[] }
  | { type: 'theirs'; baseStart: number; baseEnd: number; lines: string[] }
  | { type: 'both-same'; baseStart: number; baseEnd: number; lines: string[] }
  | { type: 'conflict'; baseStart: number; baseEnd: number; ourLines: string[]; theirLines: string[] }

/**
 * Merge two sets of changes into regions, detecting conflicts where they overlap
 */
function mergeRegions(ourChanges: LineChange[], theirChanges: LineChange[], _baseLength: number): MergeRegion[] {
  const regions: MergeRegion[] = []
  let oi = 0
  let ti = 0

  while (oi < ourChanges.length || ti < theirChanges.length) {
    const hasOurs = oi < ourChanges.length
    const hasTheirs = ti < theirChanges.length

    if (!hasOurs && hasTheirs) {
      const t = theirChanges[ti]
      regions.push({ type: 'theirs', baseStart: t.baseStart, baseEnd: t.baseEnd, lines: t.newLines })
      ti++
      continue
    }
    if (!hasTheirs && hasOurs) {
      const o = ourChanges[oi]
      regions.push({ type: 'ours', baseStart: o.baseStart, baseEnd: o.baseEnd, lines: o.newLines })
      oi++
      continue
    }
    if (!hasOurs || !hasTheirs) break

    const o = ourChanges[oi]
    const t = theirChanges[ti]

    // Check for overlap
    if (o.baseEnd <= t.baseStart) {
      // Ours comes first, no overlap
      regions.push({ type: 'ours', baseStart: o.baseStart, baseEnd: o.baseEnd, lines: o.newLines })
      oi++
    } else if (t.baseEnd <= o.baseStart) {
      // Theirs comes first, no overlap
      regions.push({ type: 'theirs', baseStart: t.baseStart, baseEnd: t.baseEnd, lines: t.newLines })
      ti++
    } else {
      // Overlapping regions
      const baseStart = Math.min(o.baseStart, t.baseStart)
      const baseEnd = Math.max(o.baseEnd, t.baseEnd)

      // Check if both sides made the same change
      if (
        o.baseStart === t.baseStart &&
        o.baseEnd === t.baseEnd &&
        o.newLines.length === t.newLines.length &&
        o.newLines.every((line, i) => line === t.newLines[i])
      ) {
        regions.push({ type: 'both-same', baseStart, baseEnd, lines: o.newLines })
      } else {
        regions.push({ type: 'conflict', baseStart, baseEnd, ourLines: o.newLines, theirLines: t.newLines })
      }
      oi++
      ti++
    }
  }

  return regions
}
