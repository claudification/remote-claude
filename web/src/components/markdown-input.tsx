import { Mic, Paperclip } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { VoiceOverlay } from '@/components/voice-overlay'
import { useSessionsStore } from '@/hooks/use-sessions'
import { cn, haptic, isMobileViewport } from '@/lib/utils'

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
function highlightMarkdown(text: string): string {
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

  // Effort keywords (ultrathink = high effort ●)
  html = html.replace(
    /\b(ultrathink)\b/gi,
    '<span class="text-orange-400 font-bold">$1</span><span class="text-orange-400/60 text-[10px]"> ●</span>',
  )

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
  const voiceCapable = useSessionsStore(state => state.serverCapabilities.voice)
  const showVoicePref = useSessionsStore(state => state.dashboardPrefs.showVoiceInput)
  const showVoice = voiceCapable && showVoicePref

  const [expanded, setExpanded] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [acIndex, setAcIndex] = useState(0) // autocomplete selection index

  // Autocomplete: only activate when value contains / or @ (cheap check before anything else)
  const maybeAutocomplete = value.includes('/') || value.includes('@')

  // Session info for autocomplete data - only subscribe when we might need it
  const sessionInfoData = useSessionsStore(state => {
    if (!maybeAutocomplete) return EMPTY_INFO
    const sid = state.selectedSessionId
    return (sid ? state.sessionInfo[sid] : null) || EMPTY_INFO
  })

  const acItems = useMemo(() => {
    if (!maybeAutocomplete) return []
    // Detect trigger at cursor position
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

    // Get source list
    let source: string[]
    if (ch === '/') source = sessionInfoData.slashCommands || []
    else source = [...(sessionInfoData.skills || []), ...(sessionInfoData.agents || [])]
    if (!source.length) return []

    // Fuzzy match
    const q = query.toLowerCase()
    const scored: Array<{ item: string; score: number }> = []
    for (const item of source) {
      if (!q) {
        scored.push({ item, score: 1 })
        continue
      }
      const c = item.toLowerCase()
      let qi = 0
      let score = 0
      for (let ci = 0; ci < c.length && qi < q.length; ci++) {
        if (c[ci] === q[qi]) {
          score += ci === qi ? 3 : 1
          qi++
        }
      }
      if (qi === q.length) scored.push({ item, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 12).map(x => x.item)
  }, [maybeAutocomplete, value, sessionInfoData])

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
      // In expanded mode, fill available space (handled by flex)
      textarea.style.height = '100%'
      textarea.style.overflowY = 'auto'
      return
    }

    // Cap at 120px (~5 lines) to prevent layout reflow jerk in transcript above
    const maxHeight = 120

    // Measure scrollHeight without causing visible overflow:
    // set overflow hidden first, then reset height, measure, apply
    textarea.style.overflowY = 'hidden'
    textarea.style.height = 'auto'
    const scrollH = textarea.scrollHeight
    const newHeight = Math.min(scrollH, maxHeight)
    textarea.style.height = `${newHeight}px`
    textarea.style.overflowY = scrollH > maxHeight ? 'auto' : 'hidden'

    // Sync highlight layer scroll after resize
    requestAnimationFrame(syncScroll)
  }, [expanded, syncScroll])

  // Resize on value change
  useEffect(() => {
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
    const pos = ta?.selectionStart ?? value.length
    // Find the trigger char (/ or @) that started this token
    let start = pos - 1
    while (start >= 0 && /[a-zA-Z0-9_:-]/.test(value[start])) start--
    const trigger = start >= 0 ? value[start] : null
    if (start >= 0 && (trigger === '/' || trigger === '@')) {
      const before = value.slice(0, start)
      const after = value.slice(pos)
      const replacement = `${trigger}${item} `
      onChange(before + replacement + after)
      setAcIndex(0)
      haptic('tap')
      requestAnimationFrame(() => {
        if (ta) {
          const newPos = before.length + replacement.length
          ta.selectionStart = ta.selectionEnd = newPos
        }
      })
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ta = textareaRef.current

    // Autocomplete navigation
    if (acItems.length > 0) {
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
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        selectAutocomplete(acItems[acIndex])
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

  async function uploadFile(file: File) {
    const ta = textareaRef.current
    const pos = ta?.selectionStart ?? value.length

    const placeholder = `![uploading ${file.name || 'file'}...]`
    const before = value.slice(0, pos)
    const after = value.slice(pos)
    onChange(before + placeholder + after)

    try {
      const formData = new FormData()
      formData.append('file', file, file.name || 'paste.png')
      const res = await fetch('/api/files', { method: 'POST', body: formData })
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
      const { url, filename } = await res.json()

      const mdLink = `![${filename}](${url})`
      // Read current value from textarea (onChange is not a state setter)
      const current = textareaRef.current?.value ?? ''
      onChange(current.replace(placeholder, mdLink))
    } catch {
      const current = textareaRef.current?.value ?? ''
      onChange(current.replace(placeholder, `![upload failed]`))
    }
  }

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
          {/* Highlight layer */}
          <div
            ref={highlightRef}
            className={cn(
              'absolute inset-0 px-3 py-3 pointer-events-none overflow-auto',
              textClasses,
              'text-foreground',
            )}
            style={expandedFontSize}
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: highlightMarkdown(value) }}
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
              'absolute inset-0 w-full h-full bg-transparent px-3 py-3 resize-none',
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
        <div className="absolute bottom-full left-0 right-0 z-30 mb-1 bg-background border border-border rounded shadow-lg max-h-[240px] overflow-y-auto">
          {acItems.map((item, i) => {
            const trigger = acTrigger || '/'
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled in textarea
              <div
                key={`${trigger}${item}`}
                className={cn(
                  'px-3 py-1.5 text-xs font-mono cursor-pointer',
                  i === acIndex ? 'bg-accent/20 text-accent' : 'text-foreground hover:bg-muted/50',
                )}
                onClick={() => selectAutocomplete(item)}
                onMouseEnter={() => setAcIndex(i)}
              >
                <span className="text-muted-foreground">{trigger}</span>
                {item}
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
      {/* Highlight layer - renders colored markdown behind textarea */}
      <div
        ref={highlightRef}
        className={cn(
          'absolute inset-0 pl-3 pr-14 py-2 pointer-events-none overflow-hidden border border-transparent rounded',
          textClasses,
          'text-foreground',
        )}
        style={expandedFontSize}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: highlightMarkdown(value) }}
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
          'relative w-full bg-transparent border border-border rounded pl-3 pr-14 py-2 resize-none',
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
