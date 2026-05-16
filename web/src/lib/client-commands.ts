/**
 * Client-side slash commands that run in the dashboard instead of being
 * forwarded to Claude Code. Invoked from the input editor's submit handler
 * -- the dispatcher clears the input and skips the normal send path.
 */

import { openRenameModal } from '@/components/rename-modal'
import { useConversationsStore } from '@/hooks/use-conversations'

/**
 * Returns true if the input is a client command and was handled (caller
 * must then clear the input). Returns false for anything else, including
 * `/project` when there's no active conversations to pin the dialog to -- in
 * that case we let the submit fall through to the normal path.
 */
export function tryRunClientCommand(input: string): boolean {
  const trimmed = input.trim()

  // Commands with arguments
  const argsMatch = trimmed.match(/^\/([a-zA-Z0-9_-]+)\s+(.+)$/)
  if (argsMatch) {
    const name = argsMatch[1].toLowerCase()
    const args = argsMatch[2].trim()
    switch (name) {
      case 'rename': {
        const sid = useConversationsStore.getState().selectedConversationId
        if (!sid) return false
        useConversationsStore.getState().renameConversation(sid, args)
        return true
      }
      default:
        break
    }
  }

  // Bare commands (no args) -- also handle /rename (opens modal)
  const bareMatch = trimmed.match(/^\/([a-zA-Z0-9_-]+)\s*$/)
  if (!bareMatch) return false
  const name = bareMatch[1].toLowerCase()
  switch (name) {
    case 'config':
    case 'settings':
      window.dispatchEvent(new Event('open-settings'))
      return true
    case 'project':
    case 'session': {
      const state = useConversationsStore.getState()
      const sid = state.selectedConversationId
      const project = sid ? state.conversationsById[sid]?.project : null
      if (!project) return false
      window.dispatchEvent(new CustomEvent('open-project-settings', { detail: { project } }))
      return true
    }
    case 'rename':
      openRenameModal()
      return true
    default:
      return false
  }
}
