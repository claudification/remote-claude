#!/usr/bin/env bun
/**
 * Phase 7: Rename Session* component / type / interface names to Conversation*.
 *
 * Skips CC-facing types:
 *   - SessionStart, SessionStartData (CC hook event)
 *   - SessionEnd (CC hook event string), SessionEndData (CC hook data)
 *   - SessionTransition* (CC session transitions in agent-host)
 */
import { Project } from 'ts-morph'

const project = new Project({
  tsConfigFilePath: './tsconfig.json',
  skipAddingFilesFromTsConfig: false,
})
project.addSourceFilesAtPaths('web/src/**/*.{ts,tsx}')
console.log(`Loaded ${project.getSourceFiles().length} source files`)

// SKIP - keep these as-is. They are CC-facing or already correctly named.
const SKIP = new Set([
  'SessionStart',
  'SessionStartData',
  'SessionEndData',
  'SessionTransition',
  'SessionTransitionKind',
  'SessionTransitionReason',
  'SessionTransitionSource',
])

const RENAMES: Record<string, string> = {
  // Components
  SessionBanner: 'ConversationBanner',
  SessionBannerProps: 'ConversationBannerProps',
  SessionCard: 'ConversationCard',
  SessionContextMenu: 'ConversationContextMenu',
  SessionDetail: 'ConversationDetail',
  SessionHeader: 'ConversationHeader',
  SessionHeaderProps: 'ConversationHeaderProps',
  SessionInfoButton: 'ConversationInfoButton',
  SessionInfoDialog: 'ConversationInfoDialog',
  SessionItemCompact: 'ConversationItemCompact',
  SessionItemFull: 'ConversationItemFull',
  SessionItemShell: 'ConversationItemShell',
  SessionItemTasksBlock: 'ConversationItemTasksBlock',
  SessionRow: 'ConversationRow',
  SessionRowProps: 'ConversationRowProps',
  SessionTabs: 'ConversationTabs',
  SessionTabsProps: 'ConversationTabsProps',
  SessionTag: 'ConversationTag',
  SessionTagProps: 'ConversationTagProps',
  // Types / interfaces
  SessionCompletion: 'ConversationCompletion',
  SessionInfoSnapshot: 'ConversationInfoSnapshot',
  SessionLike: 'ConversationLike',
  SessionNotFound: 'ConversationNotFound',
  SessionOverview: 'ConversationOverview',
  SessionRendezvous: 'ConversationRendezvous',
  SessionResultsProps: 'ConversationResultsProps',
  SessionShare: 'ConversationShare',
  SessionSnapshot: 'ConversationSnapshot',
  SessionsState: 'ConversationsState',
  SessionStore: 'ConversationStore',
  SessionSummary: 'ConversationSummary',
}

let totalRenames = 0
const notFound: string[] = []

for (const [oldName, newName] of Object.entries(RENAMES)) {
  if (SKIP.has(oldName)) continue
  let renamed = false
  // Rename via declaration so all references update
  for (const sf of project.getSourceFiles()) {
    // class
    const cls = sf.getClass(oldName)
    if (cls) {
      cls.rename(newName)
      console.log(`  rename class ${oldName} -> ${newName} in ${sf.getFilePath()}`)
      totalRenames++
      renamed = true
      continue
    }
    // interface
    const iface = sf.getInterface(oldName)
    if (iface) {
      iface.rename(newName)
      console.log(`  rename interface ${oldName} -> ${newName} in ${sf.getFilePath()}`)
      totalRenames++
      renamed = true
      continue
    }
    // type alias
    const ta = sf.getTypeAlias(oldName)
    if (ta) {
      ta.rename(newName)
      console.log(`  rename type ${oldName} -> ${newName} in ${sf.getFilePath()}`)
      totalRenames++
      renamed = true
      continue
    }
    // function declaration
    const fn = sf.getFunction(oldName)
    if (fn) {
      fn.rename(newName)
      console.log(`  rename function ${oldName} -> ${newName} in ${sf.getFilePath()}`)
      totalRenames++
      renamed = true
      continue
    }
    // variable declaration
    const v = sf.getVariableDeclaration(oldName)
    if (v) {
      v.rename(newName)
      console.log(`  rename const ${oldName} -> ${newName} in ${sf.getFilePath()}`)
      totalRenames++
      renamed = true
    }
  }
  if (!renamed) notFound.push(oldName)
}

console.log(`\nTotal renames: ${totalRenames}`)
if (notFound.length) {
  console.log(`Not found (no declaration matched): ${notFound.join(', ')}`)
}

console.log('\nSaving...')
project.saveSync()
console.log('Done.')
