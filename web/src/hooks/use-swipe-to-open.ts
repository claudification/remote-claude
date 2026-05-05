import { useCallback, useRef } from 'react'

export function useSwipeToOpen(onOpen: () => void) {
  const touchRef = useRef<{ startX: number; startY: number; startTime: number } | null>(null)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    if (touch.clientX > 40) return
    touchRef.current = { startX: touch.clientX, startY: touch.clientY, startTime: Date.now() }
  }, [])

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!touchRef.current) return
      const touch = e.changedTouches[0]
      const { startX, startY, startTime } = touchRef.current
      touchRef.current = null

      const dx = touch.clientX - startX
      const dy = Math.abs(touch.clientY - startY)
      const elapsed = Date.now() - startTime

      if (dx > 60 && dy < dx * 0.5 && elapsed < 500) {
        onOpen()
      }
    },
    [onOpen],
  )

  return { onTouchStart, onTouchEnd }
}
