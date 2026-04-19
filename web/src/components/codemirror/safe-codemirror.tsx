/**
 * SafeCodeMirror -- drop-in replacement for `@uiw/react-codemirror` that pins
 * the two identity-sensitive props (`onChange`, `onUpdate`) so callers can't
 * accidentally trigger @uiw/react-codemirror's reconfigure storm.
 *
 * Background
 * ----------
 * `useCodeMirror.js` L148 dispatches `StateEffect.reconfigure.of(getExtensions)`
 * -- a full extension teardown + rebuild -- whenever ANY of these change
 * identity:
 *
 *   [theme, extensions, height, minHeight, maxHeight, width, minWidth,
 *    maxWidth, placeholderStr, editable, readOnly, defaultIndentWithTab,
 *    defaultBasicSetup, onChange, onUpdate]
 *
 * For a typical React caller, `theme`/`height`/booleans are primitives and
 * stable. `onChange` and `onUpdate` aren't -- inline arrows and fresh
 * `function setX(...)` declarations get a new identity every render, so every
 * keystroke -> parent re-render -> new onChange -> reconfigure -> 40-120ms
 * stall per keystroke ("INSANE sluggishness" in the perf HUD). This wrapper
 * ref-pins them internally so callers can pass whatever they want.
 *
 * The `extensions` prop is ALSO in that list, but extension stability is a
 * caller-side concern (module-level const, or `useMemo` with real deps).
 * Inline-calling a factory (`extensions={buildFoo()}`) is a bug -- the wrapper
 * can't know when the factory's logical inputs changed vs. when the parent
 * just re-rendered. JSDoc the invariant below.
 *
 * See commit 835d134 for the original stabilization in InputEditor.
 */

import CodeMirror, { type ReactCodeMirrorProps, type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { forwardRef, useCallback, useRef } from 'react'

type SafeCodeMirrorProps = ReactCodeMirrorProps

/**
 * Wraps <CodeMirror /> and pins `onChange` + `onUpdate` identity.
 *
 * IMPORTANT: `extensions` MUST be stable across renders. Use a module-level
 * constant if the array never changes, or `useMemo(() => build(), [deps])` if
 * it does. Inline `extensions={build()}` will still cause a reconfigure storm
 * -- the wrapper can't fix what it can't see.
 */
export const SafeCodeMirror = forwardRef<ReactCodeMirrorRef, SafeCodeMirrorProps>(function SafeCodeMirror(
  { onChange, onUpdate, ...rest },
  ref,
) {
  // Pin onChange identity. Reads through a ref so the latest parent callback
  // is always invoked without the prop identity ever changing.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const stableOnChange = useCallback<NonNullable<ReactCodeMirrorProps['onChange']>>((value, viewUpdate) => {
    onChangeRef.current?.(value, viewUpdate)
  }, [])

  // Same treatment for onUpdate (also in the reconfigure dep array).
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const stableOnUpdate = useCallback<NonNullable<ReactCodeMirrorProps['onUpdate']>>(viewUpdate => {
    onUpdateRef.current?.(viewUpdate)
  }, [])

  // Always pass the stable wrappers: they're no-ops when the parent didn't
  // pass handlers (ref.current is undefined). This way the identity never
  // flips if the parent toggles the handler on/off.
  return <CodeMirror ref={ref} onChange={stableOnChange} onUpdate={stableOnUpdate} {...rest} />
})
