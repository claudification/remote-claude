#!/usr/bin/env bun
/**
 * Phase 11: Comments + test descriptions cleanup.
 *
 * Targets specific safe patterns:
 *  - "per-session" -> "per-conversation" (cache / counter contexts)
 *  - "the session" / "this session" / "a session" / "ended session" /
 *    "active session" / "session lifecycle" / "session status" / "session id"
 *    inside comments and test names where it means our conversation
 *  - Test describe/it labels: "session ..." -> "conversation ..."
 *
 * Skip: any line still containing skip patterns (CC sessionStart hook,
 * voice/tmux session, etc.)
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

const SKIP_FILES = new Set(
  [
    'src/agent-host/local-server.ts',
    'src/agent-host/ws-client.ts',
    'src/agent-host/session-transition.ts',
    'src/agent-host/session-transition.test.ts',
    'src/agent-host/headless-lifecycle.ts',
    'src/agent-host/index.ts',
    'src/agent-host/hook-processor.ts',
    'src/agent-host/transcript-manager.ts',
    'src/agent-host/permission-rules.ts',
    'src/agent-host/launch-events.ts',
    'src/agent-host/agent-host-context.ts',
    'src/agent-host/mcp-channel.ts',
    'src/agent-host/settings-merge.ts',
    'src/shared/transcript-schema.ts',
    'src/shared/hook-events.ts',
    'src/shared/protocol.ts', // contains CC wire field commentary
    'src/agent-host/prompt-builder.ts',
    'src/agent-host/stream-backend.ts',
    'src/agent-host/pty-spawn.ts',
    'src/agent-host/file-editor-handler.ts',
    'src/agent-host/pending-interactions.ts',
    'src/agent-host/debug.ts',
  ].map(p => join(ROOT, p)),
)

const SKIP_LINE_PATTERNS = [
  'claudeSessionId',
  'ccSessionId',
  'observeClaudeSessionId',
  'getCcSessionIds',
  'targetCcSessionIds',
  'tmuxSession',
  'voiceSession',
  'auth session',
  'Auth session',
  'session_id', // CC wire field
  "'SessionStart'",
  "'SessionEnd'",
  '"SessionStart"',
  '"SessionEnd"',
  'CC session',
  'Claude session',
  "CC's session",
  'cc session',
  'claude session',
  'session id changed',
  'pre-session-id',
  'rclaude session', // already a conversation in our vocab, but ambiguous
]

// Comment-line replacements (only inside // or /* lines / JSDoc).
const REPLACEMENTS: Array<[RegExp, string]> = [
  // Hyphenated forms
  [/\bper-session\b/g, 'per-conversation'],
  [/\bcross-session\b/g, 'cross-conversation'],
  [/\binter-session\b/g, 'inter-conversation'],
  [/\bsession-level\b/g, 'conversation-level'],
  [/\bsession-scoped\b/g, 'conversation-scoped'],
  [/\bsession-specific\b/g, 'conversation-specific'],
  [/\bsession-id\b/g, 'conversation-id'],

  // Common phrasings
  [/\bSession lifecycle\b/g, 'Conversation lifecycle'],
  [/\bsession lifecycle\b/g, 'conversation lifecycle'],
  [/\bSession state\b/g, 'Conversation state'],
  [/\bsession state\b/g, 'conversation state'],
  [/\bsession status\b/g, 'conversation status'],
  [/\bsession activity\b/g, 'conversation activity'],
  [/\bsession metadata\b/g, 'conversation metadata'],
  [/\bsession entries\b/g, 'conversation entries'],
  [/\bsession switch\b/g, 'conversation switch'],
  [/\bsession tab\b/g, 'conversation tab'],
  [/\bsession-switch\b/g, 'conversation-switch'],

  // Plain
  [
    /\b(active|ended|orphan|stale|child|new|the|this|a|each|every|any) sessions?\b/g,
    (_m: string, w: string) =>
      `${w} ${w === 'a' || w === 'this' || w === 'the' || w === 'each' || w === 'every' || w === 'any' || w === 'new' ? 'conversation' : 'conversations'}`,
  ],
  // Plural collections
  [/\ball sessions\b/g, 'all conversations'],
  [/\bsessions for\b/g, 'conversations for'],
  [/\bsessions in\b/g, 'conversations in'],
  [/\bsessions of\b/g, 'conversations of'],
  // Test descriptions
  [/(describe\(['"`])session(\b)/g, '$1conversation$2'],
  [/(it\(['"`][^'"`]*?\b)session(\b[^'"`]*?['"`])/g, '$1conversation$2'],
]

function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'bin') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) results.push(...collectFiles(full, exts))
    else if (exts.includes(extname(full))) results.push(full)
  }
  return results
}

const files = [
  ...collectFiles(join(ROOT, 'src'), ['.ts', '.tsx']),
  ...collectFiles(join(ROOT, 'web/src'), ['.ts', '.tsx']),
]

let totalChanges = 0
let filesChanged = 0
for (const file of files) {
  if (SKIP_FILES.has(file)) continue
  const original = readFileSync(file, 'utf-8')
  const lines = original.split('\n')
  let changed = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (SKIP_LINE_PATTERNS.some(pat => line.includes(pat))) continue

    // Only modify lines that are comments or test descriptions to be safe
    const trimmed = line.trimStart()
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
    const isTest = /\b(describe|it|test)\(/.test(line)
    if (!isComment && !isTest) continue

    let replaced = line
    for (const [re, rep] of REPLACEMENTS) {
      const before = replaced
      replaced = replaced.replace(re as RegExp, rep as any)
      if (before !== replaced) changed++
    }
    if (replaced !== line) lines[i] = replaced
  }
  if (changed > 0) {
    writeFileSync(file, lines.join('\n'))
    totalChanges += changed
    filesChanged++
  }
}

console.log(`Changes: ${totalChanges} across ${filesChanged} files`)
