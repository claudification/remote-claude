/**
 * Lock the body scroll while a mobile compose panel is active. Restores the
 * previous scroll position on unlock. Tracks the visualViewport so callers
 * can size their panel against the keyboard-occluded area.
 *
 * Pattern lifted from the legacy MarkdownInput's expanded-mode effect, but
 * factored as a hook so any backend can use it.
 */

import { useLayoutEffect, useState } from 'react'

interface ScrollLockResult {
  /** Visible viewport height (excludes on-screen keyboard area), or null if unlocked. */
  visibleHeight: number | null
}

export function useScrollLock(active: boolean): ScrollLockResult {
  const [visibleHeight, setVisibleHeight] = useState<number | null>(null)

  // useLayoutEffect (not useEffect): body.style.position='fixed' must be
  // applied/restored BEFORE the browser paints. With useEffect, the agent host's
  // className change commits to the DOM, browser paints, THEN cleanup runs --
  // leaving one frame where the agent host is `position: relative` while body is
  // still `position: fixed; top: -scrollY`. That frame is visible on iOS as
  // a ghost CM editor at the top of the viewport, and the composite layer
  // can persist across subsequent paints.
  useLayoutEffect(() => {
    if (!active) {
      setVisibleHeight(null)
      return
    }

    const body = document.body
    const scrollY = window.scrollY
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      overflow: body.style.overflow,
    }
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.overflow = 'hidden'

    function restore() {
      body.style.position = prev.position
      body.style.top = prev.top
      body.style.left = prev.left
      body.style.right = prev.right
      body.style.overflow = prev.overflow
      window.scrollTo(0, scrollY)
    }

    const vv = window.visualViewport
    if (!vv) {
      return restore
    }

    function update() {
      if (!vv) return
      setVisibleHeight(vv.height)
      document.documentElement.style.setProperty('--vv-offset', `${vv.offsetTop}px`)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)

    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      document.documentElement.style.removeProperty('--vv-offset')
      restore()
    }
  }, [active])

  return { visibleHeight }
}
