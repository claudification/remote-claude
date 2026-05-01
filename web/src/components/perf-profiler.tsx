/**
 * Shared <MaybeProfiler> wrapper.
 *
 * Wraps children in React.Profiler ONLY when the perf monitor toggle
 * (controlPanelPrefs.showPerfMonitor) is on. Profiler adds an extra fiber
 * + measurement on every commit, so the gate matters.
 *
 * Profile data feeds the perf-metrics ring buffer (perf-metrics.ts) under
 * the 'render' category, where the perf HUD reads it.
 */

import { Fragment, Profiler, type ProfilerOnRenderCallback, type ReactNode, useLayoutEffect, useRef } from 'react'
import { useConversationsStore } from '@/hooks/use-sessions'
import { isPerfEnabled, record } from '@/lib/perf-metrics'

const onRenderProfile: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration) => {
  record('render', id, actualDuration, `${phase} base=${baseDuration.toFixed(1)}ms`)
}

/**
 * Measures commit -> next browser paint per render. Equivalent of CM's
 * `cm.update->paint` -- captures the cost between React's commit (visible
 * in Profiler's `actualDuration`) and the next frame the user actually
 * sees, which is where layout/paint/style recompute lives.
 *
 * Only schedules work when the perf monitor is on. The rAF callback is
 * cheap; the recorded id is `<id>.commit->paint` so it groups with the
 * Profiler entries in the HUD.
 */
function useCommitToPaintTimer(id: string) {
  // Use a ref to track if we're in the first commit (mount) so we can label it
  const renderCountRef = useRef(0)
  useLayoutEffect(() => {
    if (!isPerfEnabled()) return
    renderCountRef.current++
    const phase = renderCountRef.current === 1 ? 'mount' : 'update'
    const t0 = performance.now()
    const handle = requestAnimationFrame(() => {
      record('render', `${id}.commit->paint`, performance.now() - t0, phase)
    })
    return () => cancelAnimationFrame(handle)
  })
}

/**
 * Read showPerfMonitor inline so callers don't have to pass it down. The
 * subscription is cheap (single boolean) and only the wrapper re-renders
 * when the toggle flips, not its children.
 *
 * Records two complementary metrics per render:
 *   - `<id>`              : React commit cost (Profiler.actualDuration)
 *   - `<id>.commit->paint`: time from commit -> next browser paint, where
 *                           layout / style recompute / browser composite
 *                           live. Equivalent to CM's `cm.update->paint`.
 */
export function MaybeProfiler({ id, children }: { id: string; children: ReactNode }) {
  const enabled = useConversationsStore(s => s.controlPanelPrefs.showPerfMonitor)
  if (!enabled) return <Fragment>{children}</Fragment>
  return (
    <Profiler id={id} onRender={onRenderProfile}>
      <CommitPaintTracker id={id}>{children}</CommitPaintTracker>
    </Profiler>
  )
}

/** Inner so the rAF effect only runs when the Profiler is active. */
function CommitPaintTracker({ id, children }: { id: string; children: ReactNode }) {
  useCommitToPaintTimer(id)
  return <Fragment>{children}</Fragment>
}
