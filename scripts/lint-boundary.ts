#!/usr/bin/env bun

/**
 * Boundary lint: enforces that the broker NEVER reads or interprets CC-specific
 * concepts. The broker is a conversation router -- CC session IDs, CC-specific
 * fields, and CC internal state are agent-host concepts that the broker passes
 * through as opaque metadata.
 *
 * RULE: src/broker/ must NEVER reference `ccSessionId` as a typed field,
 * property access, or destructured binding. The ONLY exception is the
 * `conversation_promote` handler which receives it from the wire and stores
 * it in `conv.agentHostMeta` (opaque bag).
 *
 * Run: `bun run scripts/lint-boundary.ts`
 * Exits 0 = clean, 1 = violations found.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Glob } from 'bun'

const BROKER_DIR = join(import.meta.dir, '..', 'src/broker')
const glob = new Glob('**/*.ts')
const files = [...glob.scanSync({ cwd: BROKER_DIR })]

const ALLOWED_FILES = new Set([
  'handlers/boot-lifecycle.ts',
  'handlers/conversation-lifecycle.ts',
  'handlers/sentinel.ts',
  'build-revive.ts',
  'spawn-dispatch.ts',
  'conversation-store.ts',
])

const violations: Array<{ file: string; line: number; text: string; reason: string }> = []

for (const relPath of files) {
  if (relPath.endsWith('.d.ts')) continue
  if (relPath.includes('__tests__/')) continue

  const absPath = join(BROKER_DIR, relPath)
  const content = readFileSync(absPath, 'utf-8')
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // Skip comments
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

    // Rule 1: No .ccSessionId property access in broker (except allowed files storing it)
    if (/\.ccSessionId\b/.test(line)) {
      if (ALLOWED_FILES.has(relPath)) {
        // Allowed files may WRITE to agentHostMeta but not use it in logic
        if (/if\s*\(.*\.ccSessionId|===.*ccSessionId|!==.*ccSessionId/.test(line)) {
          violations.push({
            file: relPath,
            line: lineNum,
            text: line.trim(),
            reason: 'Broker must not branch on ccSessionId (CC concept, opaque to broker)',
          })
        }
      } else {
        violations.push({
          file: relPath,
          line: lineNum,
          text: line.trim(),
          reason: 'Broker must not access ccSessionId (CC concept, opaque to broker)',
        })
      }
    }

    // Rule 2: No `sessionId` (without cc prefix) as a field in broker code
    // (but allow `fromSessionId`/`toSessionId` in inter-conversation routing,
    // and `$sessionId` SQL bind params that map to conversation_id columns in legacy schemas)
    if (/\bsessionId\b/.test(line) && !/ccSessionId|fromSessionId|toSessionId/.test(line)) {
      // Allow in SQL strings (bind param name doesn't matter, just the column name)
      if (/\$sessionId|\$conversationId/.test(line)) continue
      // Allow in migration code (reads old data formats)
      if (relPath.includes('migrate')) continue
      // Allow in string literals (error messages referencing the old name)
      if (/['"`].*sessionId.*['"`]/.test(line)) continue
      violations.push({
        file: relPath,
        line: lineNum,
        text: line.trim(),
        reason: 'Broker must not use bare `sessionId` (use conversationId)',
      })
    }
  }
}

if (violations.length === 0) {
  console.log('[boundary-lint] PASS -- no broker boundary violations')
  process.exit(0)
} else {
  console.error(`[boundary-lint] FAIL -- ${violations.length} violation(s):\n`)
  for (const v of violations) {
    console.error(`  src/broker/${v.file}:${v.line}`)
    console.error(`    ${v.text}`)
    console.error(`    reason: ${v.reason}\n`)
  }
  process.exit(1)
}
