/**
 * Hermes Agent types -- shared between broker and control panel.
 */

export interface HermesAgent {
  id: string
  name: string
  url: string
  apiKey: string
  model?: string
  icon?: string
  color?: string
  enabled: boolean
  createdAt: number
}

export interface HermesAgentCreate {
  name: string
  url: string
  apiKey: string
  model?: string
  icon?: string
  color?: string
}

export interface HermesAgentUpdate {
  name?: string
  url?: string
  apiKey?: string
  model?: string
  icon?: string
  color?: string
  enabled?: boolean
}
