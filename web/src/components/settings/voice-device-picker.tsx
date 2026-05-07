import { useCallback, useEffect, useRef, useState } from 'react'

interface VoiceDevicePickerProps {
  value: string
  onChange: (deviceId: string) => void
}

export function VoiceDevicePicker({ value, onChange }: VoiceDevicePickerProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const enumeratingRef = useRef(false)

  const enumerate = useCallback(async () => {
    if (enumeratingRef.current) return
    enumeratingRef.current = true
    try {
      // getUserMedia needed -- browsers hide device labels without a prior grant.
      await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
        for (const t of s.getTracks()) t.stop()
      })
      const all = await navigator.mediaDevices.enumerateDevices()
      setDevices(all.filter(d => d.kind === 'audioinput'))
      setError('')
      setLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cannot list devices')
    } finally {
      enumeratingRef.current = false
    }
  }, [])

  // Re-enumerate on plug/unplug, but only after first load
  useEffect(() => {
    if (!loaded) return
    const handler = () => enumerate()
    navigator.mediaDevices.addEventListener('devicechange', handler)
    return () => navigator.mediaDevices.removeEventListener('devicechange', handler)
  }, [loaded, enumerate])

  if (error) {
    return <span className="text-[10px] text-destructive font-mono">{error}</span>
  }

  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      onMouseDown={!loaded ? () => enumerate() : undefined}
      onFocus={!loaded ? () => enumerate() : undefined}
      className="w-52 bg-muted border border-border text-foreground text-xs px-2 py-1 font-mono truncate"
    >
      <option value="">System default</option>
      {devices.map(d => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || `Device ${d.deviceId.slice(0, 8)}`}
        </option>
      ))}
    </select>
  )
}
