/**
 * Public API for <InputEditor> -- a markdown text input with pluggable backend.
 *
 * Two backends today:
 *   - 'legacy'      : textarea + transparent overlay highlight (markdown-input.tsx)
 *   - 'codemirror'  : CodeMirror 6 with @codemirror/lang-markdown
 *
 * Backend chosen via controlPanelPrefs.inputBackend. Same props for both.
 */

export interface InputEditorProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  placeholder?: string
  className?: string
  autoFocus?: boolean
  /** Force inline mode: no mobile expand-on-focus, autoFocus works on mobile. */
  inline?: boolean
  /** Enable slash command / @ mention autocomplete. */
  enableAutocomplete?: boolean
  /** Highlight effort keywords (e.g. "ultrathink"). Prompt input only. */
  enableEffortKeywords?: boolean
  /** Called on Ctrl+S with current input text (for message stash). */
  onStash?: () => void
}
