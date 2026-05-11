/**
 * Module state for the launch-profile manager modal.
 *
 * Open/close + an optional pre-selected profile id. Co-located with the
 * manager components so other parts of the app can pop the modal open
 * without importing the modal directly.
 */

import { useEffect, useState } from 'react'

type Listener = (state: ManagerState) => void

export interface ManagerState {
  open: boolean
  /** Profile id to focus when the modal opens. `'new'` = create blank. */
  focusId?: string | 'new'
}

let state: ManagerState = { open: false }
const listeners = new Set<Listener>()

function notify(): void {
  for (const l of listeners) l(state)
}

export function openLaunchProfileManager(focusId?: string | 'new'): void {
  state = { open: true, focusId }
  notify()
}

export function closeLaunchProfileManager(): void {
  state = { open: false }
  notify()
}

export function useLaunchProfileManagerState(): ManagerState {
  const [snapshot, setSnapshot] = useState<ManagerState>(state)
  useEffect(() => {
    listeners.add(setSnapshot)
    return () => {
      listeners.delete(setSnapshot)
    }
  }, [])
  return snapshot
}
