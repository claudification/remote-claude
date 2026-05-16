import { useMemo } from 'react'
import { formatShortcut, getCommandGeneration, getCommands } from '@/lib/commands'
import type { PaletteCommand } from './types'

/**
 * Local widening of PaletteCommand: the public interface declares
 * `action: () => void` (so onClick handlers accept it), but the registry
 * commands accept positional args parsed from the search input
 * (e.g. `> effort high` -> `action('high')`). The orchestrator and
 * Enter-key dispatcher need the wider call signature.
 */
export type RegistryCommand = Omit<PaletteCommand, 'action'> & {
  action: (...args: string[]) => void
  submenu?: string
}

export interface CommandModeState {
  registryCommands: RegistryCommand[]
  filteredCommands: RegistryCommand[]
  getCommandArgs: (cmd: RegistryCommand) => string[]
}

/**
 * Command-mode (`>` prefix) derivations. Owns the deduplicated registry view
 * and the filtered subset matching the current search. Also exposes
 * `registryCommands` because conversation-mode mixes commands into the merged
 * fuzzy-search results.
 */
export function useCommandMode(filter: string, isCommandMode: boolean, onClose: () => void): CommandModeState {
  const commandRaw = isCommandMode ? filter.slice(1).trim() : ''
  const commandSearch = commandRaw.toLowerCase()
  const _gen = getCommandGeneration()

  // biome-ignore lint/correctness/useExhaustiveDependencies: _gen is a generation counter dep key that invalidates memoized command list when registry changes
  const registryCommands = useMemo(() => buildRegistryCommands(onClose), [_gen, onClose])

  const filteredCommands = isCommandMode ? filterCommandsBySearch(registryCommands, commandSearch) : []

  function getCommandArgs(cmd: RegistryCommand): string[] {
    const parts = commandRaw.split(/\s+/)
    const idLower = cmd.id.toLowerCase()
    if (parts[0]?.toLowerCase() === idLower && parts.length > 1) {
      return parts.slice(1)
    }
    return []
  }

  return { registryCommands, filteredCommands, getCommandArgs }
}

function buildRegistryCommands(onClose: () => void): RegistryCommand[] {
  const raw: RegistryCommand[] = getCommands().map(c => ({
    id: c.id,
    label: c.label,
    shortcut: c.shortcut ? formatShortcut(c.shortcut) : undefined,
    submenu: c.submenu,
    action: (...args: string[]) => {
      c.action(...args)
      if (!c.submenu) onClose()
    },
  }))
  // Deduplicate by label, merging shortcuts into a list
  const byLabel = new Map<string, RegistryCommand & { shortcuts?: string[] }>()
  for (const cmd of raw) {
    const existing = byLabel.get(cmd.label)
    if (existing) {
      const shortcuts = existing.shortcuts ?? (existing.shortcut ? [existing.shortcut] : [])
      if (cmd.shortcut) shortcuts.push(cmd.shortcut)
      existing.shortcuts = shortcuts
    } else {
      byLabel.set(cmd.label, cmd)
    }
  }
  return Array.from(byLabel.values())
}

function filterCommandsBySearch(commands: RegistryCommand[], search: string): RegistryCommand[] {
  return commands.filter(c => {
    const id = c.id.toLowerCase()
    const label = c.label.toLowerCase()
    // "effort high" matches command "effort" -- the "high" part is an arg
    return label.includes(search) || id.includes(search) || search.startsWith(id)
  })
}
