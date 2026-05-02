/**
 * The actual CM rendering surface. Imports CodeMirror + extensions eagerly;
 * loaded lazily from index.tsx so the chunk only ships when used.
 *
 * Mobile compose:
 *   When the editor is focused on a mobile viewport (and the caller hasn't
 *   set `inline`), the SAME wrapper div -- still containing the SAME React-
 *   rendered CM instance -- gets restyled to a full-viewport overlay with a
 *   toolbar appended below. Crucially, the <CodeMirror> component stays at
 *   the same React tree position, so CM does NOT unmount and the editor
 *   keeps focus (and therefore the iOS keyboard) across the transition.
 *
 *   Moving the editor into a conditionally-portaled panel (the earlier
 *   approach) caused an unmount/remount each time `expanded` flipped, which
 *   (a) dropped focus -- no keyboard on the initial open -- and (b) broke
 *   close via autoFocus-on-remount reopening the panel.
 */

import type { EditorView } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { Send } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useProject } from '@/hooks/use-project'
import { cn, haptic } from '@/lib/utils'
import { useIsMobile } from '../../shell/use-is-mobile'
import { useScrollLock } from '../../shell/use-scroll-lock'
import type { SubCommandContext } from '../../sub-commands'
import type { InputEditorProps } from '../../types'
import { buildInputExtensions, darkThemeBase, submitFromEditor } from './extensions'
import { attachPasteUpload, uploadDroppedFile } from './paste-drop'

