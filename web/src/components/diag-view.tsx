import { useEffect, useMemo, useState } from 'react'

interface DiagViewProps {
  sessionId: string
}

// Simple JSON -> YAML-ish string (no dependency needed)
function toYaml(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (obj === null || obj === undefined) return `${pad}~`
  if (typeof obj === 'boolean' || typeof obj === 'number') return `${pad}${obj}`
  if (typeof obj === 'string') {
    if (obj.includes('\n'))
      return `${pad}|\n${obj
        .split('\n')
        .map(l => `${pad}  ${l}`)
        .join('\n')}`
    if (obj.match(/[:#{}[\],&*?|>!%@`]/)) return `${pad}"${obj.replace(/"/g, '\\"')}"`
    return `${pad}${obj}`
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return `${pad}[]`
    // Compact arrays of primitives
    if (obj.every(v => typeof v !== 'object' || v === null)) {
      const inline = `[${obj.map(v => (typeof v === 'string' ? `"${v}"` : String(v))).join(', ')}]`
      if (inline.length < 80) return `${pad}${inline}`
    }
    return obj
      .map(item => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const entries = Object.entries(item)
          const first = entries[0]
          const rest = entries.slice(1)
          const firstLine = first ? `${pad}- ${first[0]}: ${toYaml(first[1], 0).trimStart()}` : `${pad}-`
          const restLines = rest.map(([k, v]) => {
            const val = toYaml(v, indent + 2).trimStart()
            return `${pad}  ${k}: ${val}`
          })
          return [firstLine, ...restLines].join('\n')
        }
        return `${pad}- ${toYaml(item, 0).trimStart()}`
      })
      .join('\n')
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>)
    if (entries.length === 0) return `${pad}{}`
    return entries
      .map(([k, v]) => {
        if (typeof v === 'object' && v !== null && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
          // Check if it's a compact array
          if (Array.isArray(v) && v.every(x => typeof x !== 'object' || x === null)) {
            const inline = `[${v.map(x => (typeof x === 'string' ? `"${x}"` : String(x))).join(', ')}]`
            if (inline.length < 80) return `${pad}${k}: ${inline}`
          }
          return `${pad}${k}:\n${toYaml(v, indent + 1)}`
        }
        const val = toYaml(v, 0).trimStart()
        return `${pad}${k}: ${val}`
      })
      .join('\n')
  }
  return `${pad}${String(obj)}`
}

// Lazy Shiki highlighter (reuses transcript-view's singleton)
let highlightPromise: Promise<any> | null = null

function getHighlighter() {
  if (!highlightPromise) {
    highlightPromise = import('shiki/bundle/web').then(m =>
      m.createHighlighter({ themes: ['tokyo-night'], langs: ['yaml'] }),
    )
  }
  return highlightPromise
}

export function DiagView({ sessionId }: DiagViewProps) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const mnemonic = `diag:${sessionId}`

  useEffect(() => {
    setData(null)
    setError(null)
    setHighlighted(null)
    fetch(`/sessions/${sessionId}/diag`)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
      .then(setData)
      .catch(e => setError(String(e)))
  }, [sessionId])

  const yaml = useMemo(() => (data ? toYaml(data) : ''), [data])

  useEffect(() => {
    if (!yaml) return
    getHighlighter()
      .then(hl => {
        const html = hl.codeToHtml(yaml, { lang: 'yaml', theme: 'tokyo-night' })
        setHighlighted(html)
      })
      .catch(() => {})
  }, [yaml])

  function handleCopy() {
    const text = `# ${mnemonic}\n\n${yaml}`
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  function handleCopyMnemonic() {
    navigator.clipboard.writeText(mnemonic)
  }

  if (error) {
    return <div className="p-4 text-red-400 font-mono text-xs">{error}</div>
  }

  if (!data) {
    return <div className="p-4 text-muted-foreground font-mono text-xs">Loading...</div>
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <button
          type="button"
          onClick={handleCopyMnemonic}
          className="font-mono text-[11px] text-muted-foreground hover:text-accent transition-colors cursor-pointer select-all"
          title="Click to copy mnemonic"
        >
          {mnemonic}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleCopy}
          className="px-2 py-1 text-[10px] font-mono border border-border hover:border-accent hover:text-accent text-muted-foreground transition-colors"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {highlighted ? (
          <div
            className="text-[11px] font-mono [&_pre]:!bg-transparent [&_code]:!bg-transparent"
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <pre className="text-[11px] font-mono text-foreground/90 whitespace-pre-wrap">{yaml}</pre>
        )}
      </div>
    </div>
  )
}
