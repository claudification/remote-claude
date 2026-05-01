#!/usr/bin/env bun
/**
 * AST-aware rename using ts-morph.
 * Renames TypeScript symbols (types, interfaces, fields, functions) with full
 * reference tracking -- no regex needed.
 */
import { Project, SyntaxKind } from 'ts-morph'

const project = new Project({
  tsConfigFilePath: './tsconfig.json',
  skipAddingFilesFromTsConfig: false,
})

// Also add web files
project.addSourceFilesAtPaths('web/src/**/*.{ts,tsx}')

console.log(`Loaded ${project.getSourceFiles().length} source files`)

// ============================================================
// Phase 1: Rename interface/type names (Session -> Conversation)
// ============================================================

const PROTECTED_TYPES = new Set([
  'SessionStart',
  'SessionEnd',
  'SessionClear',
  'SessionPromote',
  'SessionStartData',
  'SessionEndData',
])

const TYPE_RENAMES: Record<string, string> = {
  // Protocol types
  Session: 'Conversation',
  SessionMeta: 'ConversationMeta',
  SessionEnd: 'ConversationEnd', // this is OUR SessionEnd, not CC's
  SessionSummary: 'ConversationSummary',
  SessionNameUpdate: 'ConversationNameUpdate',
  SessionInfoUpdate: 'ConversationInfoUpdate',
  SessionStatusSignal: 'ConversationStatusSignal',
  SessionControl: 'ConversationControl',
  SessionControlAction: 'ConversationControlAction',
  SessionControlResult: 'ConversationControlResult',
  QuitSession: 'QuitConversation',
  ReviveSession: 'ReviveConversation',
  SpawnSession: 'SpawnConversation',
  SessionName: 'ConversationName',
  SessionUri: 'ConversationUri',
  SessionId: 'ConversationId',
  SessionStatus: 'ConversationStatus',
  SessionUpdate: 'ConversationUpdate',
  SessionCreated: 'ConversationCreated',
  SessionDismissed: 'ConversationDismissed',
  SessionViewed: 'ConversationViewed',
  SessionExit: 'ConversationExit',
  SessionGroup: 'ConversationGroup',
  SessionSpawnResult: 'ConversationSpawnResult',
  SessionInfo: 'ConversationInfo',
  SessionNotFound: 'ConversationNotFound',
  SessionStats: 'ConversationStats',
  InterSessionListResponse: 'InterConversationListResponse',
  InterSessionListEntry: 'InterConversationListEntry',
  // Store types
  SessionStore: 'ConversationStore',
  SessionRecord: 'ConversationRecord',
  SessionSummaryRecord: 'ConversationSummaryRecord',
  SessionCreate: 'ConversationCreate',
  SessionFilter: 'ConversationFilter',
  SessionPatch: 'ConversationPatch',
  SessionOrder: 'ConversationOrder',
  SessionOrderEntry: 'ConversationOrderEntry',
  SessionOrderTree: 'ConversationOrderTree',
  SessionNameMode: 'ConversationNameMode',
  DashboardMessage: 'ControlPanelMessage',
}

// ============================================================
// Phase 2: Rename the sessionId FIELD on protocol interfaces
// where it means "conversation routing ID" (not CC session ID)
// ============================================================

// Interfaces where sessionId should become conversationId
// (these are the ones that DON'T have a separate conversationId field)
const FIELD_RENAME_INTERFACES = [
  'HookEvent',
  'Heartbeat',
  'DiagLog',
  'TasksUpdate',
  'TranscriptEntries',
  'SubagentTranscript',
  'BgTaskOutput',
  'WrapperNotify',
  'SessionNameUpdate',
  'SessionInfoUpdate',
  'SessionStatusSignal',
  'StreamDelta',
  'WrapperRateLimit',
  'ClipboardCapture',
  'SendInput',
  'TranscriptRequest',
  'SubagentTranscriptRequest',
  'TranscriptKick',
  'LinkSummary',
  'ProjectLinkResponse',
  'AskQuestionRequest',
  'AskQuestionResponse',
  'DialogShowMessage',
  'DialogResultMessage',
  'DialogDismissMessage',
  'PlanApprovalRequest',
  'PlanApprovalResponse',
  'PlanModeChanged',
  'PermissionRequest',
  'PermissionResponse',
  'SendInterrupt',
  'QuitSession',
  'MonitorUpdate',
  'ScheduledTaskFire',
  'ChannelSubscribe',
  'ChannelUnsubscribe',
  'ChannelAck',
  'ChannelStats',
  // Store types
  'SessionRecord',
  'SessionSummaryRecord',
  'SessionCreate',
  'SessionFilter',
  'SessionPatch',
  // Other
  'PushPayload',
  'SharedFileEntry',
  'CumulativeTurnInput',
]

