#!/usr/bin/env bun
/**
 * Phase 8b: clean up leftover references that the broker tsconfig couldn't
 * see. Plain text replace for stragglers in web/src that import from web's
 * own paths (which the broker tsconfig doesn't index).
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

// Identifier-level replacements (use \b word boundaries)
const REPLACE: Record<string, string> = {
  fetchSessionEvents: 'fetchConversationEvents',
  fetchSessionData: 'fetchConversationData',
  defaultSessionCwd: 'defaultConversationCwd',
  showEndedSessions: 'showEndedConversations',
  sendSessionClear: 'sendConversationRekey',
  sendSessionEnd: 'sendConversationEnd',
  sendSessionStatus: 'sendConversationStatus',
  sendSessionControl: 'sendConversationControl',
  filterSessionsByHttpGrants: 'filterConversationsByHttpGrants',
  buildSessionsById: 'buildConversationsById',
  setSessions: 'setConversations',
  dismissSession: 'dismissConversation',
  terminateSession: 'terminateConversation',
  renameSession: 'renameConversation',
  reviveSession: 'reviveConversation',
  validateSession: 'validateConversation',
  validateSessionName: 'validateConversationName',
  spawnSession: 'spawnConversation',
  storeSessions: 'storeConversations',
  buildSessionMeta: 'buildConversationMeta',
  buildSessionStats: 'buildConversationStats',
  computeSessionSlug: 'computeConversationSlug',
  resolveSessionTarget: 'resolveConversationTarget',
  partitionSessions: 'partitionConversations',
  makeSession: 'makeConversation',
  bootSession: 'bootConversation',
  getSessionCost: 'getConversationCost',
  getSessionRules: 'getConversationRules',
  getSessionTab: 'getConversationTab',
  setSessionTab: 'setConversationTab',
  hasActiveSession: 'hasActiveConversation',
  isSessionMode: 'isConversationMode',
  isInterSession: 'isInterConversation',
  useSessionPath: 'useConversationPath',
  quitSession: 'quitConversation',
  addSessionRule: 'addConversationRule',
  removeSessionRule: 'removeConversationRule',
  onSelectSession: 'onSelectConversation',
  onQuitSession: 'onQuitConversation',
  onReviveSession: 'onReviveConversation',
  onConfigureSession: 'onConfigureConversation',
  onViewSession: 'onViewConversation',
  onChannelSessionsList: 'onChannelConversationsList',
  onSessionStart: 'onConversationStart',
  onSessionEnd: 'onConversationEnd',
  onSessionControlResult: 'onConversationControlResult',
  handleViewSession: 'handleViewConversation',
  allSessions: 'allConversations',
  selectedSession: 'selectedConversation',
  siblingSessions: 'siblingConversations',
  visibleSessionsByCwd: 'visibleConversationsByCwd',
  pendingSessionName: 'pendingConversationName',
  pendingSessionNames: 'pendingConversationNames',
  pendingSessionUpdates: 'pendingConversationUpdates',
  pendingListSessions: 'pendingListConversations',
  childSessions: 'childConversations',
  nodeSessions: 'nodeConversations',
  projectSessions: 'projectConversations',
  activeSessions: 'activeConversations',
  newSession: 'newConversation',
  resolvedSessionName: 'resolvedConversationName',
  interSessionLog: 'interConversationLog',
  hookSessionId: 'hookConversationId',
  uploadSessionId: 'uploadConversationId',
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
