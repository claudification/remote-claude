import { Mic, Paperclip } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { VoiceOverlay } from '@/components/voice-overlay'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useProject } from '@/hooks/use-project'
import { uploadFileWithPlaceholder } from '@/lib/upload'
import { cn, haptic, isMobileViewport } from '@/lib/utils'
import { fuzzyScore } from './input-editor/autocomplete-shared'
import { BUILTIN_NAMES, matchSubCommand, NO_ARG_COMMANDS, type SubCommandContext } from './input-editor/sub-commands'

const EMPTY_INFO: { slashCommands: string[]; skills: string[]; agents: string[] } = {
  slashCommands: [],
  skills: [],
  agents: [],
}

interface MarkdownInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  placeholder?: string
  className?: string
  autoFocus?: boolean
  inline?: boolean // Force inline mode: no mobile expand, autoFocus works on mobile
  enableAutocomplete?: boolean // Enable slash command / @ autocomplete (default: false)
  enableEffortKeywords?: boolean // Highlight ultrathink keyword (default: false, prompt input only)
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(isMobileViewport)
  useEffect(() => {
    const check = () => setIsMobile(isMobileViewport())
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  return isMobile
}

// Lightweight markdown syntax highlighter - colors syntax markers, not rendered output
function highlightMarkdown(text: string, enableEffortKeywords = false): string {
  if (!text) return '\n' // Need at least a newline for height matching

  // Escape HTML first
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Fenced code blocks (``` ... ```) - fence markers + lang tag in bright cyan, content in dimmer cyan
  html = html.replace(
    /(```(\w*)\n?)([\s\S]*?)(```)/g,
    '<span class="text-cyan-300">$1</span><span class="text-cyan-400/70">$3</span><span class="text-cyan-300">$4</span>',
  )

  // Inline code (`...`)
  html = html.replace(/(`[^`\n]+`)/g, '<span class="text-cyan-400">$1</span>')

  // Bold, italic, headings, etc. must not match inside already-highlighted code spans.
  // Split on code spans (already wrapped in <span>...</span> from above), process only non-code parts.
  html = html
    .split(/(<span class="text-cyan-[^"]*">[\s\S]*?<\/span>)/g)
    .map((part, i) => {
      // Odd indices are code spans - leave them alone
      if (i % 2 === 1) return part
      // Bold (**...**) - color only, NO font-bold (shifts glyph widths, misaligns caret)
      let p = part.replace(/(\*\*[^*]+\*\*)/g, '<span class="text-foreground">$1</span>')
      // Italic (*...* or _..._) - color only, NO italic (shifts glyph widths, misaligns caret)
      p = p.replace(/(?<!\*)(\*[^*\n]+\*)(?!\*)/g, '<span class="text-foreground/70">$1</span>')
      p = p.replace(/(?<!_)(_[^_\n]+_)(?!_)/g, '<span class="text-foreground/70">$1</span>')
      // Headings (# at start of line) - color only
      p = p.replace(/^(#{1,6}\s.*)$/gm, '<span class="text-accent">$1</span>')
      return p
    })
    .join('')

  // Blockquotes (> at start of line)
  html = html.replace(/^(&gt;\s?.*)$/gm, '<span class="text-muted-foreground">$1</span>')

  // List items (- or * at start of line)
  html = html.replace(/^(\s*[-*]\s)/gm, '<span class="text-muted-foreground">$1</span>')

  // Links [text](url)
  html = html.replace(/(\[[^\]]*\]\([^)]*\))/g, '<span class="text-accent underline">$1</span>')

  // Effort keywords (ultrathink = high effort) - only in prompt input, not task editors
  if (enableEffortKeywords) {
    html = html.replace(
      /\b(ultrathink)\b/gi,
      '<span class="text-orange-400 underline decoration-orange-400/40 decoration-2 underline-offset-2">$1</span>',
    )
  }

  // Ensure trailing newline for height matching
  if (!html.endsWith('\n')) html += '\n'

  return html
}

export function MarkdownInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  className,
  autoFocus,
  inline,
  enableAutocomplete = false,
  enableEffortKeywords = false,
}: MarkdownInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isMobile = useIsMobile()

  // Auto-focus on mount (non-mobile only - avoids keyboard popup, unless inline mode)
  useEffect(() => {
    if (autoFocus && (inline || !isMobile)) {
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }, [autoFocus, isMobile, inline])
  const voiceCapable = useConversationsStore(state => state.serverCapabilities.voice)
  const showVoicePref = useConversationsStore(state => state.controlPanelPrefs.showVoiceInput)
  const showVoice = voiceCapable && showVoicePref

  const [expanded, setExpanded] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [acIndex, setAcIndex] = useState(0) // autocomplete selection index

  // Autocomplete: only activate when prop is enabled and value contains / or @ (cheap check before anything else)
  const maybeAutocomplete = enableAutocomplete && (value.includes('/') || value.includes('@'))

  // Session info for autocomplete data - only subscribe when we might need it
  const sessionInfoData = useConversationsStore(state => {
    if (!maybeAutocomplete) return EMPTY_INFO
    const sid = state.selectedConversationId
    return (sid ? state.sessionInfo[sid] : null) || EMPTY_INFO
  })

  // Task data for sub-command completers (e.g. /workon) - only load when needed
  const hasSubCommandWithTasks = enableAutocomplete && /^\/workon\s/i.test(value)
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const { tasks: projectTasks } = useProject(hasSubCommandWithTasks ? selectedConversationId : null)
  const subCmdCtx = useMemo(
    (): SubCommandContext => ({ tasks: projectTasks, sessionId: selectedConversationId }),
    [projectTasks, selectedConversationId],
  )

  const acItems = useMemo((): Array<{ item: string; label?: string; builtin: boolean }> => {
    if (!maybeAutocomplete) return []

    // Sub-command completion: /command {query} -> delegate to registered completer
    const sub = matchSubCommand(value)
    if (sub) {
      const [cmd, rest] = sub
      return (cmd.completer?.(rest.trim(), subCmdCtx) ?? []).map(x => ({
        item: x.value,
        label: x.label,
        builtin: x.builtin ?? false,
      }))
    }

    // Standard trigger detection: scan backwards from cursor for / or @
    const pos = textareaRef.current?.selectionStart ?? value.length
    let start = pos - 1
    while (start >= 0 && /[a-zA-Z0-9_:-]/.test(value[start])) start--
    if (start < 0) return []
    const ch = value[start]
    if (ch !== '/' && ch !== '@') return []
    if (start > 0 && !/[\s\n]/.test(value[start - 1])) return []
    // Not inside backticks
    const before = value.slice(0, start)
    if ((before.match(/`/g) || []).length % 2 !== 0) return []
    if (before.includes('```') && (before.match(/```/g) || []).length % 2 !== 0) return []
    const query = value.slice(start + 1, pos)
    if (query.includes(' ') || query.includes('\n')) return []

    // Get source list + builtins for /
    const q = query.toLowerCase()
    const scored: Array<{ item: string; score: number; builtin: boolean }> = []

    if (ch === '/') {
      const atStart = start === 0
      // Registered builtin commands (model, clear, exit, etc.) only at start of input
      if (atStart) {
        for (const item of BUILTIN_NAMES) {
          const score = !q ? 100 : item.includes(q) ? 100 + (item.startsWith(q) ? 10 : 0) : 0
          if (score > 0) scored.push({ item, score, builtin: true })
        }
      }
      // CC slash commands (skills, etc.) complete anywhere in text
      for (const item of sessionInfoData.slashCommands || []) {
        if (BUILTIN_NAMES.includes(item)) continue // skip dupes
        const score = fuzzyScore(q, item)
        if (score > 0) scored.push({ item, score, builtin: false })
      }
    } else {
      // @ = skills + agents
      for (const item of [...(sessionInfoData.skills || []), ...(sessionInfoData.agents || [])]) {
        const score = fuzzyScore(q, item)
        if (score > 0) scored.push({ item, score, builtin: false })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 12).map(x => ({ item: x.item, builtin: x.builtin }))
  }, [maybeAutocomplete, value, sessionInfoData, subCmdCtx])

  // Resolve trigger char for the dropdown display
  const acTrigger = useMemo(() => {
    if (!acItems.length) return null
    const pos = textareaRef.current?.selectionStart ?? value.length
    let start = pos - 1
    while (start >= 0 && /[a-zA-Z0-9_:-]/.test(value[start])) start--
    return start >= 0 ? value[start] : '/'
  }, [acItems.length, value])
  const [pasteChoice, setPasteChoice] = useState<{ file: File } | null>(null)
  const [showVoiceOverlay, setShowVoiceOverlay] = useState(false)
  const [holdToRecord, setHoldToRecord] = useState(false) // true = voice overlay in hold-to-record mode
  const holdActiveRef = useRef(false) // track across renders for touchend handler

  // Central timer registry for all compose-related timers.
  // handleExpandedFocus clears them all - leaked timers can't collapse compose after re-focus.
  const composeTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())

  function composeTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => {
      composeTimersRef.current.delete(id)
      fn()
    }, ms)
    composeTimersRef.current.add(id)
    return id
  }

  function clearComposeTimers() {
    for (const id of composeTimersRef.current) clearTimeout(id)
    composeTimersRef.current.clear()
  }
  const micPermissionRef = useRef(false) // true after getUserMedia succeeds once

  // Sync scroll between textarea and highlight div
  const syncScroll = useCallback(() => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft
    }
  }, [])

  // Auto-resize textarea to fit content
  const autoResize = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    if (expanded) {
      // Expanded mode fills available space via flex
      textarea.style.height = '100%'
      return
    }

    // Cap at 120px (~5 lines) to prevent layout reflow jerk in transcript above.
    // overflow-y is driven by CSS (scrollbar-gutter: stable) so wrap width never
    // changes whether the scrollbar is visible or not -- don't toggle it here.
    const maxHeight = 120
    textarea.style.height = 'auto'
    const scrollH = textarea.scrollHeight
    textarea.style.height = `${Math.min(scrollH, maxHeight)}px`

    requestAnimationFrame(syncScroll)
  }, [expanded, syncScroll])

  // Resize on value change -- useLayoutEffect so the height: auto -> measure -> height: Npx
  // cycle completes BEFORE paint/ResizeObserver. With useEffect, the transient height: auto
  // state triggers ResizeObserver on the transcript's scroll container, causing the virtualizer
  // to recalculate on every keystroke (bypassing TranscriptView's memo via hook-triggered re-render).
  // biome-ignore lint/correctness/useExhaustiveDependencies: value used as dep key to trigger resize when content changes; autoResize handles the actual reading
  useLayoutEffect(() => {
    autoResize()
  }, [value, autoResize])

  // Resize on window resize
  useEffect(() => {
    window.addEventListener('resize', autoResize)
    return () => window.removeEventListener('resize', autoResize)
  }, [autoResize])

  // Track visual viewport height (shrinks when keyboard opens on iOS)
  const [viewportHeight, setViewportHeight] = useState<number | null>(null)

  useEffect(() => {
    if (!expanded) {
      setViewportHeight(null)
      return
    }

    const body = document.body
    const scrollY = window.scrollY
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      overflow: body.style.overflow,
    }
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.overflow = 'hidden'

    // Use visualViewport to track actual visible area (excludes keyboard)
    const vv = window.visualViewport
    if (vv) {
      const update = () => {
        setViewportHeight(vv.height)
        // Pin to top - offset by viewport offset (iOS scrolls the page up when keyboard opens)
        document.documentElement.style.setProperty('--vv-offset', `${vv.offsetTop}px`)
      }
      update()
      vv.addEventListener('resize', update)
      vv.addEventListener('scroll', update)
      return () => {
        vv.removeEventListener('resize', update)
        vv.removeEventListener('scroll', update)
        document.documentElement.style.removeProperty('--vv-offset')
        body.style.position = prev.position
        body.style.top = prev.top
        body.style.left = prev.left
        body.style.right = prev.right
        body.style.overflow = prev.overflow
        window.scrollTo(0, scrollY)
      }
    }

    return () => {
      body.style.position = prev.position
      body.style.top = prev.top
      body.style.left = prev.left
      body.style.right = prev.right
      body.style.overflow = prev.overflow
      window.scrollTo(0, scrollY)
    }
  }, [expanded])

  // Focus the expanded textarea on mount via ref callback
  // useEffect + requestAnimationFrame doesn't work on iOS Safari because
  // the focus isn't from a direct user gesture after the DOM swap
  const expandedTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    if (node) {
      textareaRef.current = node
      node.focus()
    }
  }, [])

  function selectAutocomplete(item: string) {
    const ta = textareaRef.current
    haptic('tap')
    setAcIndex(0)

    // Sub-command mode: delegate to registered onSelect or use default /cmd {item}
    const sub = matchSubCommand(value)
    if (sub) {
      const [cmd] = sub
      const replacement = cmd.onSelect ? cmd.onSelect(item, subCmdCtx) : `/${cmd.name} ${item}`
      if (replacement != null) {
        onChange(replacement)
        requestAnimationFrame(() => {
          if (ta) ta.selectionStart = ta.selectionEnd = replacement.length
        })
      }
      return
    }

    // Standard trigger-based selection
    const pos = ta?.selectionStart ?? value.length
    let start = pos - 1
    while (start >= 0 && /[a-zA-Z0-9_:-]/.test(value[start])) start--
    const trigger = start >= 0 ? value[start] : null
    if (start >= 0 && (trigger === '/' || trigger === '@')) {
      const before = value.slice(0, start)
      const after = value.slice(pos)
      const needsSpace = !NO_ARG_COMMANDS.has(item)
      const replacement = `${trigger}${item}${needsSpace ? ' ' : ''}`
      onChange(before + replacement + after)
      requestAnimationFrame(() => {
        if (ta) ta.selectionStart = ta.selectionEnd = before.length + replacement.length
      })
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ta = textareaRef.current

    // Autocomplete navigation
    if (acItems.length > 0) {
      // Fast path: if the typed value is a complete no-arg command, submit on Enter immediately
      if (e.key === 'Enter' && !e.shiftKey) {
        const trimmed = value.trim()
        const noArgName = trimmed.startsWith('/') ? trimmed.slice(1) : ''
        if (noArgName && NO_ARG_COMMANDS.has(noArgName)) {
          e.preventDefault()
          handleSubmit()
          return
        }
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAcIndex(i => (i + 1) % acItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAcIndex(i => (i - 1 + acItems.length) % acItems.length)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        selectAutocomplete(acItems[acIndex].item)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const selected = acItems[acIndex]

        // Sub-command mode: use enterBehavior from registry
        const sub = matchSubCommand(value)
        if (sub) {
          const [cmd, rest] = sub
          if (cmd.enterBehavior === 'select-or-submit' && rest.trim() === selected.item) {
            handleSubmit()
          } else {
            selectAutocomplete(selected.item)
          }
          return
        }

        // Standard mode: if input matches selected exactly, submit
        const currentCmd = value.startsWith('/')
          ? value.slice(1).trim()
          : value.startsWith('@')
            ? value.slice(1).trim()
            : ''
        if (currentCmd === selected.item) {
          handleSubmit()
        } else if (NO_ARG_COMMANDS.has(selected.item)) {
          // No-arg commands: submit directly to avoid infinite fill-then-match loop
          onChange(`/${selected.item}`)
          requestAnimationFrame(() => handleSubmit())
        } else {
          selectAutocomplete(selected.item)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        onChange('')
        return
      }
    }

    // In expanded (mobile) mode: Enter = newline, no keyboard submit
    // In inline (desktop) mode: Enter = submit, Shift+Enter or Alt+Enter = newline
    if (!expanded && e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      handleSubmit()
    }
    // Escape collapses expanded mode
    if (e.key === 'Escape' && expanded) {
      e.preventDefault()
      setExpanded(false)
    }

    // Readline-style keybindings
    if (e.ctrlKey && ta) {
      const pos = ta.selectionStart
      const v = value

      // Ctrl+U - kill line before cursor
      if (e.key === 'u') {
        e.preventDefault()
        const lineStart = v.lastIndexOf('\n', pos - 1) + 1
        onChange(v.slice(0, lineStart) + v.slice(pos))
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = lineStart
        })
      }
      // Ctrl+W - delete word before cursor
      if (e.key === 'w') {
        e.preventDefault()
        let i = pos - 1
        while (i >= 0 && /\s/.test(v[i])) i--
        while (i >= 0 && !/\s/.test(v[i])) i--
        const wordStart = i + 1
        onChange(v.slice(0, wordStart) + v.slice(pos))
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = wordStart
        })
      }
      // Ctrl+A - move to start of line
      if (e.key === 'a') {
        e.preventDefault()
        const lineStart = v.lastIndexOf('\n', pos - 1) + 1
        ta.selectionStart = ta.selectionEnd = lineStart
      }
      // Ctrl+E - move to end of line
      if (e.key === 'e') {
        e.preventDefault()
        let lineEnd = v.indexOf('\n', pos)
        if (lineEnd === -1) lineEnd = v.length
        ta.selectionStart = ta.selectionEnd = lineEnd
      }
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value)
    // Sync highlight scroll after content change (caret may move)
    requestAnimationFrame(syncScroll)
  }

  function uploadFile(file: File) {
    uploadFileWithPlaceholder(
      file,
      placeholder => {
        const pos = textareaRef.current?.selectionStart ?? value.length
        onChange(value.slice(0, pos) + placeholder + value.slice(pos))
      },
      (search, replacement) => {
        const current = textareaRef.current?.value ?? ''
        onChange(current.replace(search, replacement))
      },
      selectedConversationId ?? undefined,
    )
  }

  // Listen for external file upload requests (e.g. drag-and-drop on transcript area)
  useEffect(() => {
    function handleExternalUpload(e: Event) {
      const file = (e as CustomEvent<File>).detail
      if (file) uploadFile(file)
    }
    window.addEventListener('file-upload-request', handleExternalUpload)
    return () => window.removeEventListener('file-upload-request', handleExternalUpload)
  })

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items
    if (!items) return

    // Check what formats are available
    let hasImage = false
    let imageItem: DataTransferItem | null = null
    let textItem: DataTransferItem | null = null
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        hasImage = true
        imageItem = item
      }
      if (item.type === 'text/plain') textItem = item
    }

    // Both image and text available - check if text is meaningful (not just a filename)
    // macOS puts filenames as text/plain when copying screenshots or files
    if (hasImage && textItem && imageItem) {
      e.preventDefault()
      const file = imageItem.getAsFile()
      if (!file) return
      // Read the text to check if it's worth offering a choice
      const text = await new Promise<string>(resolve => textItem?.getAsString(resolve))
      const trimmed = text.trim()
      const isJustFilename =
        /^[^\n]{1,500}\.(png|jpe?g|gif|webp|svg|bmp|tiff?|ico|heic)$/i.test(trimmed) || /^(\/|~|[A-Z]:\\)/.test(trimmed) // file paths (Unix or Windows)
      if (!trimmed || isJustFilename) {
        // Text is empty or just a filename - upload image directly
        uploadFile(file)
      } else {
        // Genuine text + image - show picker
        setPasteChoice({ file })
      }
      return
    }

    // Only image - upload directly
    if (hasImage && imageItem) {
      e.preventDefault()
      const file = imageItem.getAsFile()
      if (file) uploadFile(file)
      return
    }
    // Text only - let default paste behavior handle it
  }

  function handleDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (!files?.length) return
    for (const file of files) {
      uploadFile(file)
    }
  }

  function handleDragOver(e: React.DragEvent<HTMLTextAreaElement>) {
    e.preventDefault()
    setDragOver(true)
  }

  function handleDragLeave() {
    setDragOver(false)
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files?.length) {
      releaseCompose()
      return
    }
    for (const file of files) {
      uploadFile(file)
    }
    e.target.value = '' // reset so same file can be picked again
    // Don't releaseCompose() here - focus() may silently fail on iOS Safari
    // (file input onChange isn't a trusted user gesture for focus policy).
    // Instead, keep retain alive and let the textarea focus handler reset it.
    // If focus fails, retain count keeps compose open until next interaction.
    textareaRef.current?.focus()
  }

  // When the file picker is dismissed without selecting (cancel), onChange doesn't fire.
  // Window regains focus when picker closes - try to re-focus textarea (resets retain).
  // If focus fails (iOS gesture policy), release retain as fallback.
  useEffect(() => {
    function handleFilePickerDismiss() {
      if (composeRetainRef.current <= 0) return
      composeTimeout(() => {
        textareaRef.current?.focus()
        // If focus succeeded, handleExpandedFocus already reset everything.
        // If it failed, release the retain so compose can eventually collapse.
        if (document.activeElement !== textareaRef.current) {
          releaseCompose()
        }
      }, 300)
    }
    window.addEventListener('focus', handleFilePickerDismiss)
    return () => window.removeEventListener('focus', handleFilePickerDismiss)
  })

  function handleVoiceResult(text: string) {
    // Insert at cursor or append
    const ta = textareaRef.current
    const pos = ta?.selectionStart ?? value.length
    const before = value.slice(0, pos)
    const after = value.slice(pos)
    const spacer = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : ''
    onChange(`${before + spacer}voice-to-text: ${text}${after}`)
    // Focus synchronously - iOS Safari requires focus within the user gesture call stack
    // (rAF/setTimeout break the gesture chain and Safari refuses the focus)
    ta?.focus()
  }

  function handleFocus() {
    if (isMobile && !inline) {
      setExpanded(true)
    }
  }

  function handleSubmit() {
    haptic('tap')
    onSubmit()
    if (expanded) {
      setExpanded(false)
    } else {
      // Re-focus on desktop after submit
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }

  // Hold-to-record: press Send when empty -> hold 300ms -> voice overlay
  // First use: mic permission not yet granted -> fall back to normal tap overlay
  // After permission granted: hold-to-record works (no iOS permission dialog in the way)
  const holdTimerIdRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleSendPointerDown() {
    if (value.trim() || !showVoice) return // only on empty input with voice enabled

    if (!micPermissionRef.current) {
      holdTimerIdRef.current = composeTimeout(() => {
        holdTimerIdRef.current = null
        setHoldToRecord(false)
        setShowVoiceOverlay(true)
      }, 300)
      return
    }

    holdTimerIdRef.current = composeTimeout(() => {
      holdTimerIdRef.current = null
      holdActiveRef.current = true
      setHoldToRecord(true)
      setShowVoiceOverlay(true)
      haptic('double')
    }, 300)
  }

  function handleSendPointerUp() {
    if (holdTimerIdRef.current) {
      clearTimeout(holdTimerIdRef.current)
      composeTimersRef.current.delete(holdTimerIdRef.current)
      holdTimerIdRef.current = null
    }
    if (holdActiveRef.current) {
      holdActiveRef.current = false
    }
  }

  // Clean up all compose timers on unmount
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - runs once on unmount, clearComposeTimers is a stable function defined in this scope
  useEffect(() => {
    return () => clearComposeTimers()
  }, [])

  function handleVoiceClose() {
    setShowVoiceOverlay(false)
    setHoldToRecord(false)
    holdActiveRef.current = false
  }

  function handleVoiceResultAndSubmit(text: string) {
    handleVoiceResult(text)
    // In hold-to-record mode, auto-submit after inserting
    if (holdToRecord) {
      // Need a tick for onChange to propagate
      setTimeout(() => {
        onSubmit()
        setExpanded(false)
        setHoldToRecord(false)
      }, 50)
    }
  }

  function handleCancel() {
    setExpanded(false)
    textareaRef.current?.blur()
  }

  // Retain count: anything that needs the compose overlay to stay open increments this.
  // Blur handler only collapses when retainCount is 0.
  // Examples: toolbar button taps (brief retain during click), file picker (retain until dismissed).
  const composeRetainRef = useRef(0)

  function retainCompose() {
    composeRetainRef.current++
  }

  function releaseCompose() {
    composeRetainRef.current = Math.max(0, composeRetainRef.current - 1)
    if (composeRetainRef.current === 0 && document.activeElement !== textareaRef.current) {
      handleExpandedBlur()
    }
  }

  // Textarea regained focus - hard reset. Clears ALL compose timers and retain count.
  // Self-healing: leaked retains or orphaned timers can't survive a re-focus.
  function handleExpandedFocus() {
    composeRetainRef.current = 0
    clearComposeTimers()
  }

  function handleExpandedBlur() {
    composeTimeout(() => {
      if (composeRetainRef.current > 0) return
      setExpanded(false)
    }, 200)
  }

  const textClasses = expanded
    ? 'font-mono whitespace-pre-wrap break-words' // font-size set via inline style (rem broken by 13px root)
    : 'text-xs font-mono whitespace-pre-wrap break-words'

  // iOS auto-zooms inputs with font-size < 16px. Root is 13px so rem units are broken for this.
  // Use 16px on inline (prevents zoom on focus) and 19px expanded (comfortable typing)
  const expandedFontSize = expanded ? { fontSize: '19px', lineHeight: '1.5' } : { fontSize: '16px', lineHeight: '1.4' }

  // Expanded mobile compose mode
  if (expanded) {
    const composeHeight = viewportHeight ? `${viewportHeight}px` : '100dvh'
    const composeTop = viewportHeight ? 'var(--vv-offset, 0px)' : '0px'

    return createPortal(
      <div
        data-compose-overlay
        className="fixed inset-0 z-[999] flex flex-col bg-background"
        style={{ touchAction: 'manipulation', height: composeHeight, top: composeTop }}
      >
        {/* Hidden file input for attachment */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.toml"
          onChange={handleFileInput}
          className="hidden"
        />
        {/* Editor area */}
        <div className="relative flex-1 min-h-0">
          {/* Highlight layer - must mirror the textarea's gutter so wrap matches. */}
          <div
            ref={highlightRef}
            className={cn(
              'absolute inset-0 px-3 py-3 pointer-events-none overflow-y-auto overflow-x-hidden mi-invisible-scrollbar',
              textClasses,
              'text-foreground',
            )}
            style={expandedFontSize}
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: highlightMarkdown(value, enableEffortKeywords) }}
          />
          {/* Textarea - uses ref callback to auto-focus on mount */}
          <textarea
            ref={expandedTextareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onScroll={syncScroll}
            onFocus={handleExpandedFocus}
            onBlur={handleExpandedBlur}
            disabled={disabled}
            placeholder={placeholder}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={true}
            data-form-type="other"
            className={cn(
              'absolute inset-0 w-full h-full bg-transparent px-3 py-3 resize-none overflow-y-auto overflow-x-hidden mi-invisible-scrollbar',
              textClasses,
              'text-transparent caret-foreground selection:bg-accent/30 selection:text-foreground',
              'focus:outline-none',
              'placeholder:text-muted-foreground',
            )}
            style={expandedFontSize}
          />
        </div>
        {/* Bottom toolbar - thumb-friendly. Retain compose on pointer down, release on pointer up so blur doesn't collapse mid-tap. */}
        <div
          className="shrink-0 flex items-center justify-between px-3 py-2 border-t border-border"
          onPointerDown={retainCompose}
          onPointerUp={releaseCompose}
          onPointerCancel={releaseCompose}
        >
          <button type="button" onClick={handleCancel} className="text-xs text-muted-foreground px-2 py-1">
            Cancel
          </button>
          <div className="flex items-center gap-2">
            {showVoice && (
              <button
                type="button"
                onClick={() => setShowVoiceOverlay(true)}
                className="text-muted-foreground hover:text-accent transition-colors p-1"
                title="Voice input"
                style={{ touchAction: 'manipulation' }}
              >
                <Mic className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                retainCompose()
                fileInputRef.current?.click()
              }}
              className="text-muted-foreground hover:text-accent transition-colors p-1"
              title="Attach file"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={value.trim() ? handleSubmit : undefined}
              onPointerDown={handleSendPointerDown}
              onPointerUp={handleSendPointerUp}
              onPointerCancel={handleSendPointerUp}
              onContextMenu={!value.trim() && showVoice ? e => e.preventDefault() : undefined}
              disabled={disabled}
              className={cn(
                'text-sm font-bold px-4 py-1.5 rounded select-none',
                value.trim() ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground',
              )}
              style={{ touchAction: 'manipulation', WebkitTouchCallout: 'none' } as React.CSSProperties}
            >
              {!value.trim() && showVoice ? 'Hold' : 'Send'}
            </button>
          </div>
        </div>
        {showVoiceOverlay && (
          <VoiceOverlay
            onResult={holdToRecord ? handleVoiceResultAndSubmit : handleVoiceResult}
            onClose={handleVoiceClose}
            holdMode={holdToRecord}
            onMicGranted={() => {
              micPermissionRef.current = true
            }}
          />
        )}
      </div>,
      document.body,
    )
  }

  // Normal inline mode
  return (
    <div ref={containerRef} className={cn('relative grid', className)}>
      {/* Autocomplete dropdown: / commands, @ skills/agents */}
      {acItems.length > 0 && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 right-0 z-30 mb-1 bg-background border border-border rounded shadow-lg max-h-[240px] overflow-y-auto"
        >
          {acItems.map((entry, i) => {
            const trigger = acTrigger || '/'
            return (
              <div
                key={`${trigger}${entry.item}`}
                role="option"
                aria-selected={i === acIndex}
                tabIndex={-1}
                className={cn(
                  'px-3 py-1.5 text-xs font-mono cursor-pointer',
                  i === acIndex
                    ? 'bg-accent/20 text-accent'
                    : entry.builtin
                      ? 'text-amber-400 hover:bg-muted/50'
                      : 'text-foreground hover:bg-muted/50',
                )}
                onClick={() => selectAutocomplete(entry.item)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') selectAutocomplete(entry.item)
                }}
                onMouseEnter={() => setAcIndex(i)}
              >
                {entry.label ? (
                  <span className="truncate">{entry.label}</span>
                ) : (
                  <>
                    <span className={entry.builtin ? 'text-amber-500/60' : 'text-muted-foreground'}>{trigger}</span>
                    {entry.item}
                    {entry.builtin && <span className="text-amber-500/40 ml-2 text-[10px]">built-in</span>}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
      {/* Paste format picker - shown when clipboard has both image and text */}
      {pasteChoice && (
        <div className="absolute -top-9 left-0 right-0 z-20 flex items-center gap-2 px-2 py-1.5 bg-background border border-border rounded-t shadow-lg">
          <span className="text-[10px] text-muted-foreground font-mono">Paste as:</span>
          <button
            type="button"
            className="text-[10px] font-mono px-2 py-0.5 bg-accent/20 hover:bg-accent/40 text-accent rounded"
            onClick={() => {
              haptic('tap')
              uploadFile(pasteChoice.file)
              setPasteChoice(null)
            }}
          >
            Image
          </button>
          <button
            type="button"
            className="text-[10px] font-mono px-2 py-0.5 bg-muted hover:bg-muted/80 text-foreground rounded"
            onClick={() => {
              haptic('tap')
              // Read text from clipboard and insert
              navigator.clipboard.readText().then(text => {
                if (text && textareaRef.current) {
                  const ta = textareaRef.current
                  const start = ta.selectionStart
                  const end = ta.selectionEnd
                  const newVal = value.slice(0, start) + text + value.slice(end)
                  onChange(newVal)
                }
              })
              setPasteChoice(null)
            }}
          >
            Text
          </button>
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-foreground ml-auto"
            onClick={() => setPasteChoice(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {/* Drag-over overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-10 border-2 border-dashed border-accent bg-accent/10 rounded flex items-center justify-center pointer-events-none">
          <span className="text-accent text-xs font-mono">Drop file here</span>
        </div>
      )}
      {/* Highlight layer - renders colored markdown behind textarea.
          Must share overflow + gutter rules with the textarea so wrap points match. */}
      <div
        ref={highlightRef}
        className={cn(
          'absolute inset-0 pl-3 pr-14 py-2 pointer-events-none overflow-y-auto overflow-x-hidden border border-transparent rounded mi-invisible-scrollbar',
          textClasses,
          'text-foreground',
        )}
        style={expandedFontSize}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: highlightMarkdown(value, enableEffortKeywords) }}
      />
      {/* Textarea - transparent text, visible caret */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onScroll={syncScroll}
        disabled={disabled}
        placeholder={placeholder}
        rows={1}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-form-type="other"
        className={cn(
          'relative w-full bg-transparent border border-border rounded pl-3 pr-14 py-2 resize-none overflow-y-auto overflow-x-hidden mi-invisible-scrollbar',
          textClasses,
          'text-transparent caret-foreground selection:bg-accent/30 selection:text-foreground',
          'focus:outline-none focus:border-ring',
          'placeholder:text-muted-foreground',
          'disabled:opacity-50',
        )}
        style={{ minHeight: '2.25rem', ...expandedFontSize }}
      />
      {/* Action buttons */}
      <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
        {showVoice && (
          <button
            type="button"
            onClick={() => setShowVoiceOverlay(true)}
            className="text-muted-foreground hover:text-accent transition-colors p-0.5"
            title="Voice input (tap to record)"
            style={{ touchAction: 'manipulation' }}
          >
            <Mic className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="text-muted-foreground hover:text-accent transition-colors p-0.5"
          title="Attach file (or paste/drop image)"
        >
          <Paperclip className="w-3.5 h-3.5" />
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.toml"
        onChange={handleFileInput}
        className="hidden"
      />
      {showVoiceOverlay && (
        <VoiceOverlay
          onResult={holdToRecord ? handleVoiceResultAndSubmit : handleVoiceResult}
          onClose={handleVoiceClose}
          holdMode={holdToRecord}
          onMicGranted={() => {
            micPermissionRef.current = true
          }}
        />
      )}
    </div>
  )
}
