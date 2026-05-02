/**
 * Shared file upload with placeholder management.
 * Works with any editor (textarea, CodeMirror, etc.) via callbacks.
 *
 * @param conversationId - Optional session ID for CWD-scoped permission resolution.
 *   Without this, the server checks 'files' against '*' which fails for
 *   non-admin users whose grants are scoped to a specific CWD.
 */
export async function uploadFileWithPlaceholder(
  file: File,
  insert: (placeholder: string) => void,
  replace: (search: string, replacement: string) => void,
  conversationId?: string,
) {
  const placeholder = `![uploading ${file.name || 'file'}...]`
  insert(placeholder)
  try {
    const formData = new FormData()
    formData.append('file', file, file.name || 'paste.png')
    const headers: Record<string, string> = {}
    if (conversationId) headers['x-session-id'] = conversationId
    const res = await fetch('/api/files', { method: 'POST', body: formData, headers })
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
    const { url, filename } = await res.json()
    replace(placeholder, `![${filename}](${url})`)
  } catch {
    replace(placeholder, '![upload failed]')
  }
}
