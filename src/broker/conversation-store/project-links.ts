import { cwdToProjectUri, extractProjectLabel, normalizeProjectUri } from '../../shared/project-uri'
import type { Conversation } from '../../shared/protocol'
import { getProjectSettings } from '../project-settings'

function toProjectUri(cwdOrUri: string): string {
  if (cwdOrUri.startsWith('/')) return cwdToProjectUri(cwdOrUri)
  return normalizeProjectUri(cwdOrUri)
}

function projectLinkKey(a: string, b: string): string {
  return [normalizeProjectUri(a), normalizeProjectUri(b)].sort().join('|')
}

export interface ProjectLinkRegistry {
  checkProjectLink: (from: string, to: string) => 'linked' | 'blocked' | 'unknown'
  getLinkedProjects: (conversationId: string) => Array<{ project: string; name: string }>
  linkProjects: (a: string, b: string) => void
  unlinkProjects: (a: string, b: string) => void
  blockProject: (blocker: string, blocked: string) => void
  queueProjectMessage: (from: string, to: string, message: Record<string, unknown>) => void
  drainProjectMessages: (from: string, to: string) => Array<Record<string, unknown>>
  broadcastToConversationsForProject: (project: string, message: Record<string, unknown>) => number
  toProjectUri: (cwdOrUri: string) => string
}

export function createProjectLinkRegistry(
  conversations: Map<string, Conversation>,
  conversationSockets: Map<string, Map<string, import('bun').ServerWebSocket<unknown>>>,
): ProjectLinkRegistry {
  const projectLinks = new Set<string>()
  const projectBlocks = new Map<string, number>()
  const messageQueue = new Map<string, Array<Record<string, unknown>>>()

  function sessionToProject(conversationId: string): string | undefined {
    return conversations.get(conversationId)?.project
  }

  return {
    checkProjectLink(from, to) {
      const projFrom = sessionToProject(from)
      const projTo = sessionToProject(to)
      if (!projFrom || !projTo) return 'unknown'
      const key = projectLinkKey(projFrom, projTo)
      if (projectLinks.has(key)) return 'linked'
      const blockTs = projectBlocks.get(key)
      if (blockTs && Date.now() - blockTs < 60_000) return 'blocked'
      if (blockTs) projectBlocks.delete(key)
      return 'unknown'
    },

    getLinkedProjects(conversationId) {
      const thisProject = sessionToProject(conversationId)
      if (!thisProject) return []
      const result: Array<{ project: string; name: string }> = []
      for (const key of projectLinks) {
        const [a, b] = key.split('|')
        const other = a === normalizeProjectUri(thisProject) ? b : b === normalizeProjectUri(thisProject) ? a : null
        if (!other) continue
        const session = Array.from(conversations.values()).find(s => normalizeProjectUri(s.project) === other)
        const otherProject = session?.project || other
        const name = getProjectSettings(otherProject)?.label || extractProjectLabel(otherProject)
        result.push({ project: otherProject, name })
      }
      return result
    },

    linkProjects(a, b) {
      const projA = sessionToProject(a)
      const projB = sessionToProject(b)
      if (!projA || !projB) return
      const key = projectLinkKey(projA, projB)
      projectLinks.add(key)
      projectBlocks.delete(key)
    },

    unlinkProjects(a, b) {
      const projA = sessionToProject(a)
      const projB = sessionToProject(b)
      if (projA && projB) projectLinks.delete(projectLinkKey(projA, projB))
    },

    blockProject(blocker, blocked) {
      const projA = sessionToProject(blocker)
      const projB = sessionToProject(blocked)
      if (!projA || !projB) return
      const key = projectLinkKey(projA, projB)
      projectLinks.delete(key)
      projectBlocks.set(key, Date.now())
    },

    queueProjectMessage(from, to, message) {
      const projFrom = sessionToProject(from)
      const projTo = sessionToProject(to)
      if (!projFrom || !projTo) return
      const key = projectLinkKey(projFrom, projTo)
      const queue = messageQueue.get(key) || []
      queue.push(message)
      messageQueue.set(key, queue)
    },

    drainProjectMessages(from, to) {
      const projFrom = sessionToProject(from)
      const projTo = sessionToProject(to)
      if (!projFrom || !projTo) return []
      const key = projectLinkKey(projFrom, projTo)
      const msgs = messageQueue.get(key) || []
      messageQueue.delete(key)
      return msgs
    },

    broadcastToConversationsForProject(projectOrCwd, message) {
      const project = toProjectUri(projectOrCwd)
      const json = JSON.stringify(message)
      let count = 0
      for (const [conversationId, session] of conversations) {
        if (session.project !== project) continue
        const wrappers = conversationSockets.get(conversationId)
        if (!wrappers) continue
        for (const ws of wrappers.values()) {
          try {
            ws.send(json)
            count++
          } catch {}
        }
      }
      return count
    },

    toProjectUri,
  }
}
