#!/usr/bin/env bun
// Build script for the broker binary.
//
// Refuses to run on a dirty working tree (host invocations). Inside Docker
// builds there is no .git, so the dirty check no-ops -- the docker wrapper
// (scripts/docker-build-broker.sh) is responsible for enforcing the check
// before populating the build context via `git archive HEAD`.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { parseForceDirty, requireCleanTree } from './lib/require-clean-tree'

const ROOT = join(import.meta.dir, '..')
const OUT_FILE = join(ROOT, 'bin', 'broker')

async function build() {
  requireCleanTree(ROOT, {
    label: 'build:broker',
    forceDirty: parseForceDirty(process.argv),
    ignorePaths: ['src/shared/version.ts'],
  })

  console.log('[build] Building broker...')

  const result = await Bun.build({
    entrypoints: [join(ROOT, 'src', 'broker', 'index.ts')],
    compile: {
      outfile: OUT_FILE,
    },
    minify: true,
  })

  if (!result.success) {
    console.error('[build] Failed:')
    for (const log of result.logs) {
      console.error(log)
    }
    process.exit(1)
  }

  console.log(`[build] Created ${OUT_FILE}`)

  const stat = await Bun.file(OUT_FILE).stat()
  const sizeMB = (stat?.size || 0) / 1024 / 1024
  console.log(`[build] Size: ${sizeMB.toFixed(2)} MB`)

  if (process.platform === 'darwin') {
    spawnSync('codesign', ['--remove-signature', OUT_FILE], { stdio: 'inherit' })
    const sign = spawnSync('codesign', ['--force', '--sign', '-', OUT_FILE], {
      stdio: 'inherit',
    })
    if (sign.status !== 0) {
      console.error('[build] Warning: codesign failed')
    }
  }
}

build()
