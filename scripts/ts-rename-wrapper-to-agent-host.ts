#!/usr/bin/env bun
/**
 * Phase: rename `wrapper` -> `agent-host` across the codebase.
 *
 * Per .claude/docs/plan-fabric.md, the process that hosts the Agent
 * (Claude Code) is the **Agent Host**. The legacy term `wrapper` survived
 * the directory rename (`src/wrapper` -> `src/agent-host`) but the wire
 * types, message-type strings, function names, and UI strings still say
 * "wrapper" in many places.
 *
 * This script does three jobs, all via ts-morph (no sed):
 *
 *   1. Rename TYPE / INTERFACE / TYPE-ALIAS / FUNCTION / VARIABLE
 *      DECLARATIONS by symbol; ts-morph propagates to every reference.
 *
 *   2. Replace STRING LITERAL VALUES that are wire-protocol message types
 *      (`'wrapper_boot'` -> `'agent_host_boot'`, etc).
 *
 *   3. Replace UI-VISIBLE STRINGS (JSX text + template literals) that
 *      leak the old term to the user.
 *
 * Comments and identifier-like substrings inside unrelated strings are
 * NOT touched -- those are a follow-up cleanup PR.
 */

import { Node, Project, SyntaxKind } from 'ts-morph'

// ─── 1. Identifier renames ─────────────────────────────────────────

/** Symbol-level renames. ts-morph follows the symbol so all references update. */
const IDENTIFIER_RENAMES: Array<[string, string]> = [
  // Wire-protocol type names (PascalCase)
  ['WrapperBoot', 'AgentHostBoot'],
  ['WrapperNotify', 'AgentHostNotify'],
  ['WrapperLaunchEvent', 'AgentHostLaunchEvent'],
  ['WrapperLaunchPhase', 'AgentHostLaunchPhase'],
  ['WrapperLaunchStep', 'AgentHostLaunchStep'],
  ['WrapperRateLimit', 'AgentHostRateLimit'],

  // Function / handler names (camelCase)
  ['wrapperBoot', 'agentHostBoot'],

  // Variable names. closeWrapperId aliases what the conversation lifecycle
  // calls conversationId (per fabric plan, wrapperId IS conversationId), so
  // rename to closeConversationId, not closeAgentHostId.
  ['closeWrapperId', 'closeConversationId'],
]

// ─── 2. Wire-protocol string-literal value rewrites ────────────────

/**
 * String values that travel on the wire as message type discriminators.
 * Replaced ONLY when they appear as a complete StringLiteral (so we don't
 * touch comments or unrelated identifier text).
 */
const STRING_LITERAL_RENAMES: Record<string, string> = {
  wrapper_boot: 'agent_host_boot',
  wrapper_started: 'agent_host_started',
  wrapper_booted: 'agent_host_booted',
}

// ─── 3. UI-visible string fragments ────────────────────────────────

/**
 * Substrings inside JSX text or template literals that leak "wrapper" to
 * the user. Each entry is [find, replace]; we apply them as plain string
 * .replace() inside StringLiteral / NoSubstitutionTemplateLiteral /
 * TemplateExpression text -- never inside identifiers or comments.
 */
const UI_TEXT_RENAMES: Array<[string, string]> = [
  ['No wrapper connected', 'No agent host connected'],
  ['wrapper=${', 'agentHost=${'],
]

// ─── Driver ────────────────────────────────────────────────────────

function loadProject(tsConfigPath: string, glob: string): Project {
  const project = new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: false,
  })
  project.addSourceFilesAtPaths(glob)
  return project
}

const root = loadProject('./tsconfig.json', 'src/**/*.{ts,tsx}')
const web = loadProject('./web/tsconfig.json', 'web/src/**/*.{ts,tsx}')

console.log(`Loaded ${root.getSourceFiles().length} root + ${web.getSourceFiles().length} web source files`)

let identifierRenameCount = 0
let stringLiteralCount = 0
let uiTextCount = 0
const notFound: string[] = []

// ─── Pass 1: declaration-based renames ─────────────────────────────

