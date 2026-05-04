#!/usr/bin/env bun
/**
 * Comment-only sweep: rewrite "wrapper" -> "agent host" inside comment
 * trivia, never inside identifiers, strings, or live code. Uses ts-morph
 * to find comment ranges (line + block + JSDoc) so we can't accidentally
 * touch identifiers or string content.
 *
 * Skipped contexts: any comment that mentions HTML/CSS wrappers, mermaid
 * containers, the React perf-profiler MaybeProfiler "wrapper" pattern, or
 * the legacy `src/wrapper` path (which is now `src/agent-host`).
 */

import { Project, type SourceFile } from 'ts-morph'

const REPLACEMENTS: Array<[RegExp, string]> = [
  // Path mentions: src/wrapper -> src/agent-host
  [/\bsrc\/wrapper\b/g, 'src/agent-host'],
  // Possessive / plural variants
  [/\bWrapper's\b/g, "Agent Host's"],
  [/\bwrapper's\b/g, "agent host's"],
  [/\bWrappers\b/g, 'Agent Hosts'],
  [/\bwrappers\b/g, 'agent hosts'],
  // Singular
  [/\bWrapper\b/g, 'Agent Host'],
  [/\bwrapper\b/g, 'agent host'],
]

// Phrases inside comments that should NOT be touched -- they describe
// CSS / DOM / React patterns where "wrapper" is the correct general
// English term. If a comment line contains any of these, skip it.
const SKIP_LINE_PATTERNS = [
  'mermaid',
  'MaybeProfiler',
  'div wrapper',
  'class="wrapper"',
  '<div class=',
  'CSS wrapper',
  'DOM wrapper',
  'innerHTML',
  'replaceWith(wrapper)',
]

function rewriteCommentText(text: string): string | null {
  // Apply replacements line-by-line so we can apply skip filters per line
  // without affecting other comment lines in the same /* ... */ block.
  const lines = text.split('\n')
  let any = false
  const out: string[] = []
  for (const line of lines) {
    if (SKIP_LINE_PATTERNS.some(p => line.includes(p))) {
      out.push(line)
      continue
    }
    let next = line
    for (const [pattern, replacement] of REPLACEMENTS) {
      next = next.replace(pattern, replacement)
    }
    if (next !== line) any = true
    out.push(next)
  }
  return any ? out.join('\n') : null
}

function rewriteFile(sf: SourceFile): number {
  const fullText = sf.getFullText()
  // Collect every distinct comment range exactly once. ts-morph reports
  // both leading and trailing ranges per node, so the same comment can
  // surface multiple times via getLeadingCommentRanges() of adjacent
  // nodes -- de-duplicate by [pos, end].
  const seen = new Set<string>()
  const ranges: Array<{ pos: number; end: number }> = []

  // Visit every node. For each, look at leading and trailing comment
  // ranges and add new ones to our list.
  sf.forEachDescendant(node => {
    for (const r of [...node.getLeadingCommentRanges(), ...node.getTrailingCommentRanges()]) {
      const key = `${r.getPos()}:${r.getEnd()}`
      if (seen.has(key)) continue
      seen.add(key)
      ranges.push({ pos: r.getPos(), end: r.getEnd() })
    }
  })

  // The SourceFile itself can have leading comments (file-level JSDoc).
  for (const r of [...sf.getLeadingCommentRanges(), ...sf.getTrailingCommentRanges()]) {
    const key = `${r.getPos()}:${r.getEnd()}`
    if (seen.has(key)) continue
    seen.add(key)
    ranges.push({ pos: r.getPos(), end: r.getEnd() })
  }

  // Sort descending so earlier replacements don't shift later offsets.
  ranges.sort((a, b) => b.pos - a.pos)

  let changes = 0
  for (const r of ranges) {
    const original = fullText.slice(r.pos, r.end)
    const rewritten = rewriteCommentText(original)
    if (rewritten !== null) {
      sf.replaceText([r.pos, r.end], rewritten)
      changes++
    }
  }
  return changes
}

const root = new Project({ tsConfigFilePath: './tsconfig.json' })
root.addSourceFilesAtPaths('src/**/*.{ts,tsx}')

const web = new Project({ tsConfigFilePath: './web/tsconfig.json' })
web.addSourceFilesAtPaths('web/src/**/*.{ts,tsx}')

let total = 0
for (const proj of [root, web]) {
  for (const sf of proj.getSourceFiles()) {
    const n = rewriteFile(sf)
    if (n > 0) {
      total += n
      console.log(`  ${sf.getBaseName()}: ${n} comment-block edit(s)`)
    }
  }
}
console.log(`\nTotal comment edits: ${total}`)

console.log('Saving...')
root.saveSync()
web.saveSync()
console.log('Done.')