export default function CodeMirrorBackendInner(props: InputEditorProps) {
  const [dragOver, setDragOver] = useState(false)
  const [focused, setFocused] = useState(false)
  const isMobile = useIsMobile()
  const expanded = isMobile && focused && !props.inline

  const conversationId = useConversationsStore(s => s.selectedConversationId)
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId
  const viewRef = useRef<EditorView | null>(null)

  // Sub-command context (e.g. /workon needs project tasks). Loaded lazily --
  // useProject(null) is a no-op so we only pay for fetch when the user is
  // actually composing a /workon command.
  const wantsTasks = props.enableAutocomplete && /^\/workon\s/i.test(props.value)
  const { tasks: projectTasks } = useProject(wantsTasks ? conversationId : null)
  const subCmdCtxRef = useRef<SubCommandContext>({ tasks: projectTasks, conversationId: conversationId })
  subCmdCtxRef.current = { tasks: projectTasks, conversationId: conversationId }

  const onSubmitRef = useRef(props.onSubmit)
  onSubmitRef.current = props.onSubmit

  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const stableOnChange = useCallback((value: string) => {
    onChangeRef.current(value)
  }, [])

  // Enter=submit only when NOT in the mobile compose panel. On a phone there's
  // no Shift-Enter, so Enter must insert a newline and the Send button is the
  // only submit path. Read at keypress time via ref so the extension doesn't
  // need rebuilding.
  const enterSubmitsRef = useRef(true)
  enterSubmitsRef.current = !expanded

  const { visibleHeight } = useScrollLock(expanded)

  // Build extensions ONCE. Boolean toggles captured at mount time.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-shot
  const extensions = useMemo(
    () =>
      buildInputExtensions({
        onSubmit: () => onSubmitRef.current(),
        // Larger font on mobile for thumb typing; bumped further in the
        // expanded panel (see scoped CSS override below).
        fontSize: isMobile ? 16 : 14,
        maxHeight: '12em',
        enableEffortKeywords: props.enableEffortKeywords,
        enableAutocomplete: props.enableAutocomplete,
        shouldEnterSubmit: () => enterSubmitsRef.current,
        // Read sub-command context lazily so /workon picks up the latest
        // project tasks + session id without rebuilding extensions.
        getSubCommandContext: () => subCmdCtxRef.current,
      }),
    [],
  )

  function onCreateEditor(view: EditorView) {
    viewRef.current = view
    attachPasteUpload(view, () => conversationIdRef.current)

    // Shift+Enter -> newline, registered directly on contentDOM in capture
    // phase. CM6's InputState.handleEvent blocks ALL keydown events during
    // active composition (ignoreDuringComposition). On iOS, predictive text
    // keeps composition alive across modifier keys -- so Shift+Enter arrives
    // while composing and CM6 silently drops it before any keymap or
    // domEventHandler fires. This capture-phase listener runs before CM6's
    // own bubble-phase handler, sidestepping the composition gate entirely.
    view.contentDOM.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key === 'Enter' && e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          view.dispatch(view.state.replaceSelection(view.state.lineBreak), {
            scrollIntoView: true,
            userEvent: 'input',
          })
        }
      },
      { capture: true },
    )
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (!files?.length) return
    const view = viewRef.current
    if (!view) return
    for (const file of files) uploadDroppedFile(view, file, conversationIdRef.current)
  }

  // Blur is async on iOS -- defer collapse so a tap on a toolbar button
  // (which steals focus from the editor) doesn't trip a premature close.
  // The buttons explicitly call closePanel() after their action.
  //
  // Timer id is tracked so repeated blur/focus cycles don't pile up stale
  // timers -- on a busy session with heavy renders, an old timer firing
  // while React is still dispatching a button pointerdown can race the
  // button's handler and collapse the panel before submit runs.
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function cancelBlurTimer() {
    if (blurTimerRef.current != null) {
      clearTimeout(blurTimerRef.current)
      blurTimerRef.current = null
    }
  }

  function onBlur() {
    cancelBlurTimer()
    blurTimerRef.current = setTimeout(() => {
      blurTimerRef.current = null
      const active = document.activeElement
      if (active?.closest('[data-mobile-compose-panel]')) return
      setFocused(false)
    }, 50)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: cancelBlurTimer closes over a ref, stable across renders -- re-subscribing would burn a timer that's legitimately in-flight
  useEffect(() => cancelBlurTimer, [])

  // Belt-and-braces for the refocus loop. Not strictly needed now that the
  // editor doesn't unmount, but cheap defense in depth against a future bug
  // that might re-focus immediately after close.
  const suppressFocusUntilRef = useRef(0)

  function onFocus() {
    if (Date.now() < suppressFocusUntilRef.current) {
      viewRef.current?.contentDOM.blur()
      return
    }
    setFocused(true)
  }

  function closePanel() {
    suppressFocusUntilRef.current = Date.now() + 400
    cancelBlurTimer()
    setFocused(false)
    viewRef.current?.contentDOM.blur()
  }

  // Toolbar buttons dedupe across touchstart / pointerdown / (synthesized) click.
  // touchstart fires earliest on iOS -- before the browser synthesizes a
  // contenteditable blur on the editor -- so it's the most reliable way to
  // land the handler before the blur timer can collapse the panel. We keep
  // onPointerDown as a fallback for mouse/trackpad and non-touch pointer
  // devices. lastActionRef gates duplicates so touchstart + mouse/click
  // don't double-fire.
  const lastActionRef = useRef(0)

  function claimAction(e: React.SyntheticEvent): boolean {
    e.preventDefault()
    const now = Date.now()
    if (now - lastActionRef.current < 500) return false
    lastActionRef.current = now
    return true
  }

  function fireSubmit(e: React.SyntheticEvent) {
    if (!claimAction(e)) return
    if (props.disabled) return
    haptic('tap')
    // Route through the same helper the Enter keymap uses so the CM doc
    // clears instantly instead of waiting out react-codemirror's 200ms
    // typing latch. viewRef is populated from onCreateEditor.
    const view = viewRef.current
    if (view) {
      submitFromEditor(view, props.onSubmit)
    } else {
      // Editor hasn't mounted yet -- shouldn't happen from this button, but
      // fall back to a plain submit so we don't silently drop the tap.
      props.onSubmit()
    }
    closePanel()
  }

  function fireCancel(e: React.SyntheticEvent) {
    if (!claimAction(e)) return
    haptic('tap')
    closePanel()
  }

  // Listen for file-upload-request events dispatched by TranscriptDropZone.
  // The legacy MarkdownInput wires this up itself; CM6 needs an equivalent.
  useEffect(() => {
    function handler(e: Event) {
      const file = (e as CustomEvent<File>).detail
      const view = viewRef.current
      if (!file || !view) return
      uploadDroppedFile(view, file, conversationIdRef.current)
    }
    window.addEventListener('file-upload-request', handler)
    return () => window.removeEventListener('file-upload-request', handler)
  }, [])

  // Hardware Escape closes the panel (mobile keyboards don't send Escape,
  // but desktop testing + external BT keyboards benefit).
  // biome-ignore lint/correctness/useExhaustiveDependencies: closePanel is a stable closure over refs/setters, not worth re-subscribing the global listener for
  useEffect(() => {
    if (!expanded) return
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        closePanel()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [expanded])

  const editor = (
    <CodeMirror
      value={props.value}
      onChange={stableOnChange}
      extensions={extensions}
      placeholder={props.placeholder}
      editable={!props.disabled}
      readOnly={props.disabled}
      // Mobile+non-inline: never autofocus. Parity with legacy markdown-input.
      // Prevents surprise full-screen compose on page load; the user must
      // tap to open the panel.
      autoFocus={props.autoFocus && (props.inline || !isMobile)}
      basicSetup={false}
      theme={darkThemeBase}
      onCreateEditor={onCreateEditor}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  )

  // When expanded, sit above the on-screen keyboard using visualViewport metrics.
  const overlayHeight = visibleHeight ? `${visibleHeight}px` : '100dvh'
  const overlayTop = visibleHeight ? 'var(--vv-offset, 0px)' : '0px'

  // iOS Safari composite-layer ghost fix. When the wrapper flips from
  // position:fixed (overlay) back to position:relative (inline), iOS Safari
  // can keep the promoted composite layer around, showing a stale copy of
  // the wrapper at its old overlay coordinates (top-left of viewport) until
  // something forces the node to repaint. The one-frame `visibility: hidden`
  // pulse on the collapse transition forces iOS to re-composite.
  const wasExpandedRef = useRef(false)
  const [collapsePulse, setCollapsePulse] = useState(false)
  useLayoutEffect(() => {
    if (wasExpandedRef.current && !expanded) {
      setCollapsePulse(true)
      const raf1 = requestAnimationFrame(() => {
        const raf2 = requestAnimationFrame(() => setCollapsePulse(false))
        rafCancelRef.current = raf2
      })
      rafCancelRef.current = raf1
    }
    wasExpandedRef.current = expanded
  }, [expanded])
  const rafCancelRef = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (rafCancelRef.current != null) cancelAnimationFrame(rafCancelRef.current)
    }
  }, [])

  return (
    <div
      data-mobile-compose-panel={expanded || undefined}
      className={cn(
        expanded
          ? 'fixed inset-0 z-[999] flex flex-col bg-background'
          : cn(
              'relative w-full rounded-md border border-border/60 bg-transparent overflow-hidden',
              'focus-within:border-border transition-colors',
              props.className,
            ),
      )}
      style={
        expanded
          ? {
              touchAction: 'manipulation',
              height: overlayHeight,
              top: overlayTop,
              // Explicit composite-layer hints: iOS honors these reliably.
              willChange: 'transform',
              transform: 'translateZ(0)',
            }
          : collapsePulse
            ? {
                // One-frame repaint pulse: forces iOS to drop the stale
                // composite layer left behind by the overlay state.
                visibility: 'hidden',
                transform: 'none',
                willChange: 'auto',
              }
            : {
                // Explicit "no layer needed" so iOS can reclaim the one it
                // promoted during the overlay state.
                transform: 'none',
                willChange: 'auto',
              }
      }
      onDragOver={e => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* Scoped CM overrides for the expanded state. @uiw/react-codemirror's
          wrapper class is `cm-theme-dark` (because theme="dark"), not
          `cm-theme` -- the attribute selector catches both. Without these
          the CM wrapper collapses to content-height inside the flex slot. */}
      {expanded && (
        <style>{`
          [data-mobile-compose-panel] [class*="cm-theme"],
          [data-mobile-compose-panel] .cm-editor {
            height: 100% !important;
          }
          [data-mobile-compose-panel] .cm-scroller {
            max-height: none !important;
            height: 100% !important;
          }
          [data-mobile-compose-panel] .cm-content {
            font-size: 17px !important;
            line-height: 1.5 !important;
          }
        `}</style>
      )}

      {/* Editor slot. Expanded: fills the column between top and toolbar. */}
      <div className={expanded ? 'flex-1 min-h-0 overflow-hidden' : ''}>{editor}</div>

      {/* Drag-drop overlay only makes sense inline. */}
      {!expanded && dragOver && (
        <div className="absolute inset-0 border-2 border-dashed border-accent/60 bg-accent/5 pointer-events-none flex items-center justify-center">
          <span className="text-xs font-mono text-accent/80">Drop file here</span>
        </div>
      )}

      {/* Toolbar below the editor, above the keyboard. Matches legacy layout. */}
      {expanded && (
        <div className="shrink-0 flex items-center justify-between px-3 py-2 border-t border-border/40">
          <button
            type="button"
            onTouchStart={fireCancel}
            onPointerDown={fireCancel}
            className="text-sm font-mono text-muted-foreground hover:text-foreground px-3 py-2"
            style={{ touchAction: 'manipulation' } as React.CSSProperties}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={props.disabled}
            onTouchStart={fireSubmit}
            onPointerDown={fireSubmit}
            className="flex items-center gap-1.5 text-sm font-bold px-5 py-2 rounded select-none bg-accent text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ touchAction: 'manipulation', WebkitTouchCallout: 'none' } as React.CSSProperties}
          >
            <Send className="w-4 h-4" />
            Send
          </button>
        </div>
      )}
    </div>
  )
}