for (const [oldName, newName] of IDENTIFIER_RENAMES) {
  let renamedAny = false

  for (const proj of [root, web]) {
    for (const sf of proj.getSourceFiles()) {
      // Match by declaration kind so the rename propagates correctly.
      const candidates: Array<{ kind: string; node: { rename(n: string): void } }> = []

      const cls = sf.getClass(oldName)
      if (cls) candidates.push({ kind: 'class', node: cls })
      const iface = sf.getInterface(oldName)
      if (iface) candidates.push({ kind: 'interface', node: iface })
      const ta = sf.getTypeAlias(oldName)
      if (ta) candidates.push({ kind: 'type', node: ta })
      const fn = sf.getFunction(oldName)
      if (fn) candidates.push({ kind: 'function', node: fn })

      // Variable declarations (top-level + nested).
      for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const ident = vd.getNameNode()
        if (Node.isIdentifier(ident) && ident.getText() === oldName) {
          candidates.push({ kind: 'variable', node: vd })
        }
      }

      // Function parameters (rare for these names but possible).
      for (const p of sf.getDescendantsOfKind(SyntaxKind.Parameter)) {
        const ident = p.getNameNode()
        if (Node.isIdentifier(ident) && ident.getText() === oldName) {
          candidates.push({ kind: 'parameter', node: p })
        }
      }

      for (const { kind, node } of candidates) {
        try {
          node.rename(newName)
          identifierRenameCount++
          renamedAny = true
          console.log(`  ✓ ${oldName} -> ${newName} (${kind} in ${sf.getBaseName()})`)
        } catch (err) {
          console.warn(`  ! rename failed for ${oldName} (${kind}): ${(err as Error).message}`)
        }
      }
    }
  }

  if (!renamedAny) notFound.push(oldName)
}

// ─── Pass 2: wire string-literal values ────────────────────────────

for (const proj of [root, web]) {
  for (const sf of proj.getSourceFiles()) {
    for (const lit of sf.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
      const v = lit.getLiteralValue()
      if (Object.hasOwn(STRING_LITERAL_RENAMES, v)) {
        lit.setLiteralValue(STRING_LITERAL_RENAMES[v])
        stringLiteralCount++
      }
    }
    // No-substitution template literals (`type: \`wrapper_boot\``).
    for (const lit of sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
      const v = lit.getLiteralValue()
      if (Object.hasOwn(STRING_LITERAL_RENAMES, v)) {
        lit.setLiteralValue(STRING_LITERAL_RENAMES[v])
        stringLiteralCount++
      }
    }
  }
}

// ─── Pass 3: UI-visible string fragments ───────────────────────────

function rewriteText(originalText: string): string | null {
  let next = originalText
  for (const [find, replace] of UI_TEXT_RENAMES) {
    if (next.includes(find)) next = next.split(find).join(replace)
  }
  return next === originalText ? null : next
}

for (const proj of [root, web]) {
  for (const sf of proj.getSourceFiles()) {
    // Plain string literals.
    for (const lit of sf.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
      const v = lit.getLiteralValue()
      const rewritten = rewriteText(v)
      if (rewritten !== null) {
        lit.setLiteralValue(rewritten)
        uiTextCount++
      }
    }
    // No-substitution templates.
    for (const lit of sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
      const v = lit.getLiteralValue()
      const rewritten = rewriteText(v)
      if (rewritten !== null) {
        lit.setLiteralValue(rewritten)
        uiTextCount++
      }
    }
    // Template head/middle/tail spans inside template expressions.
    for (const span of sf.getDescendantsOfKind(SyntaxKind.TemplateExpression)) {
      // Head
      const head = span.getHead()
      const headText = head.getLiteralText()
      const headRewritten = rewriteText(headText)
      if (headRewritten !== null) {
        // Replace the head text by editing the source-file text directly --
        // ts-morph doesn't expose a setLiteralText on TemplateHead.
        const start = head.getStart() + 1 // skip backtick
        const end = head.getEnd() - 2 // skip ${
        sf.replaceText([start, end], headRewritten)
        uiTextCount++
      }
      for (const middle of span.getTemplateSpans()) {
        const mid = middle.getLiteral()
        const midText = mid.getLiteralText()
        const midRewritten = rewriteText(midText)
        if (midRewritten !== null) {
          const start = mid.getStart() + 1 // skip }
          const end = mid.getEnd() - (mid.getKind() === SyntaxKind.TemplateTail ? 1 : 2)
          sf.replaceText([start, end], midRewritten)
          uiTextCount++
        }
      }
    }
    // JSX text nodes.
    for (const jsx of sf.getDescendantsOfKind(SyntaxKind.JsxText)) {
      const v = jsx.getText()
      const rewritten = rewriteText(v)
      if (rewritten !== null) {
        jsx.replaceWithText(rewritten)
        uiTextCount++
      }
    }
  }
}

// ─── Save ──────────────────────────────────────────────────────────

console.log('')
console.log(`identifier renames: ${identifierRenameCount}`)
console.log(`string-literal value renames: ${stringLiteralCount}`)
console.log(`ui-text renames: ${uiTextCount}`)
if (notFound.length) console.log(`identifiers not found as declarations: ${notFound.join(', ')}`)

console.log('\nSaving...')
root.saveSync()
web.saveSync()
console.log('Done.')
