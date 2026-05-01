/**
 * Client-side slash commands that run in the dashboard instead of being
 * forwarded to Claude Code. Invoked when the input is exactly `/cmd` (no
 * args) and the user submits -- the dispatcher clears the input and skips
 * the normal send path.
 */

import { useConversationsStore } from '@/hooks/use-conversations'

/**
 * Returns true if the input is a client command and was handled (caller
 * must then clear the input). Returns false for anything else, including
 * `/project` when there's no active session to pin the dialog to -- in
 * that case we let the submit fall through to the normal path.
 */
export function tryRunClientCommand(input: string): boolean {
  const m = input.trim().match(/^\/([a-zA-Z0-9_-]+)\s*$/)
  if (!m) return false
  const name = m[1].toLowerCase()
  switch (name) {
    case 'config':
    case 'settings':
      window.dispatchEvent(new Event('open-settings'))
      return true
    case 'project':
    case 'session': {
      const state = useConversationsStore.getState()
      const sid = state.selectedConversationId
      const project = sid ? state.sessionsById[sid]?.project : null
      if (!project) return false
      window.dispatchEvent(new CustomEvent('open-project-settings', { detail: { project } }))
      return true
    }
    default:
      return false
  }
}
