/**
 * Backend-agnostic focus helper for the InputEditor.
 *
 * Legacy backend uses a real <textarea>; CodeMirror backend uses a
 * contentEditable inside .cm-editor. Either is "the input" -- this
 * helper finds and focuses whichever exists in the given root.
 *
 * Falls back gracefully: returns true on success, false if no input was
 * found in scope. When the element isn't found on the first attempt
 * (e.g. CM6 still initializing after a conversation switch), retries
 * up to 500ms via rAF polling.
 */

function tryFocus(root: ParentNode): boolean {
  const cm = root.querySelector<HTMLElement>('.cm-editor [contenteditable="true"]')
  if (cm) {
    cm.focus()
    return true
  }
  const ta = root.querySelector<HTMLTextAreaElement>('textarea')
  if (ta) {
    ta.focus()
    return true
  }
  return false
}

const MAX_RETRY_MS = 500

export function focusInputEditor(root: ParentNode = document): boolean {
  if (tryFocus(root)) return true
  const start = performance.now()
  function retry() {
    if (tryFocus(root)) return
    if (performance.now() - start < MAX_RETRY_MS) requestAnimationFrame(retry)
  }
  requestAnimationFrame(retry)
  return false
}
