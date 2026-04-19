/**
 * Lazy-loaded CodeMirror editor pane for the file editor.
 *
 * Split out so @uiw/react-codemirror + language packs don't ship in the main
 * chunk. file-editor.tsx renders this behind React.lazy.
 */

import { useMemo } from 'react'
import { SafeCodeMirror } from './codemirror/safe-codemirror'
import { buildFileEditorExtensions } from './codemirror-setup'

export default function FileEditorPane({
  content,
  onChange,
  filePath,
}: {
  content: string
  onChange: (value: string) => void
  filePath?: string
}) {
  // Memoize: `extensions` is in CodeMirror's reconfigure dep array -- a new
  // reference per render triggers a full extension teardown + rebuild on every
  // keystroke. SafeCodeMirror pins onChange identity for us.
  const extensions = useMemo(() => buildFileEditorExtensions(filePath), [filePath])

  return (
    <SafeCodeMirror
      key={filePath ?? ''}
      value={content}
      onChange={onChange}
      extensions={extensions}
      basicSetup={false}
      theme="dark"
      className="flex-1 min-h-0 overflow-hidden"
      height="100%"
    />
  )
}