// Do the renames
const protocolFile = project.getSourceFileOrThrow('src/shared/protocol.ts')

// Phase 2 first (field renames) -- before type renames change the interface names
console.log('\n=== Phase 2: Rename sessionId fields ===')
let fieldRenameCount = 0

for (const ifaceName of FIELD_RENAME_INTERFACES) {
  const iface = protocolFile.getInterface(ifaceName)
  if (!iface) {
    // Try other source files
    let found = false
    for (const sf of project.getSourceFiles()) {
      const i = sf.getInterface(ifaceName)
      if (i) {
        const prop = i.getProperty('sessionId')
        if (prop) {
          prop.rename('conversationId')
          fieldRenameCount++
          console.log(`  Renamed sessionId -> conversationId in ${ifaceName} (${sf.getBaseName()})`)
          found = true
        }
        break
      }
    }
    if (!found) {
      // Try type aliases
      for (const sf of project.getSourceFiles()) {
        const t = sf.getTypeAlias(ifaceName)
        if (t) {
          console.log(`  SKIP type alias ${ifaceName} (manual fix needed)`)
          break
        }
      }
    }
    continue
  }

  const prop = iface.getProperty('sessionId')
  if (prop) {
    prop.rename('conversationId')
    fieldRenameCount++
    console.log(`  Renamed sessionId -> conversationId in ${ifaceName}`)
  }
}

console.log(`  Total field renames: ${fieldRenameCount}`)

// Phase 1: Type renames
console.log('\n=== Phase 1: Rename types ===')
let typeRenameCount = 0

for (const [oldName, newName] of Object.entries(TYPE_RENAMES)) {
  if (PROTECTED_TYPES.has(oldName)) continue

  for (const sf of project.getSourceFiles()) {
    // Try interfaces
    const iface = sf.getInterface(oldName)
    if (iface) {
      iface.rename(newName)
      typeRenameCount++
      console.log(`  Renamed interface ${oldName} -> ${newName}`)
      break
    }

    // Try type aliases
    const typeAlias = sf.getTypeAlias(oldName)
    if (typeAlias) {
      typeAlias.rename(newName)
      typeRenameCount++
      console.log(`  Renamed type ${oldName} -> ${newName}`)
      break
    }

    // Try enums
    const enumDecl = sf.getEnum(oldName)
    if (enumDecl) {
      enumDecl.rename(newName)
      typeRenameCount++
      console.log(`  Renamed enum ${oldName} -> ${newName}`)
      break
    }
  }
}

console.log(`  Total type renames: ${typeRenameCount}`)

// ============================================================
// Phase 3: Rename functions
// ============================================================
console.log('\n=== Phase 3: Rename functions ===')

const FUNC_RENAMES: Record<string, string> = {
  generateSessionName: 'generateConversationName',
  sanitizeSessionName: 'sanitizeConversationName',
  isSameProjectSession: 'isSameProjectConversation',
  sessionNameFromSlug: 'conversationNameFromSlug',
  deriveSessionName: 'deriveConversationName',
  createSessionStore: 'createConversationStore',
}

let funcRenameCount = 0

for (const [oldName, newName] of Object.entries(FUNC_RENAMES)) {
  for (const sf of project.getSourceFiles()) {
    const funcs = sf.getFunctions().filter(f => f.getName() === oldName)
    for (const fn of funcs) {
      fn.rename(newName)
      funcRenameCount++
      console.log(`  Renamed function ${oldName} -> ${newName}`)
    }

    // Also check variable declarations (const foo = ...)
    for (const varStmt of sf.getVariableStatements()) {
      for (const decl of varStmt.getDeclarations()) {
        if (decl.getName() === oldName) {
          decl.rename(newName)
          funcRenameCount++
          console.log(`  Renamed variable ${oldName} -> ${newName}`)
        }
      }
    }
  }
}

console.log(`  Total function renames: ${funcRenameCount}`)

// Save all changes
console.log('\n=== Saving ===')
project.saveSync()
console.log('Done! Run tsc --noEmit to check for errors.')
