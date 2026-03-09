import { useEffect, useState } from 'react'

interface DiagViewProps {
  sessionId: string
}

export function DiagView({ sessionId }: DiagViewProps) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null)
    setError(null)
    fetch(`/sessions/${sessionId}/diag`)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
      .then(setData)
      .catch(e => setError(String(e)))
  }, [sessionId])

  if (error) {
    return <div className="p-4 text-red-400 font-mono text-xs">{error}</div>
  }

  if (!data) {
    return <div className="p-4 text-muted-foreground font-mono text-xs">Loading...</div>
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3">
      <pre className="text-[11px] font-mono text-foreground/90 whitespace-pre-wrap break-all">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  )
}
