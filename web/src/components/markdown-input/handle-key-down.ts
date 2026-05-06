import type React from 'react'
import { matchSubCommand, NO_ARG_COMMANDS } from '../input-editor/sub-commands'
import type { AutocompleteItem } from './use-autocomplete'

interface KeyDownContext {
  value: string
  onChange: (value: string) => void
  expanded: boolean
  setExpanded: (v: boolean) => void
  acItems: AutocompleteItem[]
  acIndex: number
  setAcIndex: (i: number | ((prev: number) => number)) => void
  selectAutocomplete: (
    item: string,
    textareaRef: React.RefObject<HTMLTextAreaElement | null>,
    value: string,
    onChange: (v: string) => void,
  ) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  handleSubmit: () => void
  onStash?: () => void
}

export function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>, ctx: KeyDownContext) {
  const ta = ctx.textareaRef.current

  if (ctx.acItems.length > 0) {
    if (handleAutocompleteKeys(e, ctx)) return
  }

  if (!ctx.expanded && e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    e.preventDefault()
    ctx.handleSubmit()
  }
  if (e.key === 'Escape' && ctx.expanded) {
    e.preventDefault()
    ctx.setExpanded(false)
  }

  if (e.ctrlKey && e.key === 's' && ctx.onStash) {
    e.preventDefault()
    ctx.onStash()
    return
  }

  if (e.ctrlKey && ta) {
    handleReadlineKeys(e, ta, ctx.value, ctx.onChange)
  }
}

function handleAutocompleteKeys(e: React.KeyboardEvent<HTMLTextAreaElement>, ctx: KeyDownContext): boolean {
  if (e.key === 'Enter' && !e.shiftKey) {
    const trimmed = ctx.value.trim()
    const noArgName = trimmed.startsWith('/') ? trimmed.slice(1) : ''
    if (noArgName && NO_ARG_COMMANDS.has(noArgName)) {
      e.preventDefault()
      ctx.handleSubmit()
      return true
    }
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    ctx.setAcIndex(i => (i + 1) % ctx.acItems.length)
    return true
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    ctx.setAcIndex(i => (i - 1 + ctx.acItems.length) % ctx.acItems.length)
    return true
  }
  if (e.key === 'Tab') {
    e.preventDefault()
    ctx.selectAutocomplete(ctx.acItems[ctx.acIndex].item, ctx.textareaRef, ctx.value, ctx.onChange)
    return true
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const selected = ctx.acItems[ctx.acIndex]
    const sub = matchSubCommand(ctx.value)
    if (sub) {
      const [cmd, rest] = sub
      if (cmd.enterBehavior === 'select-or-submit' && rest.trim() === selected.item) {
        ctx.handleSubmit()
      } else {
        ctx.selectAutocomplete(selected.item, ctx.textareaRef, ctx.value, ctx.onChange)
      }
      return true
    }
    const currentCmd = ctx.value.startsWith('/')
      ? ctx.value.slice(1).trim()
      : ctx.value.startsWith('@')
        ? ctx.value.slice(1).trim()
        : ''
    if (currentCmd === selected.item) {
      ctx.handleSubmit()
    } else if (NO_ARG_COMMANDS.has(selected.item)) {
      ctx.onChange(`/${selected.item}`)
      requestAnimationFrame(() => ctx.handleSubmit())
    } else {
      ctx.selectAutocomplete(selected.item, ctx.textareaRef, ctx.value, ctx.onChange)
    }
    return true
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    ctx.onChange('')
    return true
  }
  return false
}

function handleReadlineKeys(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  ta: HTMLTextAreaElement,
  value: string,
  onChange: (v: string) => void,
) {
  const pos = ta.selectionStart
  if (e.key === 'u') {
    e.preventDefault()
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1
    onChange(value.slice(0, lineStart) + value.slice(pos))
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = lineStart
    })
  }
  if (e.key === 'w') {
    e.preventDefault()
    let i = pos - 1
    while (i >= 0 && /\s/.test(value[i])) i--
    while (i >= 0 && !/\s/.test(value[i])) i--
    const wordStart = i + 1
    onChange(value.slice(0, wordStart) + value.slice(pos))
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = wordStart
    })
  }
  if (e.key === 'a') {
    e.preventDefault()
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1
    ta.selectionStart = ta.selectionEnd = lineStart
  }
  if (e.key === 'e') {
    e.preventDefault()
    let lineEnd = value.indexOf('\n', pos)
    if (lineEnd === -1) lineEnd = value.length
    ta.selectionStart = ta.selectionEnd = lineEnd
  }
}
