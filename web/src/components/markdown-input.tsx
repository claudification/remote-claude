import { Mic, Paperclip } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getShowVoiceInput } from '@/components/settings-page'
import { cn, isMobileViewport } from '@/lib/utils'

interface MarkdownInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  placeholder?: string
  className?: string
  autoFocus?: boolean
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
    '<span class="text-cyan-300 font-bold">$1</span><span class="text-cyan-400/70">$3</span><span class="text-cyan-300 font-bold">$4</span>',
  )

  // Inline code (`...`)
  html = html.replace(/(`[^`\n]+`)/g, '<span class="text-cyan-400">$1</span>')

  // Bold (**...**)
  html = html.replace(/(\*\*[^*]+\*\*)/g, '<span class="text-foreground font-bold">$1</span>')

  // Italic (*...* or _..._) - avoid matching ** or __
  html = html.replace(/(?<!\*)(\*[^*\n]+\*)(?!\*)/g, '<span class="text-foreground/70 italic">$1</span>')
  html = html.replace(/(?<!_)(_[^_\n]+_)(?!_)/g, '<span class="text-foreground/70 italic">$1</span>')

  // Headings (# at start of line)
  html = html.replace(/^(#{1,6}\s.*)$/gm, '<span class="text-accent font-bold">$1</span>')

  // Blockquotes (> at start of line)
  html = html.replace(/^(&gt;\s?.*)$/gm, '<span class="text-muted-foreground">$1</span>')

  // List items (- or * at start of line)
  html = html.replace(/^(\s*[-*]\s)/gm, '<span class="text-muted-foreground">$1</span>')

  // Links [text](url)
  html = html.replace(/(\[[^\]]*\]\([^)]*\))/g, '<span class="text-accent underline">$1</span>')

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
}: MarkdownInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isMobile = useIsMobile()

  // Auto-focus on mount (non-mobile only - avoids keyboard popup)
  useEffect(() => {
    if (autoFocus && !isMobile) {
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }, [autoFocus, isMobile])
  const [showVoice, setShowVoice] = useState(getShowVoiceInput)
  useEffect(() => {
    function onPrefsChanged() {
      setShowVoice(getShowVoiceInput())
    }
    window.addEventListener('prefs-changed', onPrefsChanged)
    return () => window.removeEventListener('prefs-changed', onPrefsChanged)
  }, [])

  const [expanded, setExpanded] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])

  // Auto-resize textarea to fit content
  const autoResize = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    // Reset to auto to measure scrollHeight correctly
    textarea.style.height = 'auto'

    if (expanded) {
      // In expanded mode, fill available space (handled by flex)
      textarea.style.height = '100%'
      textarea.style.overflowY = 'auto'
      return
    }

    // Cap at 120px (~5 lines) to prevent layout reflow jerk in transcript above
    const maxHeight = 120
    const newHeight = Math.min(textarea.scrollHeight, maxHeight)
    textarea.style.height = `${newHeight}px`

    // Enable scrolling when capped
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [expanded])

  // Sync scroll between textarea and highlight div
  const syncScroll = useCallback(() => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft
    }
  }, [])

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
  const expandedTextareaRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      if (node) {
        textareaRef.current = node
        node.focus()
      }
    },
    [],
  )

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ta = textareaRef.current
    // In expanded (mobile) mode: Enter = newline, no keyboard submit
    // In inline (desktop) mode: Enter = submit, Shift+Enter = newline
    if (!expanded && e.key === 'Enter' && !e.shiftKey) {
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

    for (const item of items) {
      if (item.type.startsWith('image/') || item.type.startsWith('application/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) uploadFile(file)
        return
      }
    }
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
    if (!files?.length) return
    for (const file of files) {
      uploadFile(file)
    }
    e.target.value = '' // reset so same file can be picked again
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4' // Safari fallback
      const recorder = new MediaRecorder(stream, { mimeType })
      audioChunksRef.current = []

      recorder.ondataavailable = e => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(audioChunksRef.current, { type: mimeType })
        if (blob.size < 1000) return // too short, ignore
        await transcribeAudio(blob, mimeType)
      }

      recorder.start(250) // collect in 250ms chunks
      mediaRecorderRef.current = recorder
      setRecording(true)
    } catch {
      // Permission denied or no mic
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
      mediaRecorderRef.current = null
    }
    setRecording(false)
  }

  function toggleRecording() {
    if (recording) {
      stopRecording()
    } else {
      startRecording()
    }
  }

  async function transcribeAudio(blob: Blob, mimeType: string) {
    setTranscribing(true)
    try {
      // Upload audio to file service
      const ext = mimeType.includes('webm') ? 'webm' : 'mp4'
      const formData = new FormData()
      formData.append('file', blob, `voice.${ext}`)
      const uploadRes = await fetch('/api/files', { method: 'POST', body: formData })
      if (!uploadRes.ok) throw new Error('Upload failed')
      const { url: audioUrl } = await uploadRes.json()

      // Call transcription endpoint with optional context
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl }),
      })
      if (!res.ok) throw new Error('Transcription failed')
      const { refined } = await res.json()

      if (refined?.trim()) {
        // Insert at cursor or append
        const ta = textareaRef.current
        const pos = ta?.selectionStart ?? value.length
        const before = value.slice(0, pos)
        const after = value.slice(pos)
        const spacer = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : ''
        onChange(before + spacer + refined + after)
      }
    } catch {
      // Transcription failed silently
    } finally {
      setTranscribing(false)
    }
  }

  function handleFocus() {
    if (isMobile) {
      setExpanded(true)
    }
  }

  function handleSubmit() {
    onSubmit()
    if (expanded) {
      setExpanded(false)
    } else {
      // Re-focus on desktop after submit
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }

  function handleCancel() {
    setExpanded(false)
    textareaRef.current?.blur()
  }

  const textClasses = expanded
    ? 'font-mono whitespace-pre-wrap break-words' // font-size set via inline style (rem broken by 13px root)
    : 'text-xs font-mono whitespace-pre-wrap break-words'

  // iOS auto-zooms inputs with font-size < 16px. Root is 13px so rem units are broken for this.
  // Use 16px on inline (prevents zoom on focus) and 19px expanded (comfortable typing)
  const expandedFontSize = expanded ? { fontSize: '19px', lineHeight: '1.5' } : { fontSize: '16px' }

  // Expanded mobile compose mode
  if (expanded) {
    const composeHeight = viewportHeight ? `${viewportHeight}px` : '100dvh'
    const composeTop = viewportHeight ? 'var(--vv-offset, 0px)' : '0px'

    return (
      <div
        className="fixed inset-x-0 z-50 flex flex-col bg-background"
        style={{ touchAction: 'manipulation', height: composeHeight, top: composeTop }}
      >
        {/* Header bar */}
        <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border">
          <button type="button" onClick={handleCancel} className="text-xs text-muted-foreground px-2 py-1">
            Cancel
          </button>
          <div className="flex items-center gap-2">
            {showVoice && (
              <button
                type="button"
                onClick={toggleRecording}
                className={cn(
                  'transition-colors p-1',
                  recording
                    ? 'text-red-400 animate-pulse'
                    : transcribing
                      ? 'text-yellow-400 animate-pulse'
                      : 'text-muted-foreground hover:text-accent',
                )}
                title={recording ? 'Stop recording' : transcribing ? 'Transcribing...' : 'Voice input'}
                disabled={transcribing}
                style={{ touchAction: 'manipulation' }}
              >
                <Mic className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-muted-foreground hover:text-accent transition-colors p-1"
              title="Attach file"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={disabled || !value.trim()}
              className={cn(
                'text-sm font-bold px-4 py-1.5 rounded',
                value.trim() ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground',
              )}
            >
              Send
            </button>
          </div>
        </div>
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
            disabled={disabled}
            placeholder={placeholder}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={true}
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
      </div>
    )
  }

  // Normal inline mode
  return (
    <div ref={containerRef} className={cn('relative', className)}>
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
          'absolute inset-0 pl-3 pr-14 py-2 pointer-events-none border border-transparent',
          textClasses,
          'overflow-hidden text-foreground',
        )}
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
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className={cn(
          'relative w-full bg-transparent border border-border rounded pl-3 pr-14 py-2 resize-none',
          textClasses,
          'text-transparent caret-foreground selection:bg-accent/30 selection:text-foreground',
          'focus:outline-none focus:ring-1 focus:ring-ring',
          'placeholder:text-muted-foreground',
          'disabled:opacity-50',
        )}
        style={{ minHeight: '2.25rem' }}
      />
      {/* Action buttons */}
      <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
        {showVoice && (
          <button
            type="button"
            onClick={toggleRecording}
            className={cn(
              'transition-colors p-0.5',
              recording
                ? 'text-red-400 animate-pulse'
                : transcribing
                  ? 'text-yellow-400 animate-pulse'
                  : 'text-muted-foreground hover:text-accent',
            )}
            title={recording ? 'Stop recording' : transcribing ? 'Transcribing...' : 'Voice input (tap to record)'}
            disabled={transcribing}
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
    </div>
  )
}
