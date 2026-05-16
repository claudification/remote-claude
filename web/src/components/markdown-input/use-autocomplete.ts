import type React from 'react'
import { useMemo, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useProject } from '@/hooks/use-project'
import { haptic } from '@/lib/utils'
import { fuzzyScore } from '../input-editor/autocomplete-shared'
import { BUILTIN_NAMES, matchSubCommand, NO_ARG_COMMANDS, type SubCommandContext } from '../input-editor/sub-commands'

const EMPTY_INFO: { slashCommands: string[]; skills: string[]; agents: string[] } = {
  slashCommands: [],
  skills: [],
  agents: [],
}

export interface AutocompleteItem {
  item: string
  label?: string
  builtin: boolean
}

interface UseAutocompleteResult {
  acItems: AutocompleteItem[]
  acIndex: number
  setAcIndex: (i: number | ((prev: number) => number)) => void
  acTrigger: string | null
  selectAutocomplete: (
    item: string,
    textareaRef: React.RefObject<HTMLTextAreaElement | null>,
    value: string,
    onChange: (v: string) => void,
  ) => void
}

export function useAutocomplete(
  value: string,
  enableAutocomplete: boolean,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
): UseAutocompleteResult {
  const [acIndex, setAcIndex] = useState(0)

  const maybeAutocomplete = enableAutocomplete && (value.includes('/') || value.includes('@'))

  const conversationInfoData = useConversationsStore(state => {
    if (!maybeAutocomplete) return EMPTY_INFO
    const sid = state.selectedConversationId
    return (sid ? state.conversationInfo[sid] : null) || EMPTY_INFO
  })

  const hasSubCommandWithTasks = enableAutocomplete && /^\/workon\s/i.test(value)
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const { tasks: projectTasks } = useProject(hasSubCommandWithTasks ? selectedConversationId : null)
  const subCmdCtx = useMemo(
    (): SubCommandContext => ({ tasks: projectTasks, conversationId: selectedConversationId }),
    [projectTasks, selectedConversationId],
  )

  const acItems = useMemo((): AutocompleteItem[] => {
    if (!maybeAutocomplete) return []

    const sub = matchSubCommand(value)
    if (sub) {
      const [cmd, rest] = sub
      return (cmd.completer?.(rest.trim(), subCmdCtx) ?? []).map(x => ({
        item: x.value,
        label: x.label,
        builtin: x.builtin ?? false,
      }))
    }

    const pos = textareaRef.current?.selectionStart ?? value.length
    let start = pos - 1
    while (start >= 0 && /[a-zA-Z0-9_:-]/.test(value[start])) start--
    if (start < 0) return []
    const ch = value[start]
    if (ch !== '/' && ch !== '@') return []
    if (start > 0 && !/[\s\n]/.test(value[start - 1])) return []
    const before = value.slice(0, start)
    if ((before.match(/`/g) || []).length % 2 !== 0) return []
    if (before.includes('```') && (before.match(/```/g) || []).length % 2 !== 0) return []
    const query = value.slice(start + 1, pos)
    if (query.includes(' ') || query.includes('\n')) return []

    const q = query.toLowerCase()
    const scored: Array<{ item: string; score: number; builtin: boolean }> = []

    if (ch === '/') {
      const atStart = start === 0
      if (atStart) {
        for (const item of BUILTIN_NAMES) {
          const score = !q ? 100 : item.includes(q) ? 100 + (item.startsWith(q) ? 10 : 0) : 0
          if (score > 0) scored.push({ item, score, builtin: true })
        }
      }
      for (const item of conversationInfoData.slashCommands || []) {
        if (BUILTIN_NAMES.includes(item)) continue
        const score = fuzzyScore(q, item)
        if (score > 0) scored.push({ item, score, builtin: false })
      }
    } else {
      for (const item of [...(conversationInfoData.skills || []), ...(conversationInfoData.agents || [])]) {
        const score = fuzzyScore(q, item)
        if (score > 0) scored.push({ item, score, builtin: false })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 12).map(x => ({ item: x.item, builtin: x.builtin }))
  }, [maybeAutocomplete, value, conversationInfoData, subCmdCtx, textareaRef])

  const acTrigger = useMemo(() => {
    if (!acItems.length) return null
    const pos = textareaRef.current?.selectionStart ?? value.length
    let start = pos - 1
    while (start >= 0 && /[a-zA-Z0-9_:-]/.test(value[start])) start--
    return start >= 0 ? value[start] : '/'
  }, [acItems.length, value, textareaRef])

  function selectAutocomplete(
    item: string,
    taRef: React.RefObject<HTMLTextAreaElement | null>,
    val: string,
    onChangeVal: (v: string) => void,
  ) {
    const ta = taRef.current
    haptic('tap')
    setAcIndex(0)

    const sub = matchSubCommand(val)
    if (sub) {
      const [cmd] = sub
      const replacement = cmd.onSelect ? cmd.onSelect(item, subCmdCtx) : `/${cmd.name} ${item}`
      if (replacement != null) {
        onChangeVal(replacement)
        requestAnimationFrame(() => {
          if (ta) ta.selectionStart = ta.selectionEnd = replacement.length
        })
      }
      return
    }

    const pos = ta?.selectionStart ?? val.length
    let start = pos - 1
    while (start >= 0 && /[a-zA-Z0-9_:-]/.test(val[start])) start--
    const trigger = start >= 0 ? val[start] : null
    if (start >= 0 && (trigger === '/' || trigger === '@')) {
      const before = val.slice(0, start)
      const after = val.slice(pos)
      const needsSpace = !NO_ARG_COMMANDS.has(item)
      const replacement = `${trigger}${item}${needsSpace ? ' ' : ''}`
      onChangeVal(before + replacement + after)
      requestAnimationFrame(() => {
        if (ta) ta.selectionStart = ta.selectionEnd = before.length + replacement.length
      })
    }
  }

  return { acItems, acIndex, setAcIndex, acTrigger, selectAutocomplete }
}
