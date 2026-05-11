#!/usr/bin/env bun
// Build script for the npm-distributed packages:
//   - @claudewerk/claude-agent-host  -> packages/claude-agent-host/bin/rclaude
//   - @claudewerk/opencode-agent-host -> packages/opencode-agent-host/bin/opencode-host
//   - @claudewerk/sentinel           -> packages/sentinel/bin/sentinel
//
// Same dirty-tree refusal as build-broker. These bundles are what `~/.bun/bin/rclaude`
// and `~/.bun/bin/sentinel` resolve to via chained symlinks -- shipping WIP here
// poisons every new conversation and the running sentinel.
//
// Commit SHA is baked in via gen-version.ts (BUILD_VERSION.gitHash). Inspect with:
//   bun -e "import('./packages/sentinel/bin/sentinel').then(...)"  -- nope, compiled.
//   Or: `grep -ao 'gitHash[^,]*' packages/sentinel/bin/sentinel | head -1`

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { parseForceDirty, requireCleanTree } from './lib/require-clean-tree'

const ROOT = join(import.meta.dir, '..')

interface PackageBuild {
  name: string
  entry: string
  outdir: string
  binName: string
}

const TARGETS: PackageBuild[] = [
  {
    name: 'claude-agent-host',
    entry: 'src/claude-agent-host/index.ts',
    outdir: 'packages/claude-agent-host/bin',
    binName: 'rclaude',
  },
  {
    name: 'opencode-agent-host',
    entry: 'src/opencode-agent-host/index.ts',
    outdir: 'packages/opencode-agent-host/bin',
    binName: 'opencode-host',
  },
  {
    name: 'sentinel',
    entry: 'src/sentinel/index.ts',
    outdir: 'packages/sentinel/bin',
    binName: 'sentinel',
  },
]

function run(cmd: string[]): void {
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', cwd: ROOT })
  if (r.status !== 0) {
    console.error(`[build:packages] command failed: ${cmd.join(' ')}`)
    process.exit(r.status ?? 1)
  }
}

async function main() {
  const { commit, short, dirty } = requireCleanTree(ROOT, {
    label: 'build:packages',
    forceDirty: parseForceDirty(process.argv),
    ignorePaths: ['src/shared/version.ts'],
  })

  console.log(`[build:packages] commit=${short}${dirty ? '-dirty' : ''} (${commit})`)

  // Regenerate version.ts so the bundles carry the SHA we just verified.
  run(['bun', 'run', 'gen-version'])

  for (const t of TARGETS) {
    mkdirSync(join(ROOT, t.outdir), { recursive: true })
    console.log(`[build:packages] -> ${t.outdir}/${t.binName}`)
    run([
      'bun',
      'build',
      t.entry,
      '--target=bun',
      '--minify',
      '--sourcemap=external',
      '--outdir',
      t.outdir,
      '--entry-naming',
      t.binName,
    ])
  }

  // Strip sourcemap content (privacy: don't ship readable source to npm).
  const maps = TARGETS.map(t => join(t.outdir, `${t.binName}.map`))
  run(['bun', 'run', 'scripts/strip-sourcemap-content.ts', ...maps])

  // chmod +x the produced binaries.
  for (const t of TARGETS) {
    await chmod(join(ROOT, t.outdir, t.binName), 0o755)
  }

  console.log(`[build:packages] done. commit=${short}${dirty ? '-dirty' : ''}`)
}

main()
