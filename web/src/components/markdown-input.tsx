import { Mic, Paperclip } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { VoiceOverlay } from '@/components/voice-overlay'
import { useConversationsStore } from '@/hooks/use-conversations'
import { uploadFileWithPlaceholder } from '@/lib/upload'
import { cn, haptic } from '@/lib/utils'
import { useIsMobile } from './input-editor/shell/use-is-mobile'
import { useScrollLock } from './input-editor/shell/use-scroll-lock'
import { AutocompleteDropdown } from './markdown-input/autocomplete-dropdown'
import { ExpandedCompose } from './markdown-input/expanded-compose'
import { handleKeyDown as handleKeyDownImpl } from './markdown-input/handle-key-down'
import { highlightMarkdown } from './markdown-input/highlight-markdown'
import { PasteChoicePicker } from './markdown-input/paste-choice-picker'
import { useAutocomplete } from './markdown-input/use-autocomplete'
import { useComposeOverlay } from './markdown-input/use-compose-overlay'
import { useComposeTimers } from './markdown-input/use-compose-timers'
import { useVoiceInput } from './markdown-input/use-voice-input'

interface MarkdownInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  placeholder?: string
  className?: string
  autoFocus?: boolean
  inline?: boolean
  enableAutocomplete?: boolean
  enableEffortKeywords?: boolean
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

  useEffect(() => {
    if (autoFocus && (inline || !isMobile)) {
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }, [autoFocus, isMobile, inline])

  const voiceCapable = useConversationsStore(state => state.serverCapabilities.voice)
  const showVoicePref = useConversationsStore(state => state.controlPanelPrefs.showVoiceInput)
  const showVoice = voiceCapable && showVoicePref
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)

  const [expanded, setExpanded] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [pasteChoice, setPasteChoice] = useState<{ file: File } | null>(null)

  const { composeTimersRef, composeTimeout, clearComposeTimers } = useComposeTimers()
  const { acItems, acIndex, setAcIndex, acTrigger, selectAutocomplete } = useAutocomplete(
    value,
    enableAutocomplete,
    textareaRef,
  )
  const { visibleHeight: viewportHeight } = useScrollLock(expanded)
  const { composeRetainRef, retainCompose, releaseCompose, handleExpandedFocus, handleExpandedBlur } =
    useComposeOverlay({ textareaRef, setExpanded, composeTimeout, clearComposeTimers })
  const {
    showVoiceOverlay,
    holdToRecord,
    setShowVoiceOverlay,
    micPermissionRef,
    handleVoiceResult,
    handleVoiceResultAndSubmit,
    handleVoiceClose,
    handleSendPointerDown,
    handleSendPointerUp,
  } = useVoiceInput({
    value,
    onChange,
    onSubmit,
    showVoice,
    textareaRef,
    setExpanded,
    composeTimeout,
    composeTimersRef,
  })

  // --- Scroll + resize ---

  const syncScroll = useCallback(() => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft
    }
  }, [])

  const autoResize = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    if (expanded) {
      textarea.style.height = '100%'
      return
    }
    const maxHeight = 120
    textarea.style.height = 'auto'
    const scrollH = textarea.scrollHeight
    textarea.style.height = `${Math.min(scrollH, maxHeight)}px`
    requestAnimationFrame(syncScroll)
  }, [expanded, syncScroll])

  // biome-ignore lint/correctness/useExhaustiveDependencies: value used as dep key to trigger resize when content changes; autoResize handles the actual reading
  useLayoutEffect(() => {
    autoResize()
  }, [value, autoResize])

  useEffect(() => {
    window.addEventListener('resize', autoResize)
    return () => window.removeEventListener('resize', autoResize)
  }, [autoResize])

  const expandedTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    if (node) {
      textareaRef.current = node
      node.focus()
    }
  }, [])

  // --- File upload ---

  function uploadFile(file: File) {
    uploadFileWithPlaceholder(
      file,
      ph => {
        const pos = textareaRef.current?.selectionStart ?? value.length
        onChange(value.slice(0, pos) + ph + value.slice(pos))
      },
      (search, replacement) => {
        const current = textareaRef.current?.value ?? ''
        onChange(current.replace(search, replacement))
      },
      selectedConversationId ?? undefined,
    )
  }

  useEffect(() => {
    function handleExternalUpload(e: Event) {
      const file = (e as CustomEvent<File>).detail
      if (file) uploadFile(file)
    }
    window.addEventListener('file-upload-request', handleExternalUpload)
    return () => window.removeEventListener('file-upload-request', handleExternalUpload)
  })

  // --- Paste ---

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items
    if (!items) return
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
    if (hasImage && textItem && imageItem) {
      e.preventDefault()
      const file = imageItem.getAsFile()
      if (!file) return
      const text = await new Promise<string>(resolve => textItem?.getAsString(resolve))
      const trimmed = text.trim()
      const isJustFilename =
        /^[^\n]{1,500}\.(png|jpe?g|gif|webp|svg|bmp|tiff?|ico|heic)$/i.test(trimmed) || /^(\/|~|[A-Z]:\\)/.test(trimmed)
      if (!trimmed || isJustFilename) {
        uploadFile(file)
      } else {
        setPasteChoice({ file })
      }
      return
    }
    if (hasImage && imageItem) {
      e.preventDefault()
      const file = imageItem.getAsFile()
      if (file) uploadFile(file)
    }
  }

  // --- Drag & drop ---

  function handleDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (!files?.length) return
    for (const file of files) uploadFile(file)
  }

  function handleDragOver(e: React.DragEvent<HTMLTextAreaElement>) {
    e.preventDefault()
    setDragOver(true)
  }

  function handleDragLeave() {
    setDragOver(false)
  }

  // --- File input ---

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files?.length) {
      releaseCompose()
      return
    }
    for (const file of files) uploadFile(file)
    e.target.value = ''
    textareaRef.current?.focus()
  }

  useEffect(() => {
    function handleFilePickerDismiss() {
      if (composeRetainRef.current <= 0) return
      composeTimeout(() => {
        textareaRef.current?.focus()
        if (document.activeElement !== textareaRef.current) releaseCompose()
      }, 300)
    }
    window.addEventListener('focus', handleFilePickerDismiss)
    return () => window.removeEventListener('focus', handleFilePickerDismiss)
  })

  // --- Submit / focus / cancel ---

  function handleSubmit() {
    haptic('tap')
    onSubmit()
    if (expanded) {
      setExpanded(false)
    } else {
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }

  function handleFocus() {
    if (isMobile && !inline) setExpanded(true)
  }

  function handleCancel() {
    setExpanded(false)
    textareaRef.current?.blur()
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value)
    requestAnimationFrame(syncScroll)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    handleKeyDownImpl(e, {
      value,
      onChange,
      expanded,
      setExpanded,
      acItems,
      acIndex,
      setAcIndex,
      selectAutocomplete,
      textareaRef,
      handleSubmit,
    })
  }

  // --- Style helpers ---

  const textClasses = expanded
    ? 'font-mono whitespace-pre-wrap break-words'
    : 'text-xs font-mono whitespace-pre-wrap break-words'

  const expandedFontSize = expanded ? { fontSize: '19px', lineHeight: '1.5' } : { fontSize: '16px', lineHeight: '1.4' }

  // --- Expanded (mobile compose) ---

  if (expanded) {
    return (
      <ExpandedCompose
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        enableEffortKeywords={enableEffortKeywords}
        showVoice={showVoice}
        showVoiceOverlay={showVoiceOverlay}
        holdToRecord={holdToRecord}
        viewportHeight={viewportHeight}
        textClasses={textClasses}
        expandedFontSize={expandedFontSize}
        expandedTextareaRef={expandedTextareaRef}
        fileInputRef={fileInputRef}
        highlightRef={highlightRef}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onScroll={syncScroll}
        onExpandedFocus={handleExpandedFocus}
        onExpandedBlur={handleExpandedBlur}
        onFileInput={handleFileInput}
        onCancel={handleCancel}
        onSubmit={handleSubmit}
        onVoiceOpen={() => setShowVoiceOverlay(true)}
        onVoiceClose={handleVoiceClose}
        onVoiceResult={holdToRecord ? handleVoiceResultAndSubmit : handleVoiceResult}
        onMicGranted={() => {
          micPermissionRef.current = true
        }}
        onSendPointerDown={handleSendPointerDown}
        onSendPointerUp={handleSendPointerUp}
        onRetainCompose={retainCompose}
        onReleaseCompose={releaseCompose}
        onAttachClick={() => {
          retainCompose()
          fileInputRef.current?.click()
        }}
      />
    )
  }

  // --- Normal inline mode ---

  return (
    <div ref={containerRef} className={cn('relative grid', className)}>
      <AutocompleteDropdown
        items={acItems}
        selectedIndex={acIndex}
        trigger={acTrigger}
        onSelect={item => selectAutocomplete(item, textareaRef, value, onChange)}
        onHover={setAcIndex}
      />
      {pasteChoice && (
        <PasteChoicePicker
          file={pasteChoice.file}
          value={value}
          textareaRef={textareaRef}
          onChange={onChange}
          onUploadFile={uploadFile}
          onDismiss={() => setPasteChoice(null)}
        />
      )}
      {dragOver && (
        <div className="absolute inset-0 z-10 border-2 border-dashed border-accent bg-accent/10 rounded flex items-center justify-center pointer-events-none">
          <span className="text-accent text-xs font-mono">Drop file here</span>
        </div>
      )}
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
