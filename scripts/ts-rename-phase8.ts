#!/usr/bin/env bun
/**
 * Phase 8: Rename function / method / property names where "Session" means
 * "conversation" in our vocabulary.
 *
 * Strategy: walk every Identifier node in the project. If the text matches an
 * exact key in RENAMES and the surrounding scope/declaration isn't in the
 * skip list, rename it via the language service so all references update.
 */
import { type Node, Project, SyntaxKind } from 'ts-morph'

const project = new Project({
  tsConfigFilePath: './tsconfig.json',
  skipAddingFilesFromTsConfig: false,
})
project.addSourceFilesAtPaths('web/src/**/*.{ts,tsx}')
console.log(`Loaded ${project.getSourceFiles().length} source files`)

// Direct 1:1 identifier renames. Applied to declarations (interface props,
// functions, vars, methods) so refs propagate via the language service.
const RENAMES: Record<string, string> = {
  // top-level functions / vars
  bootSession: 'bootConversation',
  buildSessionMeta: 'buildConversationMeta',
  buildSessionsById: 'buildConversationsById',
  buildSessionStats: 'buildConversationStats',
  computeSessionSlug: 'computeConversationSlug',
  dismissSession: 'dismissConversation',
  fetchSessionData: 'fetchConversationData',
  fetchSessionEvents: 'fetchConversationEvents',
  filterSessionsByHttpGrants: 'filterConversationsByHttpGrants',
  getSessionCost: 'getConversationCost',
  getSessionRules: 'getConversationRules',
  getSessionTab: 'getConversationTab',
  hasActiveSession: 'hasActiveConversation',
  isInterSession: 'isInterConversation',
  isSessionMode: 'isConversationMode',
  makeSession: 'makeConversation',
  partitionSessions: 'partitionConversations',
  quitSession: 'quitConversation',
  renameSession: 'renameConversation',
  resolveSessionTarget: 'resolveConversationTarget',
  reviveSession: 'reviveConversation',
  spawnSession: 'spawnConversation',
  storeSessions: 'storeConversations',
  terminateSession: 'terminateConversation',
  useSessionPath: 'useConversationPath',
  validateSession: 'validateConversation',
  validateSessionName: 'validateConversationName',
  addSessionRule: 'addConversationRule',
  removeSessionRule: 'removeConversationRule',

  // sender / handler / event method names (object lit + interface props)
  sendSessionClear: 'sendConversationRekey',
  sendSessionControl: 'sendConversationControl',
  sendSessionEnd: 'sendConversationEnd',
  sendSessionStatus: 'sendConversationStatus',
  onSessionStart: 'onConversationStart',
  onSessionEnd: 'onConversationEnd',
  onSessionControlResult: 'onConversationControlResult',
  onSelectSession: 'onSelectConversation',
  onQuitSession: 'onQuitConversation',
  onReviveSession: 'onReviveConversation',
  onConfigureSession: 'onConfigureConversation',
  onViewSession: 'onViewConversation',
  onChannelSessionsList: 'onChannelConversationsList',
  handleViewSession: 'handleViewConversation',

  // simple state-setters with single meaning
  setSessions: 'setConversations',
  setSessionTab: 'setConversationTab',

  // local-var-like (we'll rename declarations only)
  allSessions: 'allConversations',
  selectedSession: 'selectedConversation',
  siblingSessions: 'siblingConversations',
  visibleSessionsByCwd: 'visibleConversationsByCwd',
  showEndedSessions: 'showEndedConversations',
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
  defaultSessionCwd: 'defaultConversationCwd',
  interSessionLog: 'interConversationLog',
  hookSessionId: 'hookConversationId',
  uploadSessionId: 'uploadConversationId',
  cleanupVoiceSession: 'cleanupVoiceSession', // SKIP -- noop, here for clarity
  // (stopVoiceSession / voiceSession kept too -- different concept)
}
delete (RENAMES as any).cleanupVoiceSession

// SKIP: identifiers that look like they match but have meanings outside our
// "conversation" vocabulary. Belt-and-braces: even if they're not in RENAMES,
// the script never touches anything not in RENAMES.
// (Listed only for human review.)

let totalRenames = 0
const seenDeclarations = new Set<string>() // sf:line:col:name

