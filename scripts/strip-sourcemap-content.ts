#!/usr/bin/env bun
// Strip `sourcesContent` from a sourcemap. Bun's stack traces resolve via
// debugId/mappings; sources/sourcesContent only matter for IDE source-of-line
// previews -- which we don't need and don't want to ship to npm consumers.
//
// Usage: bun run scripts/strip-sourcemap-content.ts <map-file> [<map-file>...]
//
// Typical reduction on the rclaude bundle: 2.6 MB -> ~720 KB.

import { existsSync, statSync } from 'node:fs'

if (process.argv.length < 3) {
  console.error('usage: strip-sourcemap-content.ts <map-file> [<map-file>...]')
  process.exit(1)
}

for (const path of process.argv.slice(2)) {
  if (!existsSync(path)) {
    console.error(`skip: ${path} (not found)`)
    continue
  }
  const before = statSync(path).size
  const file = Bun.file(path)
  const map = JSON.parse(await file.text())
  delete map.sourcesContent
  const json = JSON.stringify(map)
  await Bun.write(path, json)
  console.log(`${path}: ${(before / 1024).toFixed(0)} KB -> ${(json.length / 1024).toFixed(0)} KB`)
}
