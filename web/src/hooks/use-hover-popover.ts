import { useRef, useState } from 'react'

export function useHoverPopover(enterDelay = 300, leaveDelay = 200) {
  const [open, setOpen] = useState(false)
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleMouseEnter() {
    timeout.current = setTimeout(() => setOpen(true), enterDelay)
  }

  function handleMouseLeave() {
    if (timeout.current) clearTimeout(timeout.current)
    timeout.current = setTimeout(() => setOpen(false), leaveDelay)
  }

  function cancelClose() {
    if (timeout.current) clearTimeout(timeout.current)
  }

  function toggle() {
    setOpen(o => !o)
  }

  return { open, setOpen, handleMouseEnter, handleMouseLeave, cancelClose, toggle }
}
