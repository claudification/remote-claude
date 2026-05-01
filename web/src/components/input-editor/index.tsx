/**
 * <InputEditor> -- shell + backend selection.
 *
 * Backend choice from controlPanelPrefs.inputBackend:
 *   - 'legacy'      : the existing MarkdownInput (textarea + overlay)
 *   - 'codemirror'  : CM6-based, lazy-loaded (~200KB chunk, paid only on opt-in)
 *
 * Default = 'legacy'. Toggle in settings page.
 *
 * Also intercepts client-side slash commands (e.g. `/config`, `/project`)
 * before they reach the wire — runs the action locally and clears the
 * input, identical for both backends.
 */

import { useConversationsStore } from '@/hooks/use-sessions'
import { tryRunClientCommand } from '@/lib/client-commands'
import { MarkdownInput } from '../markdown-input'
import { MaybeProfiler } from '../perf-profiler'
import { CodeMirrorBackend } from './backends/codemirror'
import type { InputEditorProps } from './types'

export type { InputEditorProps } from './types'

export function InputEditor(props: InputEditorProps) {
  const backend = useConversationsStore(s => s.controlPanelPrefs.inputBackend)

  function onSubmit() {
    if (tryRunClientCommand(props.value)) {
      props.onChange('')
      return
    }
    props.onSubmit()
  }

  const wrapped: InputEditorProps = { ...props, onSubmit }
  const profilerId = backend === 'codemirror' ? 'InputEditor.CM' : 'InputEditor.Legacy'

  return (
    <MaybeProfiler id={profilerId}>
      {backend === 'codemirror' ? <CodeMirrorBackend {...wrapped} /> : <MarkdownInput {...wrapped} />}
    </MaybeProfiler>
  )
}
