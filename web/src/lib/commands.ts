import { useEffect, useRef } from 'react'
import { useKeyLayer } from './key-layers'

// ── Types ──────────────────────────────────────────────────────────────────

type CommandAction = (...args: string[]) => void

export interface Command {
  id: string
  label: string
  shortcut?: string
  action: CommandAction
  when?: () => boolean
  group?: string
  submenu?: string
}

interface UseCommandOptions {
  label?: string
  shortcut?: string
  when?: () => boolean
  group?: string
  submenu?: string
}

// ── Registry (module singleton) ──────────────────────────────────────────

const commands = new Map<string, Command>()
let generation = 0

function registerCommand(cmd: Command): () => void {
  commands.set(cmd.id, cmd)
  generation++
  return () => {
    commands.delete(cmd.id)
    generation++
  }
}

export function executeCommand(id: string, ...args: string[]): boolean {
  const cmd = commands.get(id)
  if (!cmd) return false
  if (cmd.when && !cmd.when()) return false
  cmd.action(...args)
  return true
}

export function getCommands(): Command[] {
  return Array.from(commands.values()).filter(c => !c.when || c.when())
}

export function getCommandGeneration(): number {
  return generation
}

// ── useCommand hook ─────────────────────────────────────────────────────

export function useCommand(id: string, action: CommandAction, options: UseCommandOptions = {}) {
  const actionRef = useRef(action)
  const whenRef = useRef(options.when)
  actionRef.current = action
  whenRef.current = options.when

  useEffect(() => {
    const cmd: Command = {
      id,
      label: options.label ?? id,
      shortcut: options.shortcut,
      group: options.group,
      submenu: options.submenu,
      action: (...args: string[]) => actionRef.current(...args),
      when: whenRef.current ? () => whenRef.current?.() ?? false : undefined,
    }
    return registerCommand(cmd)
  }, [id, options.label, options.shortcut, options.group, options.submenu])

  useKeyLayer(
    options.shortcut
      ? {
          [options.shortcut]: () => {
            if (whenRef.current && !whenRef.current()) return
            actionRef.current()
          },
        }
      : {},
    { base: true, id: `cmd:${id}` },
  )
}

// ── useChordCommand helper ──────────────────────────────────────────────

interface UseChordCommandOptions {
  label: string
  /** Chord key after the prefix, e.g. "t" for ⌘K T / ⌘G T. May include spaces for multi-key chords. */
  key: string
  when?: () => boolean
  group?: string
}

/**
 * Register a chord command under BOTH ⌘K and ⌘G prefixes. ⌘K is the
 * primary chord (VSCode-style), ⌘G is a transitional alias so existing
 * muscle memory keeps working during the migration.
 *
 * The palette dedupes commands by label and merges shortcuts into one
 * entry, so users see both bindings next to a single action.
 */
export function useChordCommand(id: string, action: CommandAction, options: UseChordCommandOptions) {
  useCommand(id, action, {
    label: options.label,
    shortcut: `mod+k ${options.key}`,
    when: options.when,
    group: options.group,
  })
  useCommand(`${id}-legacy`, action, {
    label: options.label,
    shortcut: `mod+g ${options.key}`,
    when: options.when,
    group: options.group,
  })
}

// ── Chord validation ───────────────────────────────────────────────────

interface ChordConflict {
  /** The binding that's both a command AND a prefix of a longer chord */
  binding: string
  bindingLabel: string
  /** The longer chord(s) that use it as a prefix */
  longerChords: Array<{ shortcut: string; label: string }>
}

/**
 * Detect chord bindings that are also prefixes of longer chords.
 * e.g. "mod+g s" (spawn) conflicts with "mod+g s e" (sub-action)
 * because pressing S would enter chord mode instead of firing spawn immediately.
 */
export function validateChordBindings(): ChordConflict[] {
  const all = Array.from(commands.values()).filter(
    (c): c is Command & { shortcut: string } => !!c.shortcut?.includes(' '),
  )
  const conflicts: ChordConflict[] = []

  for (const cmd of all) {
    const prefix = `${cmd.shortcut} `
    const longer = all.filter(other => other.id !== cmd.id && other.shortcut.startsWith(prefix))
    if (longer.length > 0) {
      conflicts.push({
        binding: cmd.shortcut,
        bindingLabel: cmd.label,
        longerChords: longer.map(c => ({ shortcut: c.shortcut, label: c.label })),
      })
    }
  }

  return conflicts
}

// ── Formatting helpers ──────────────────────────────────────────────────

const isMac =
  typeof navigator !== 'undefined' &&
  (/Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent))

export function formatShortcut(shortcut: string): string {
  return shortcut
    .split(' ')
    .map(part =>
      part
        .split('+')
        .map(k => {
          if (k === 'mod') return isMac ? '⌘' : 'Ctrl'
          if (k === 'ctrl') return isMac ? '⌃' : 'Ctrl'
          if (k === 'alt') return isMac ? '⌥' : 'Alt'
          if (k === 'shift') return isMac ? '⇧' : 'Shift'
          if (k === 'meta') return isMac ? '⌘' : 'Win'
          if (k.length === 1) return k.toUpperCase()
          return k
        })
        .join(isMac ? '' : '+'),
    )
    .join(' ')
}
