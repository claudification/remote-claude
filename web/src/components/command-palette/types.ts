import type { FileInfo } from '@/hooks/use-file-editor'
import type { Session } from '@/lib/types'

export interface PaletteCommand {
  id: string
  label: string
  shortcut?: string
  action: () => void
}

export type PaletteMode = 'session' | 'command' | 'file' | 'spawn'

export interface CommandPaletteProps {
  onSelect: (sessionId: string) => void
  onFileSelect: (sessionId: string, path: string) => void
  onClose: () => void
}

export interface ResultListProps {
  activeIndex: number
  setActiveIndex: (i: number) => void
}

export interface SessionResultsProps extends ResultListProps {
  sessions: Session[]
  selectedSessionId: string | null
  projectSettings: Record<string, any>
  onSelect: (sessionId: string) => void
}

export interface CommandResultsProps extends ResultListProps {
  commands: PaletteCommand[]
}

export interface FileResultsProps extends ResultListProps {
  files: FileInfo[]
  loading: boolean
  selectedSessionId: string | null
  onFileSelect: (sessionId: string, path: string) => void
}

export interface SpawnResultsProps extends ResultListProps {
  dirs: string[]
  loading: boolean
  error: string | null
  path: string
  spawning: boolean
  agentConnected: boolean
  canCreateDir: boolean
  onDirSelect: (dir: string) => void
  onSpawn: (cwd: string, mkdir?: boolean) => void
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
