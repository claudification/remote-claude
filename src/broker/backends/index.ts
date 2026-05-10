/**
 * Backend registry -- resolves agentHostType to a ConversationBackend.
 */

import type { Conversation } from '../../shared/protocol'
import { chatApiBackend } from './chat-api'
import { claudeBackend } from './claude'
import { hermesBackend } from './hermes'
import type { ConversationBackend } from './types'

export type { BackendDeps, ConversationBackend, InputResult } from './types'

const backends = new Map<string, ConversationBackend>([
  ['claude', claudeBackend],
  ['chat-api', chatApiBackend],
  ['hermes', hermesBackend],
])

export function resolveBackend(conversation: Conversation): ConversationBackend {
  const type = conversation.agentHostType || 'claude'
  return backends.get(type) || claudeBackend
}

export function registerBackend(backend: ConversationBackend): void {
  backends.set(backend.type, backend)
}
