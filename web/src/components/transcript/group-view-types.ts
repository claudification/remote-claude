import type { TranscriptContentBlock, TranscriptImage, TranscriptToolUseResult } from '@/lib/types'

export const BUBBLE_COLORS: Record<string, string> = {
  blue: 'bg-primary/90',
  teal: 'bg-teal-600/90',
  purple: 'bg-purple-600/90',
  green: 'bg-emerald-600/90',
  orange: 'bg-amber-600/90',
  pink: 'bg-pink-600/90',
  indigo: 'bg-indigo-600/90',
}

export const BUBBLE_COLOR_OPTIONS = Object.keys(BUBBLE_COLORS)

export interface RenderableTranscriptEntry {
  message?: { role?: string; content?: string | TranscriptContentBlock[] }
  images?: TranscriptImage[]
  toolUseResult?: TranscriptToolUseResult
}

export interface TranscriptSettings {
  expandAll: boolean
  userLabel: string
  agentLabel: string
  userColor: string
  agentColor: string
  userSize: string
  agentSize: string
  chatBubbles: boolean
  bubbleColor: string
}

export type SubagentRef = Array<{
  agentId: string
  agentType: string
  description?: string
  status: 'running' | 'stopped'
  startedAt: number
  stoppedAt?: number
  eventCount: number
  tokenUsage?: { totalInput: number; totalOutput: number; cacheCreation: number; cacheRead: number }
}>

export type ResultLookup = (
  id: string,
) => { result: string; extra?: Record<string, unknown>; isError?: boolean } | undefined

export type RenderItem =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; encryptedBytes?: number; rawBlock?: TranscriptContentBlock }
  | {
      kind: 'project-task'
      id: string
      title: string
      body: string
      priority?: string
      taskStatus?: string
      tags?: string[]
    }
  | {
      kind: 'tool'
      tool: TranscriptContentBlock
      result?: string
      extra?: Record<string, unknown>
      isError?: boolean
    }
  | { kind: 'bash'; text: string }
  | {
      kind: 'channel'
      text: string
      source: string
      conversationId?: string
      intent?: string
      isInterConversation?: boolean
      isDialog?: boolean
      dialogStatus?: string
      dialogAction?: string
      isSystem?: boolean
      systemKind?: string
      recapId?: string
    }
  | { kind: 'images'; images: Array<{ hash: string; ext: string; url: string; originalPath: string }> }
  // Inline system entry rendered inside an assistant group (api_retry,
  // informational, turn_duration, etc.). Carries the raw entry so the
  // renderer can dispatch on subtype just like the standalone SystemLine.
  | { kind: 'system'; entry: Record<string, unknown>; subtype: string; timestamp?: string }

// fallow-ignore-next-line duplication
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s % 60)}s`
}
