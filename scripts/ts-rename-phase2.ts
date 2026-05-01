#!/usr/bin/env bun
/**
 * Phase 2: Rename remaining functions and variables using ts-morph.
 * These are store methods, frontend hooks, utility functions.
 */
import { Project } from 'ts-morph'

const project = new Project({
  tsConfigFilePath: './tsconfig.json',
  skipAddingFilesFromTsConfig: false,
})
project.addSourceFilesAtPaths('web/src/**/*.{ts,tsx}')

console.log(`Loaded ${project.getSourceFiles().length} source files`)

const RENAMES: [string, string, string?][] = [
  // session-store methods (defined as inner functions in createConversationStore)
  // These are harder -- they're local functions inside a closure, not module-level.
  // ts-morph can find them via workspaceSymbol or by navigating the AST.

  // Shared utility files
  ['sessionNameFromSlug', 'conversationNameFromSlug', 'src/shared/spawn-naming.ts'],

  // session-names.ts exports
  // Already renamed generateSessionName and sanitizeSessionName in phase 1

  // session-order.ts functions
  ['loadSessionOrder', 'loadConversationOrder', undefined],
  ['saveSessionOrder', 'saveConversationOrder', undefined],
  ['filterSessionOrderTree', 'filterConversationOrderTree', undefined],
  ['buildSessionOrderTree', 'buildConversationOrderTree', undefined],
]

let count = 0

for (const [oldName, newName, specificFile] of RENAMES) {
  const files = specificFile ? [project.getSourceFile(specificFile)].filter(Boolean) : project.getSourceFiles()

  for (const sf of files) {
    if (!sf) continue

    // Try function declarations
    for (const fn of sf.getFunctions()) {
      if (fn.getName() === oldName) {
        fn.rename(newName)
        count++
        console.log(`  Renamed function ${oldName} -> ${newName} in ${sf.getBaseName()}`)
      }
    }

    // Try variable declarations
    for (const stmt of sf.getVariableStatements()) {
      for (const decl of stmt.getDeclarations()) {
        if (decl.getName() === oldName) {
          decl.rename(newName)
          count++
          console.log(`  Renamed variable ${oldName} -> ${newName} in ${sf.getBaseName()}`)
        }
      }
    }
  }
}

// Rename the Zustand store hook
for (const sf of project.getSourceFiles()) {
  if (!sf.getBaseName().includes('use-sessions')) continue

  // Find useSessionsStore
  for (const stmt of sf.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      if (decl.getName() === 'useSessionsStore') {
        decl.rename('useConversationsStore')
        count++
        console.log(`  Renamed useSessionsStore -> useConversationsStore`)
      }
    }
  }

  // Find exported functions
  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    if (!name) continue
    const renames: Record<string, string> = {
      selectSession: 'selectConversation',
    }
    if (renames[name]) {
      fn.rename(renames[name])
      count++
      console.log(`  Renamed ${name} -> ${renames[name]}`)
    }
  }
}

console.log(`\nTotal: ${count} renames`)
project.saveSync()
console.log('Saved. Run tsc --noEmit to verify.')
