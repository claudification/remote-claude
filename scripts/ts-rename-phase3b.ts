#!/usr/bin/env bun
/**
 * Phase 3b: Rename sessionId parameters and session local variables in broker code.
 *
 * In conversation-store.ts interface + implementation:
 * - sessionId -> conversationId (where no collision with existing conversationId param)
 * - sessionId -> id (in setConversationSocket, removeConversationSocket where
 *   conversationId already exists as second param)
 * - session (local var typed Conversation) -> conversation
 *
 * In broker handlers:
 * - sessionId (local var holding conversation ID) -> conversationId
 * - session (local var holding Conversation) -> conversation
 *
 * Skips:
 * - claudeSessionId, ccSessionId (CC run IDs)
 * - callerSessionId (auth/caller context)
 * - meta.sessionId (wire protocol field on incoming messages)
 * - SessionStart, SessionEnd, SessionClear (CC hook types)
 * - session_clear, session_promote, session_ready (CC wire messages)
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const BROKER = join(ROOT, 'src/broker')

function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'bin') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, exts))
    } else if (exts.includes(extname(full))) {
      results.push(full)
    }
  }
  return results
}

// Words that should NOT be renamed (they genuinely mean CC session):
const SKIP_PATTERNS = [
  'claudeSessionId',
  'ccSessionId',
  'callerSessionId',
  'clearSessionId',
  'newSessionId',
  'oldSessionId',
  'promoteSessionId',
  'SessionStart',
  'SessionEnd',
  'SessionClear',
  'SessionPromote',
  'session_clear',
  'session_promote',
  'session_ready',
  'session_connected',
  'session_id', // CC hook field
  'analyticsSession',
  'clearAnalyticsSession',
]

const files = collectFiles(BROKER, ['.ts', '.tsx'])
let totalChanges = 0

for (const file of files) {
  let content = readFileSync(file, 'utf-8')
  const original = content

  // ── Rename `sessionId` to `conversationId` ─────────────────────────
  // But skip lines that contain skip patterns
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip lines with CC-specific patterns
    if (SKIP_PATTERNS.some(p => line.includes(p))) continue
    // Skip lines that are comments describing CC session concepts
    if (line.includes('CC session') || line.includes('claude session') || line.includes('CC run')) continue
    // Skip wire protocol field access: meta.sessionId, data.sessionId
    if (/\b(meta|data)\.\bsessionId\b/.test(line)) continue
    // Skip session_id field (CC hook data)
    if (line.includes("'session_id'") || line.includes('"session_id"')) continue

    // For setConversationSocket and removeConversationSocket definitions,
    // the first `sessionId` should become `id` (not `conversationId`) to avoid
    // collision with the second parameter already named `conversationId`.
    if (line.includes('setConversationSocket') || line.includes('removeConversationSocket')) {
      // Only rename the FIRST sessionId occurrence on this line
      lines[i] = line.replace(/\bsessionId\b/, 'id')
      continue
    }

    // General rename: sessionId -> conversationId
    lines[i] = line.replace(/\bsessionId\b/g, 'conversationId')
  }
  content = lines.join('\n')

  // ── Rename `session` local variables (typed Conversation) ──────────
  // Pattern: `const session: Conversation`, `let session: Conversation`
  content = content.replace(/\b(const|let)\s+session\s*:\s*Conversation\b/g, '$1 conversation: Conversation')
  // Pattern: `const session = conversations.get(` etc.
  content = content.replace(
    /\b(const|let)\s+session\s*=\s*conversations\.(get|values)/g,
    '$1 conversation = conversations.$2',
  )
  // Pattern: `session: toConversationSummary(session)` in object literals
  // This one is tricky -- `session` as object key in wire messages. Leave it for now.

  // ── Rename `sessions` in type annotations ──────────────────────────
  // `ctx.sessions.` -> `ctx.conversations.` (the store accessor)
  // Wait, this was already done if the HandlerContext type was renamed.
  // Let's check if ctx.sessions exists
  // Actually the accessor name on HandlerContext might still be `sessions`
  // Leave this for now

  if (content !== original) {
    writeFileSync(file, content)
    // Count changes
    const changes = content.split('\n').filter((l, i) => l !== original.split('\n')[i]).length
    totalChanges += changes
    const rel = file.replace(ROOT + '/', '')
    console.log(`  ${rel}: ${changes} lines changed`)
  }
}

console.log(`\nTotal: ${totalChanges} line changes across broker files`)
