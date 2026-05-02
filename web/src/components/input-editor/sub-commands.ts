/**
 * Sub-command registry shared by both backends (legacy MarkdownInput + CM).
 *
 * One source of truth for `/model`, `/workon`, `/clear`, etc. -- their
 * argument completers, post-select side-effects, and Enter behavior.
 *
 * Each backend wires this up its own way:
 *   - Legacy: reads SUB_COMMANDS directly inside MarkdownInput.tsx
 *   - CM    : passes a `getSubCommandContext()` callback into
 *             buildInputExtensions(); the autocomplete extension calls it
 *             at completion time so the extension closure stays stable
 *             across React renders.
 */

import { sendInput } from '@/hooks/use-conversations'
import type { ProjectTaskMeta } from '@/hooks/use-project'
import { buildTaskPrompt, scoreAndSortTasks } from '@/lib/task-scoring'
import { haptic } from '@/lib/utils'
import { completeModelArg } from './autocomplete-shared'

interface SubCommandItem {
  value: string
  label?: string
  builtin?: boolean
}

export interface SubCommandContext {
  tasks: ProjectTaskMeta[]
  conversationId: string | null
}

export interface SubCommandDef {
  name: string
  noArg?: boolean
  completer?: (query: string, ctx: SubCommandContext) => SubCommandItem[]
  /**
   * Invoked when the user accepts a completion. Returns the string the
   * input should be replaced with, or null to leave the input untouched
   * (the side-effect already handled the action -- e.g. /workon sends
   * the prompt + clears).
   */
  onSelect?: (value: string, ctx: SubCommandContext) => string | null
  /**
   * - `select`            : Enter always picks the highlighted option,
   *                         never falls through to submit. Used by /workon
   *                         where typing the slug as text is meaningless.
   * - `select-or-submit`  : Enter picks the option UNLESS the typed arg
   *                         already matches the selected option exactly,
   *                         in which case submit. Used by /model so an
   *                         already-correct id submits without re-picking.
   * - omitted             : default -- Tab picks, Enter submits.
   */
  enterBehavior?: 'select' | 'select-or-submit'
}

export const SUB_COMMANDS: SubCommandDef[] = [
  {
    name: 'model',
    enterBehavior: 'select-or-submit',
    completer: q => completeModelArg(q).map(m => ({ value: m, builtin: true })),
  },
  {
    name: 'workon',
    enterBehavior: 'select',
    completer: (q, ctx) =>
      scoreAndSortTasks(ctx.tasks, q)
        .slice(0, 12)
        .map(t => ({
          value: t.slug,
          label: `[${t.status}] ${t.title}${t.priority ? ` (${t.priority})` : ''}`,
        })),
    onSelect: (slug, ctx) => {
      const task = ctx.tasks.find(t => t.slug === slug)
      if (!task || !ctx.conversationId) return null
      sendInput(ctx.conversationId, buildTaskPrompt(task))
      haptic('success')
      return '' // clear input
    },
  },
  {
    name: 'effort',
    enterBehavior: 'select-or-submit',
    completer: q => {
      const levels = ['low', 'medium', 'high', 'max']
      const ql = q.toLowerCase()
      return levels.filter(l => !ql || l.includes(ql)).map(l => ({ value: l, builtin: true }))
    },
  },
  {
    name: 'mode',
    enterBehavior: 'select-or-submit',
    completer: q => {
      const modes = [
        { value: 'default', label: 'Default - CC default prompting' },
        { value: 'plan', label: 'Plan - plan-first mode' },
        { value: 'acceptEdits', label: 'Accept Edits - auto-accept file edits' },
        { value: 'auto', label: 'Auto - auto-approve most tools' },
        { value: 'bypassPermissions', label: 'Bypass - skip permission prompts' },
      ]
      const ql = q.toLowerCase()
      return modes
        .filter(m => !ql || m.value.toLowerCase().includes(ql) || m.label.toLowerCase().includes(ql))
        .map(m => ({ value: m.value, label: m.label, builtin: true }))
    },
  },
  { name: 'plan', noArg: true },
  { name: 'clear', noArg: true },
  { name: 'exit', noArg: true },
  { name: 'compact', noArg: true },
  // Client-side commands -- intercepted by InputEditor.wrap (see client-commands.ts).
  { name: 'settings', noArg: true },
  { name: 'config', noArg: true },
  { name: 'project', noArg: true },
  { name: 'session', noArg: true },
]

export const BUILTIN_NAMES = SUB_COMMANDS.map(c => c.name)

export const NO_ARG_COMMANDS: ReadonlySet<string> = new Set([
  ...SUB_COMMANDS.filter(c => c.noArg).map(c => c.name),
  'context', // CC-reported commands that take no args
  'quit',
])

const SUB_COMMAND_MAP = new Map(SUB_COMMANDS.filter(c => c.completer).map(c => [c.name, c]))

/** Match `/command args...` at start of input. Returns [def, argsRest] or null. */
export function matchSubCommand(input: string): [SubCommandDef, string] | null {
  const m = input.match(/^\/(\S+)\s+([\s\S]*)/)
  if (!m) return null
  const cmd = SUB_COMMAND_MAP.get(m[1].toLowerCase())
  return cmd ? [cmd, m[2]] : null
}

/** Lookup a sub-command by name (lowercased). */
export function getSubCommand(name: string): SubCommandDef | undefined {
  return SUB_COMMAND_MAP.get(name.toLowerCase())
}
