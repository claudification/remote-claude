/**
 * <InputEditor> -- shell + backend selection.
 *
 * Phase 1: forwards everything to legacy backend (the existing MarkdownInput).
 * Phase 2: routes to CodeMirror backend when dashboardPrefs.inputBackend === 'codemirror'.
 *
 * The shell will eventually own mobile-expand, popovers, voice, attach, send.
 * For now (Phase 1) the legacy backend still owns all of that internally.
 */

import { useSessionsStore } from '@/hooks/use-sessions'
import { MarkdownInput } from '../markdown-input'
import type { InputEditorProps } from './types'

export type { InputEditorProps } from './types'

export function InputEditor(props: InputEditorProps) {
  const backend = useSessionsStore(s => s.dashboardPrefs.inputBackend)

  // Phase 1: codemirror not yet implemented -- always falls back to legacy.
  // When CM backend lands in Phase 2, branch on `backend` here.
  if (backend === 'codemirror') {
    // TODO Phase 2: render <CodeMirrorBackend {...props} />
    return <MarkdownInput {...props} />
  }

  return <MarkdownInput {...props} />
}
