import type { ConversationSummary } from '../../shared/protocol'

export type { ConversationSummary }

export interface SentinelStatusInfo {
  sentinelId: string
  alias: string
  hostname?: string
  connected: boolean
  isDefault?: boolean
  color?: string
}

export interface ControlPanelMessage {
  type:
    | 'conversation_update'
    | 'conversation_created'
    | 'conversation_ended'
    | 'event'
    | 'conversations_list'
    | 'sentinel_status'
    | 'toast'
    | 'settings_updated'
    | 'project_settings_updated'
    | 'clipboard_capture'
    | 'usage_update'
  conversationId?: string
  previousConversationId?: string
  session?: ConversationSummary
  sessions?: ConversationSummary[]
  event?: unknown
  connected?: boolean
  machineId?: string
  hostname?: string
  sentinels?: SentinelStatusInfo[]
  title?: string
  message?: string
  settings?: unknown
}