function tryRename(node: Node, oldName: string, newName: string, kind: string) {
  // dedupe: rename the declaration once; references update automatically
  const sf = node.getSourceFile()
  const start = node.getStart()
  const key = `${sf.getFilePath()}:${start}:${oldName}`
  if (seenDeclarations.has(key)) return
  seenDeclarations.add(key)
  try {
    // ts-morph rename works on declaration nodes that have a .rename()
    if (typeof (node as any).rename === 'function') {
      ;(node as any).rename(newName)
      console.log(`  ${kind}: ${oldName} -> ${newName}  ${sf.getFilePath().replace(/^.*\/(src|web)/, '$1')}`)
      totalRenames++
    }
  } catch (err) {
    console.warn(`  FAIL ${oldName}: ${(err as Error).message}`)
  }
}

for (const sf of project.getSourceFiles()) {
  // Functions
  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    if (name && RENAMES[name]) tryRename(fn, name, RENAMES[name], 'fn')
  }

  // Variable declarations
  for (const v of sf.getVariableDeclarations()) {
    const name = v.getName()
    if (RENAMES[name]) tryRename(v, name, RENAMES[name], 'var')
  }

  // Interface property signatures + method signatures
  for (const iface of sf.getInterfaces()) {
    for (const p of iface.getProperties()) {
      const name = p.getName()
      if (RENAMES[name]) tryRename(p, name, RENAMES[name], 'iface-prop')
    }
    for (const m of iface.getMethods()) {
      const name = m.getName()
      if (RENAMES[name]) tryRename(m, name, RENAMES[name], 'iface-method')
    }
  }

  // Type literal property signatures (e.g. `type X = { foo: ... }`)
  for (const ta of sf.getTypeAliases()) {
    const tn = ta.getTypeNode()
    if (!tn) continue
    if (tn.getKind() === SyntaxKind.TypeLiteral) {
      for (const m of tn.getDescendantsOfKind(SyntaxKind.PropertySignature)) {
        const id = m.getNameNode()
        const name = id.getText()
        if (RENAMES[name]) tryRename(id, name, RENAMES[name], 'type-prop')
      }
    }
  }

  // Object-literal property assignments and method declarations -- needed
  // when a callback is passed as { onSessionEnd(...) {} } without the
  // surrounding interface being known to ts-morph rename source.
  // The interface rename above usually covers these, but loose objects don't.
  for (const obj of sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    for (const p of obj.getProperties()) {
      if (
        p.getKind() === SyntaxKind.PropertyAssignment ||
        p.getKind() === SyntaxKind.MethodDeclaration ||
        p.getKind() === SyntaxKind.ShorthandPropertyAssignment
      ) {
        const nameNode = (p as any).getNameNode?.()
        if (!nameNode) continue
        const name = nameNode.getText()
        if (RENAMES[name]) tryRename(nameNode, name, RENAMES[name], 'obj-prop')
      }
    }
  }

  // Class methods + properties
  for (const cls of sf.getClasses()) {
    for (const m of cls.getMethods()) {
      const name = m.getName()
      if (RENAMES[name]) tryRename(m, name, RENAMES[name], 'class-method')
    }
    for (const p of cls.getProperties()) {
      const name = p.getName()
      if (RENAMES[name]) tryRename(p, name, RENAMES[name], 'class-prop')
    }
  }

  // Function parameters
  for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    for (const p of fn.getParameters()) {
      const name = p.getName()
      if (RENAMES[name]) tryRename(p, name, RENAMES[name], 'param')
    }
  }
  for (const fn of sf.getDescendantsOfKind(SyntaxKind.ArrowFunction)) {
    for (const p of fn.getParameters()) {
      const name = p.getName()
      if (RENAMES[name]) tryRename(p, name, RENAMES[name], 'param')
    }
  }
  for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionExpression)) {
    for (const p of fn.getParameters()) {
      const name = p.getName()
      if (RENAMES[name]) tryRename(p, name, RENAMES[name], 'param')
    }
  }
  for (const fn of sf.getDescendantsOfKind(SyntaxKind.MethodDeclaration)) {
    for (const p of fn.getParameters()) {
      const name = p.getName()
      if (RENAMES[name]) tryRename(p, name, RENAMES[name], 'param')
    }
  }
}

console.log(`\nTotal renames: ${totalRenames}`)
console.log('Saving...')
project.saveSync()
console.log('Done.')
