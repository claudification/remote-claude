/**
 * Chat API Connection types -- shared between broker and control panel.
 */

export interface ChatApiConnection {
  id: string
  name: string
  url: string
  apiKey: string
  model?: string
  enabled: boolean
  createdAt: number
}

export interface ChatApiConnectionCreate {
  name: string
  url: string
  apiKey: string
  model?: string
}

export interface ChatApiConnectionUpdate {
  name?: string
  url?: string
  apiKey?: string
  model?: string
  enabled?: boolean
}
