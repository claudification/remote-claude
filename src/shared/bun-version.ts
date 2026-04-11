/**
 * Minimum Bun version enforcement. Called on startup by all binaries.
 * Exits with a clear error if the running Bun is too old.
 */

const MIN_BUN_VERSION = '1.3.6'

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0
    const vb = pb[i] || 0
    if (va !== vb) return va - vb
  }
  return 0
}

export function checkBunVersion() {
  // biome-ignore lint/suspicious/noExplicitAny: Bun global not typed in web tsconfig
  const bun = (globalThis as any).Bun
  if (!bun?.version) return // not running in Bun (e.g. type-checked from web)
  const current = bun.version as string
  if (compareVersions(current, MIN_BUN_VERSION) < 0) {
    console.error(`ERROR: Bun ${current} is too old. Minimum required: ${MIN_BUN_VERSION}`)
    console.error('       Run: bun upgrade')
    process.exit(1)
  }
}
