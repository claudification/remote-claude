import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

const LINKS_API = `${window.location.protocol}//${window.location.host}/api/links`

interface LinkItem {
  cwdA: string
  cwdB: string
  nameA: string
  nameB: string
  createdAt: number
  lastUsed: number
  online: boolean
  sessionIdA?: string
  sessionIdB?: string
}

function formatAge(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

export function ProjectLinksSection() {
  const [links, setLinks] = useState<LinkItem[]>([])
  const [loading, setLoading] = useState(true)

  const fetchLinks = useCallback(async () => {
    try {
      const res = await fetch(LINKS_API)
      if (!res.ok) return
      const data = (await res.json()) as { links: LinkItem[] }
      setLinks(data.links)
    } catch {
      // network error
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchLinks()
  }, [fetchLinks])

  async function removeLink(cwdA: string, cwdB: string) {
    await fetch(LINKS_API, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwdA, cwdB }),
    })
    fetchLinks()
  }

  if (loading) return <div className="text-xs text-muted-foreground font-mono">Loading...</div>

  if (links.length === 0) {
    return (
      <div className="text-xs text-muted-foreground font-mono py-2">
        No project links. Links are created when you approve inter-project messaging.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {links.map(link => (
        <div key={`${link.cwdA}:${link.cwdB}`} className="flex items-center gap-2 text-xs">
          <span className={cn('w-2 h-2 rounded-full shrink-0', link.online ? 'bg-green-400' : 'bg-zinc-600')} />
          <span className="text-teal-400 font-mono truncate">{link.nameA}</span>
          <span className="text-muted-foreground">↔</span>
          <span className="text-sky-400 font-mono truncate">{link.nameB}</span>
          <span className="text-[9px] text-muted-foreground/50 ml-auto shrink-0">{formatAge(link.lastUsed)}</span>
          <button
            type="button"
            onClick={() => removeLink(link.cwdA, link.cwdB)}
            className="text-[9px] text-muted-foreground hover:text-destructive shrink-0"
          >
            x
          </button>
        </div>
      ))}
    </div>
  )
}
