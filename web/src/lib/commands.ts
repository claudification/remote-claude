import { useEffect, useRef } from 'react'
import { useKeyLayer } from './key-layers'

// ── Types ──────────────────────────────────────────────────────────────────

export type CommandAction = (...args: string[]) => void

export interface Command {
  id: string
  label: string
  shortcut?: string
  action: CommandAction
  when?: () => boolean
  group?: string
}

interface UseCommandOptions {
  label?: string
  shortcut?: string
  when?: () => boolean
  group?: string
}

// ── Registry (module singleton) ──────────────────────────────────────────

const commands = new Map<string, Command>()
let generation = 0

export function registerCommand(cmd: Command): () => void {
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
      action: (...args: string[]) => actionRef.current(...args),
      when: whenRef.current ? () => whenRef.current?.() ?? false : undefined,
    }
    return registerCommand(cmd)
  }, [id, options.label, options.shortcut, options.group])

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

// ── Chord validation ───────────────────────────────────────────────────

export interface ChordConflict {
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
