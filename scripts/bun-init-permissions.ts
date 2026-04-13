#!/usr/bin/env bun
/**
 * Trigger macOS permission dialogs for Bun by accessing protected resources.
 * Run once after install/update so dialogs don't ambush you mid-work.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const home = homedir()
const results: { check: string; status: string }[] = []

function report(check: string, status: string) {
  const icon = status === 'ok' ? '\x1b[32m✓\x1b[0m' : status === 'skip' ? '\x1b[33m-\x1b[0m' : '\x1b[31m✗\x1b[0m'
  console.log(`  ${icon} ${check}: ${status}`)
  results.push({ check, status })
}

async function tryAsync(check: string, fn: () => Promise<void>) {
  try {
    await fn()
    report(check, 'ok')
  } catch (e: any) {
    report(check, e.code || e.message || 'failed')
  }
}

function trySync(check: string, fn: () => void) {
  try {
    fn()
    report(check, 'ok')
  } catch (e: any) {
    report(check, e.code || e.message || 'failed')
  }
}

console.log('\n\x1b[1m--- Bun macOS Permission Initializer ---\x1b[0m\n')

// -- Protected filesystem locations --
console.log('\x1b[36mFilesystem (protected locations):\x1b[0m')

const protectedDirs = [
  ['Desktop', join(home, 'Desktop')],
  ['Documents', join(home, 'Documents')],
  ['Downloads', join(home, 'Downloads')],
  ['Movies', join(home, 'Movies')],
  ['Music', join(home, 'Music')],
  ['Pictures', join(home, 'Pictures')],
  ['/tmp', '/tmp'],
  ['/var/tmp', '/var/tmp'],
]

for (const [label, dir] of protectedDirs) {
  trySync(`Read ${label}`, () => {
    Bun.file(join(dir, '.bun-permission-probe')).size
  })
}

// Write test - create and remove a temp file in Documents
trySync('Write Documents', () => {
  const probe = join(home, 'Documents', '.bun-permission-probe')
  Bun.write(probe, 'probe')
  rmSync(probe)
})

// Write test - Downloads
trySync('Write Downloads', () => {
  const probe = join(home, 'Downloads', '.bun-permission-probe')
  Bun.write(probe, 'probe')
  rmSync(probe)
})

// Write test - Desktop
trySync('Write Desktop', () => {
  const probe = join(home, 'Desktop', '.bun-permission-probe')
  Bun.write(probe, 'probe')
  rmSync(probe)
})

// -- Network access --
console.log('\n\x1b[36mNetwork (outbound):\x1b[0m')

await tryAsync('Fetch google.com', async () => {
  const res = await fetch('https://www.google.com', { signal: AbortSignal.timeout(5000) })
  await res.arrayBuffer() // consume body
})

await tryAsync('Fetch cloudflare DNS', async () => {
  const res = await fetch('https://1.1.1.1/dns-query?name=example.com&type=A', {
    headers: { Accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5000),
  })
  await res.json()
})

await tryAsync('DNS resolve', async () => {
  // Bun.dns is available
  const addrs = await Bun.dns.lookup('example.com')
  if (!addrs.length) throw new Error('no results')
})

// -- Network listen --
console.log('\n\x1b[36mNetwork (listen):\x1b[0m')

await tryAsync('TCP listen :0', async () => {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data() {},
      open() {},
      close() {},
    },
  })
  server.stop()
})

await tryAsync('HTTP serve :0', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('ok'),
  })
  // Hit it once to prove it works
  const res = await fetch(`http://127.0.0.1:${server.port}/`)
  await res.text()
  server.stop()
})

// -- Subprocess --
console.log('\n\x1b[36mSubprocess:\x1b[0m')

await tryAsync('Spawn /bin/echo', async () => {
  const proc = Bun.spawn(['echo', 'hello'], { stdout: 'pipe' })
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(`exit ${proc.exitCode}`)
})

await tryAsync('Spawn /usr/bin/env', async () => {
  const proc = Bun.spawn(['env'], { stdout: 'pipe' })
  await proc.exited
})

// -- Temp files / mkdtemp --
console.log('\n\x1b[36mTemp filesystem:\x1b[0m')

trySync('mkdtemp', () => {
  const d = mkdtempSync(join(tmpdir(), 'bun-probe-'))
  rmSync(d, { recursive: true })
})

trySync('Bun.write /tmp', () => {
  const p = join(tmpdir(), `bun-probe-${Date.now()}`)
  Bun.write(p, 'probe')
  rmSync(p)
})

// -- Summary --
const ok = results.filter((r) => r.status === 'ok').length
const failed = results.filter((r) => r.status !== 'ok' && r.status !== 'skip').length
const skipped = results.filter((r) => r.status === 'skip').length

console.log(`\n\x1b[1m--- Done: ${ok} ok, ${failed} failed, ${skipped} skipped ---\x1b[0m`)
console.log('If you saw macOS permission dialogs, click Allow to grant Bun access.\n')
