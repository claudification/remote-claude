#!/usr/bin/env bun
/**
 * Phase 9: Variables, properties, store methods, project-uri helpers.
 *
 * Plain regex sweep (post-Phase-8 leftovers + project-uri helpers + store
 * method names that take a "session" param meaning conversation).
 *
 * Skipped (CC / auth / routing):
 *   - claudeSessionId, ccSessionId(s), observeClaudeSessionId,
 *     getCcSessionIds, targetCcSessionIds, hookSessionId
 *   - tmuxSession, voiceSession(s), cleanup/stopVoiceSession
 *   - revokeSession, renewSessionIfNeeded (auth tokens)
 *   - callerSession(Id), rendezvousCallerSessionId, reqSessionId,
 *     newSessionId (CC's new ID), setSessionId (ws-client CC ID setter)
 *   - fromSession(Id), toSession(Id), targetSession(Id),
 *     previousSessionId, prevSessionId (routing keys)
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

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

const REPLACE: Record<string, string> = {
  // Project URI helpers (truly conversation-level)
  projectWithoutSession: 'projectWithoutConversation',
  compareProjectSessionUri: 'compareProjectConversationUri',

  // Store APIs that take a conversation ID
  getForSession: 'getForConversation',
  deleteForSession: 'deleteForConversation',
  stmtForSession: 'stmtForConversation',

  // Spawn / lifecycle handlers
  spawnedSession: 'spawnedConversation',
  onSpawnSession: 'onSpawnConversation',
  onRestartSession: 'onRestartConversation',
  onRenameSession: 'onRenameConversation',
  onListSessions: 'onListConversations',
  onExitSession: 'onExitConversation',
  registerSessionLifecycleHandlers: 'registerConversationLifecycleHandlers',
  registerInterSessionHandlers: 'registerInterConversationHandlers',

  // UI state (last-selected, tab memory, edit/rename/pulse markers)
  lastSessionId: 'lastConversationId',
  setLastSessionId: 'setLastConversationId',
  getLastSessionId: 'getLastConversationId',
  tabPerSession: 'tabPerConversation',
  editingDescriptionSessionId: 'editingDescriptionConversationId',
  setEditingDescriptionSessionId: 'setEditingDescriptionConversationId',
  renamingSessionId: 'renamingConversationId',
  setRenamingSessionId: 'setRenamingConversationId',
  pulseSessionId: 'pulseConversationId',
  setPulseSessionId: 'setPulseConversationId',

  // Misc
  perSessionPerms: 'perConversationPerms',
  ownerSession: 'ownerConversation',
  hasActiveSession: 'hasActiveConversation', // re-listed (some leftover)

  // Voice items NOT renamed (different concept).
}

const files = [
  ...collectFiles(join(ROOT, 'src'), ['.ts', '.tsx']),
  ...collectFiles(join(ROOT, 'web/src'), ['.ts', '.tsx']),
]

let totalReplacements = 0
let filesChanged = 0
for (const file of files) {
  let content = readFileSync(file, 'utf-8')
  const original = content
  for (const [oldId, newId] of Object.entries(REPLACE)) {
    const re = new RegExp(`\\b${oldId}\\b`, 'g')
    content = content.replace(re, () => {
      totalReplacements++
      return newId
    })
  }
  if (content !== original) {
    writeFileSync(file, content)
    filesChanged++
  }
}

console.log(`Replacements: ${totalReplacements} across ${filesChanged} files`)
