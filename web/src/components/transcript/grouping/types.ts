import type { TranscriptEntry } from '@/lib/types'

export interface TaskNotification {
  taskId: string
  summary: string
  status: 'completed' | 'failed' | 'killed' | string
  result?: string
  toolUseId?: string
  outputFile?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
}

export interface DisplayGroup {
  type:
    | 'user'
    | 'assistant'
    | 'system'
    | 'compacting'
    | 'compacted'
    | 'skill'
    | 'boot'
    | 'launch'
    | 'spawn_notification'
  timestamp: string
  entries: TranscriptEntry[]
  notifications?: TaskNotification[]
  localCommandOutput?: string
  systemSubtype?: string
  queued?: boolean
  skillName?: string
  planMode?: boolean
}

/**
 * Mutable state passed through processEntry per pass. Both the batch
 * (groupEntries) and incremental (useIncrementalGroups) callers manage
 * their own instance of this shape and run the same per-entry logic over it.
 */
export interface GroupingState {
  groups: DisplayGroup[]
  current: DisplayGroup | null
  pendingSkillName: string | undefined
}
