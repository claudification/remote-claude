import { useEffect, useState } from 'react'
import { isMobileViewport } from '@/lib/utils'

/** Reactive mobile-viewport detector. Updates on window resize. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(isMobileViewport)
  useEffect(() => {
    const check = () => setIsMobile(isMobileViewport())
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  return isMobile
}
