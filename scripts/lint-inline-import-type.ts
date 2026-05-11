#!/usr/bin/env bun

/**
 * Inline-import-type lint: bans `import('...').Type` references inside
 * TypeScript type annotations. Types must be hoisted to a top-of-file
 * `import type { Type } from '...'` statement and referenced by bare name.
 *
 * Why: inline `import('...').Type` is invisible to "find all usages",
 * inconsistent with the rest of the codebase, harder to grep, and visually
 * mimics a runtime dynamic `import()` when it is purely a TS type reference.
 * See `.claude/CLAUDE.md` ("Linting & Formatting") for the rule.
 *
 * Scope: `.ts` / `.tsx` files under `src/` and `web/src/`. JSDoc
 * `@param {import('./x').Y}` in `.js` files stays -- that is a legitimate
 * use of the syntax. `.d.ts` declaration files are also skipped (auto-gen).
 *
 * Run: `bun run scripts/lint-inline-import-type.ts`
 * Exits 0 = clean, 1 = violations found.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Glob } from 'bun'

const ROOT = join(import.meta.dir, '..')
const SCAN_DIRS = ['src', 'web/src']

// Matches `import('<module>').<PascalCaseIdentifier>` -- the inline type form.
// Restricted to PascalCase identifiers because runtime dynamic imports
// (`import('foo').then(m => ...)`, `import('bar').toBlob`) use camelCase
// member access and are legitimate -- we only want to catch type references.
const INLINE_IMPORT_TYPE = /import\(\s*['"][^'"]+['"]\s*\)\s*\.\s*[A-Z][\w$]*/g

interface Violation {
  file: string
  line: number
  text: string
  match: string
}

const violations: Violation[] = []

for (const scanDir of SCAN_DIRS) {
  const absScanDir = join(ROOT, scanDir)
  const glob = new Glob('**/*.{ts,tsx}')
  const files = [...glob.scanSync({ cwd: absScanDir })]

  for (const relPath of files) {
    if (relPath.endsWith('.d.ts')) continue
    if (relPath.includes('node_modules/')) continue

    const absPath = join(absScanDir, relPath)
    const content = readFileSync(absPath, 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1

      // Skip line comments outright.
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//')) continue

      // Skip lines that look like JSDoc-style comments inside .ts files.
      // (Rare, but cheap to ignore.)
      if (trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

      // Reset regex state for each line scan.
      INLINE_IMPORT_TYPE.lastIndex = 0
      const matches = line.match(INLINE_IMPORT_TYPE)
      if (!matches) continue

      // Filter out matches that are inside string literals on the same line
      // (heuristic -- if the match is wrapped in quotes, skip it).
      for (const match of matches) {
        const matchIdx = line.indexOf(match)
        const before = line.slice(0, matchIdx)
        const singleQuotesBefore = (before.match(/'/g) || []).length
        const doubleQuotesBefore = (before.match(/"/g) || []).length
        const backticksBefore = (before.match(/`/g) || []).length
        const insideString =
          singleQuotesBefore % 2 === 1 || doubleQuotesBefore % 2 === 1 || backticksBefore % 2 === 1
        if (insideString) continue

        violations.push({
          file: join(scanDir, relPath),
          line: lineNum,
          text: line.trim(),
          match,
        })
      }
    }
  }
}

if (violations.length === 0) {
  console.log('[inline-import-type-lint] PASS -- no inline import(...).Type references')
  process.exit(0)
} else {
  console.error(`[inline-import-type-lint] FAIL -- ${violations.length} violation(s):\n`)
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`)
    console.error(`    ${v.text}`)
    console.error(`    match: ${v.match}`)
    console.error(`    fix: hoist to \`import type { ... } from '...'\` at top of file\n`)
  }
  console.error(`See .claude/CLAUDE.md ("Linting & Formatting") for the rule.`)
  process.exit(1)
}
