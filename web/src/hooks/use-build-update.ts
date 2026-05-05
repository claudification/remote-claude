import { useEffect, useState } from 'react'
import { PRE_RELOAD_KEY } from '@/lib/utils'
import { BUILD_VERSION } from '../../../src/shared/version'

export interface BuildUpdate {
  from: string | null
  to: string | null
}

export function useBuildUpdate() {
  const [swUpdate, setSwUpdate] = useState<BuildUpdate | null>(null)

  // Listen for service worker update notifications
  useEffect(() => {
    function handleSwMessage(event: MessageEvent) {
      if (event.data?.type === 'sw-updated') {
        setSwUpdate({ from: event.data.from ?? null, to: event.data.to ?? null })
      }
    }
    navigator.serviceWorker?.addEventListener('message', handleSwMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', handleSwMessage)
  }, [])

  // Poll asset-manifest.json to detect new builds (primary update detection)
  useEffect(() => {
    let knownHash: string | null = null

    async function checkManifest() {
      try {
        const res = await fetch(`/asset-manifest.json?_=${Date.now()}`)
        if (!res.ok) return
        const manifest = await res.json()
        const hash = manifest.buildHash as string
        if (!hash) return
        if (knownHash === null) {
          knownHash = hash
        } else if (hash !== knownHash) {
          setSwUpdate({ from: knownHash, to: hash })
        }
      } catch {}
    }

    checkManifest()
    const timer = setInterval(checkManifest, 5 * 60 * 1000)
    return () => clearInterval(timer)
  }, [])

  // Post-reload feedback: detect whether clearCacheAndReload actually moved us
  // to a new build, and surface a toast either way.
  useEffect(() => {
    let stashed: string | null
    try {
      stashed = localStorage.getItem(PRE_RELOAD_KEY)
    } catch {
      return
    }
    if (!stashed) return
    try {
      localStorage.removeItem(PRE_RELOAD_KEY)
    } catch {}
    try {
      const { hash, ts } = JSON.parse(stashed) as { hash: string; ts: number }
      if (!hash || typeof ts !== 'number' || Date.now() - ts > 5 * 60 * 1000) return
      const current = BUILD_VERSION.gitHashShort
      if (current && current !== hash) {
        window.dispatchEvent(
          new CustomEvent('rclaude-toast', {
            detail: { title: 'UPDATED', body: `Web build ${hash} -> ${current}` },
          }),
        )
      } else {
        window.dispatchEvent(
          new CustomEvent('rclaude-toast', {
            detail: { title: 'NO UPDATE', body: `Already on latest build (${hash})` },
          }),
        )
        setSwUpdate(null)
      }
    } catch {}
  }, [])

  return { swUpdate, setSwUpdate }
}
