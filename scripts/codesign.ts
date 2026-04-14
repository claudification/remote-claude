#!/usr/bin/env bun
/**
 * Ad-hoc codesign a compiled binary on macOS.
 *
 * Bun's `bun build --compile` produces Mach-O binaries with a corrupt
 * LC_CODE_SIGNATURE section (as of Bun 1.3.12). macOS Sequoia 15.4+
 * enforces AppleSystemPolicy which SIGKILL's binaries whose code
 * signature is invalid. The workaround: strip the bad signature, then
 * ad-hoc re-sign.
 *
 * No-op on non-macOS platforms.
 */

import { spawnSync } from 'node:child_process'

const file = process.argv[2]
if (!file) {
  console.error('Usage: bun run codesign <binary>')
  process.exit(1)
}

if (process.platform !== 'darwin') {
  process.exit(0)
}

// Strip the corrupt signature Bun embeds, then ad-hoc re-sign
spawnSync('codesign', ['--remove-signature', file], { stdio: 'inherit' })

const result = spawnSync('codesign', ['--force', '--sign', '-', file], {
  stdio: 'inherit',
})

if (result.status !== 0) {
  console.error(`[codesign] Failed to sign ${file}`)
  process.exit(1)
}
