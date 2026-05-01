#!/usr/bin/env bun
/**
 * Phase 3: Rename inner functions, variables, and maps in conversation-store.ts
 * and all callers across the codebase.
 *
 * Uses string replacement (not ts-morph) because these are unique function names
 * that don't collide with other identifiers.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

// ── Renames: function/method names ───────────────────────────────────────

const functionRenames: [string, string][] = [
  // Interface + implementation function renames
  ['ConversationStoreOptions', 'ConversationStoreOptions'],
  ['toConversationSummary', 'toConversationSummary'],
  ['broadcastConversationScoped', 'broadcastConversationScoped'],
  ['scheduleConversationUpdate', 'scheduleConversationUpdate'],
  ['flushConversationUpdates', 'flushConversationUpdates'],
  ['persistConversation', 'persistConversation'],
  ['createConversation', 'createConversation'],
  ['resumeConversation', 'resumeConversation'],
  ['rekeyConversation', 'rekeyConversation'],
  ['getConversation', 'getConversation'],
  ['getAllConversations', 'getAllConversations'],
  ['getActiveConversations', 'getActiveConversations'],
  ['endConversation', 'endConversation'],
  ['removeConversation', 'removeConversation'],
  ['getConversationEvents', 'getConversationEvents'],
  ['setConversationSocket', 'setConversationSocket'],
  ['getConversationSocket', 'getConversationSocket'],
  ['findSocketByConversationId', 'findSocketByConversationId'],
  ['findConversationByConversationId', 'findConversationByConversationId'],
  ['removeConversationSocket', 'removeConversationSocket'],
  ['filterConversationsByGrants', 'filterConversationsByGrants'],
  ['buildConversationsListMessage', 'buildConversationsListMessage'],
  ['sendConversationsList', 'sendConversationsList'],
  ['broadcastConversationUpdate', 'broadcastConversationUpdate'],
  ['setPendingConversationName', 'setPendingConversationName'],
  ['consumePendingConversationName', 'consumePendingConversationName'],
  ['resolveRendezvous', 'resolveRendezvous'], // keep name, but will handle params
  ['getLinkedProjects', 'getLinkedProjects'], // keep name
]

// ── Renames: map/variable names ──────────────────────────────────────────

const mapRenames: [string, string][] = [
  // Only in conversation-store.ts
  ['const sessions = new Map', 'const conversations = new Map'],
  ['sessionSockets', 'conversationSockets'],
  ['dashboardSubscribers', 'controlPanelSubscribers'],
]

// ── File collection ──────────────────────────────────────────────────────

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

// ── Apply renames ────────────────────────────────────────────────────────

const files = collectFiles(ROOT, ['.ts', '.tsx'])
let totalChanges = 0

for (const file of files) {
  let content = readFileSync(file, 'utf-8')
  const original = content
  let fileChanges = 0

  for (const [old, newName] of functionRenames) {
    if (old === newName) continue // skip identity renames
    // Use word-boundary matching to avoid partial matches
    const regex = new RegExp(`\\b${old}\\b`, 'g')
    const matches = content.match(regex)
    if (matches) {
      content = content.replace(regex, newName)
      fileChanges += matches.length
    }
  }

  // Map/variable renames only in conversation-store.ts and test file
  if (file.includes('conversation-store')) {
    for (const [old, newName] of mapRenames) {
      const regex = new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      const matches = content.match(regex)
      if (matches) {
        content = content.replace(regex, newName)
        fileChanges += matches.length
      }
    }

    // Rename `sessions.` map access -> `conversations.` (careful: only the local map variable)
    // This matches `sessions.get(`, `sessions.set(`, `sessions.delete(`, `sessions.has(`
    // and `sessions.values()`, `sessions.entries()`, `sessions.size`, `sessions.forEach(`
    const sessionsMapRegex = /\bsessions\.(get|set|delete|has|values|entries|size|forEach)\b/g
    const sessionsMapMatches = content.match(sessionsMapRegex)
    if (sessionsMapMatches) {
      content = content.replace(sessionsMapRegex, match => match.replace('sessions.', 'conversations.'))
      fileChanges += sessionsMapMatches.length
    }

    // `for (const [... ] of sessions)` and `for (const session of sessions)`
    content = content.replace(/\bof sessions\b/g, 'of conversations')

    // `const session: Conversation` -> `const conversation: Conversation`
    // `let session: Conversation` -> `let conversation: Conversation`
    // But NOT inside CC-specific contexts
    // This is tricky -- do it only for well-scoped patterns
  }

  if (content !== original) {
    writeFileSync(file, content)
    totalChanges += fileChanges
    const rel = file.replace(ROOT + '/', '')
    console.log(`  ${rel}: ${fileChanges} changes`)
  }
}

console.log(`\nTotal: ${totalChanges} changes across ${files.length} files scanned`)
