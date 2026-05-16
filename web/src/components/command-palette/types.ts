import type { FileInfo } from '@/hooks/use-file-editor'
import type { Conversation } from '@/lib/types'
import type { SentinelSuggestion } from './use-spawn-mode'

export interface PaletteCommand {
  id: string
  label: string
  shortcut?: string
  shortcuts?: string[]
  action: () => void
}

export type PaletteMode = 'conversation' | 'command' | 'file' | 'spawn' | 'task' | 'theme'

/** Merged result item for the no-prefix palette: conversations + commands fuzzy-matched together. */
export type MergedItem =
  | { kind: 'conversation'; conversation: Conversation; score: number; live: boolean }
  | { kind: 'command'; command: PaletteCommand; score: number; live: boolean }

export interface CommandPaletteProps {
  onSelect: (conversationId: string) => void
  onFileSelect: (conversationId: string, path: string) => void
  onClose: () => void
}

interface ResultListProps {
  activeIndex: number
  setActiveIndex: (i: number) => void
}

export interface ConversationResultsProps extends ResultListProps {
  conversations: Conversation[]
  selectedConversationId: string | null
  projectSettings: Record<string, { label?: string; icon?: string; color?: string; keyterms?: string[] }>
  onSelect: (conversationId: string) => void
}

export interface CommandResultsProps extends ResultListProps {
  commands: PaletteCommand[]
}

export interface FileResultsProps extends ResultListProps {
  files: FileInfo[]
  loading: boolean
  selectedConversationId: string | null
  onFileSelect: (conversationId: string, path: string) => void
}

export interface SpawnResultsProps extends ResultListProps {
  dirs: string[]
  sentinels: SentinelSuggestion[]
  isSentinelEntry: boolean
  resolvedSentinel: string
  loading: boolean
  error: string | null
  path: string
  spawning: boolean
  sentinelConnected: boolean
  canCreateDir: boolean
  onDirSelect: (dir: string) => void
  onSentinelSelect: (alias: string) => void
  onSpawn: (path: string, mkdir?: boolean) => void
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
