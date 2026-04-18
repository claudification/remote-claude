/**
 * <InputEditor> -- shell + backend selection.
 *
 * Backend choice from dashboardPrefs.inputBackend:
 *   - 'legacy'      : the existing MarkdownInput (textarea + overlay)
 *   - 'codemirror'  : CM6-based, lazy-loaded (~200KB chunk, paid only on opt-in)
 *
 * Default = 'legacy'. Toggle in settings page.
 */

import { useSessionsStore } from '@/hooks/use-sessions'
import { MarkdownInput } from '../markdown-input'
import { CodeMirrorBackend } from './backends/codemirror'
import type { InputEditorProps } from './types'

export type { InputEditorProps } from './types'

export function InputEditor(props: InputEditorProps) {
  const backend = useSessionsStore(s => s.dashboardPrefs.inputBackend)

  if (backend === 'codemirror') {
    return <CodeMirrorBackend {...props} />
  }

  return <MarkdownInput {...props} />
}
