/**
 * Backend registry -- resolves agentHostType / backend name / scheme to a
 * ConversationBackend. Adding a new backend = drop a file here + add one line
 * to the registration table below.
 */

import type { Conversation } from '../../shared/protocol'
import { acpBackend } from './acp'
import { chatApiBackend } from './chat-api'
import { claudeBackend } from './claude'
import { hermesBackend } from './hermes'
import { opencodeBackend } from './opencode'
import type { ConversationBackend } from './types'

export type { BackendDeps, ConversationBackend, InputResult, SpawnDeps, SpawnResult } from './types'

const backendsByType = new Map<string, ConversationBackend>()
const backendsByScheme = new Map<string, ConversationBackend>()

export function registerBackend(backend: ConversationBackend): void {
  backendsByType.set(backend.type, backend)
  if (backend.scheme) backendsByScheme.set(backend.scheme, backend)
}

registerBackend(claudeBackend)
registerBackend(chatApiBackend)
registerBackend(hermesBackend)
registerBackend(opencodeBackend)
registerBackend(acpBackend)

/** Resolve a backend for an existing conversation. Falls back to claude. */
export function resolveBackend(conversation: Conversation): ConversationBackend {
  const type = conversation.agentHostType || 'claude'
  return backendsByType.get(type) || claudeBackend
}

/** Resolve a backend by its registered type, e.g. for boot validation. */
export function resolveBackendByType(type: string | undefined | null): ConversationBackend | null {
  if (!type) return null
  return backendsByType.get(type) ?? null
}

/** Resolve a backend by name (used at spawn dispatch time). */
export function resolveBackendByName(name: string | undefined | null): ConversationBackend | null {
  if (!name) return null
  return backendsByType.get(name) ?? null
}

/** Resolve a backend by URI scheme. */
export function resolveBackendByScheme(scheme: string | undefined | null): ConversationBackend | null {
  if (!scheme) return null
  return backendsByScheme.get(scheme) ?? null
}

/** Snapshot of registered backends -- used for tests and the (future) manifest endpoint. */
export function listBackends(): ConversationBackend[] {
  return Array.from(backendsByType.values())
}
