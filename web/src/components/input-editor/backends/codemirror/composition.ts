/**
 * Composition state tracking for CM6.
 *
 * EditorView.composing is available on the view instance, but CM6's
 * CompletionContext only exposes EditorState -- no view. This StateField
 * mirrors the composing flag into state so completion sources (and any
 * other state-level consumer) can check it.
 *
 * Apple dictation is the main motivation: it fires aggressive
 * deleteByComposition / insertFromComposition sequences that go back and
 * rewrite already-committed text. Extensions that react to doc changes
 * (autocomplete, custom keymaps) need to back off during these sessions.
 */

import { StateEffect, StateField } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

const setComposing = StateEffect.define<boolean>()

export const composingField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setComposing)) return e.value
    }
    return value
  },
})

// Apple dictation fires compositionend slightly before the final
// beforeinput replacement, so we defer the reset to avoid flipping
// the flag while a correction is still in flight.
const COMPOSITION_END_DELAY_MS = 80

let endTimer: ReturnType<typeof setTimeout> | null = null

export const composingTracker = EditorView.domEventHandlers({
  compositionstart(_, view) {
    if (endTimer) {
      clearTimeout(endTimer)
      endTimer = null
    }
    if (!view.state.field(composingField)) {
      view.dispatch({ effects: setComposing.of(true) })
    }
    return false
  },
  compositionend(_, view) {
    if (endTimer) clearTimeout(endTimer)
    endTimer = setTimeout(() => {
      endTimer = null
      if (view.state.field(composingField)) {
        view.dispatch({ effects: setComposing.of(false) })
      }
    }, COMPOSITION_END_DELAY_MS)
    return false
  },
})
