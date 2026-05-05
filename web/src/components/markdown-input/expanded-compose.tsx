import { Mic, Paperclip } from 'lucide-react'
import type React from 'react'
import { createPortal } from 'react-dom'
import { VoiceOverlay } from '@/components/voice-overlay'
import { cn } from '@/lib/utils'
import { highlightMarkdown } from './highlight-markdown'

interface ExpandedComposeProps {
  value: string
  disabled?: boolean
  placeholder?: string
  enableEffortKeywords: boolean
  showVoice: boolean
  showVoiceOverlay: boolean
  holdToRecord: boolean
  viewportHeight: number | null
  textClasses: string
  expandedFontSize: React.CSSProperties
  expandedTextareaRef: (node: HTMLTextAreaElement | null) => void
  fileInputRef: React.RefObject<HTMLInputElement | null>
  highlightRef: React.RefObject<HTMLDivElement | null>
  onInput: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  onDrop: (e: React.DragEvent<HTMLTextAreaElement>) => void
  onDragOver: (e: React.DragEvent<HTMLTextAreaElement>) => void
  onScroll: () => void
  onExpandedFocus: () => void
  onExpandedBlur: () => void
  onFileInput: (e: React.ChangeEvent<HTMLInputElement>) => void
  onCancel: () => void
  onSubmit: () => void
  onVoiceOpen: () => void
  onVoiceClose: () => void
  onVoiceResult: (text: string) => void
  onMicGranted: () => void
  onSendPointerDown: () => void
  onSendPointerUp: () => void
  onRetainCompose: () => void
  onReleaseCompose: () => void
  onAttachClick: () => void
}

export function ExpandedCompose({
  value,
  disabled,
  placeholder,
  enableEffortKeywords,
  showVoice,
  showVoiceOverlay,
  holdToRecord,
  viewportHeight,
  textClasses,
  expandedFontSize,
  expandedTextareaRef,
  fileInputRef,
  highlightRef,
  onInput,
  onKeyDown,
  onPaste,
  onDrop,
  onDragOver,
  onScroll,
  onExpandedFocus,
  onExpandedBlur,
  onFileInput,
  onCancel,
  onSubmit,
  onVoiceOpen,
  onVoiceClose,
  onVoiceResult,
  onMicGranted,
  onSendPointerDown,
  onSendPointerUp,
  onRetainCompose,
  onReleaseCompose,
  onAttachClick,
}: ExpandedComposeProps) {
  const composeHeight = viewportHeight ? `${viewportHeight}px` : '100dvh'
  const composeTop = viewportHeight ? 'var(--vv-offset, 0px)' : '0px'

  return createPortal(
    <div
      data-compose-overlay
      className="fixed inset-0 z-[999] flex flex-col bg-background"
      style={{ touchAction: 'manipulation', height: composeHeight, top: composeTop }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.toml"
        onChange={onFileInput}
        className="hidden"
      />
      <div className="relative flex-1 min-h-0">
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
        <textarea
          ref={expandedTextareaRef}
          value={value}
          onChange={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onScroll={onScroll}
          onFocus={onExpandedFocus}
          onBlur={onExpandedBlur}
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
      <div
        className="shrink-0 flex items-center justify-between px-3 py-2 border-t border-border"
        onPointerDown={onRetainCompose}
        onPointerUp={onReleaseCompose}
        onPointerCancel={onReleaseCompose}
      >
        <button type="button" onClick={onCancel} className="text-xs text-muted-foreground px-2 py-1">
          Cancel
        </button>
        <div className="flex items-center gap-2">
          {showVoice && (
            <button
              type="button"
              onClick={onVoiceOpen}
              className="text-muted-foreground hover:text-accent transition-colors p-1"
              title="Voice input"
              style={{ touchAction: 'manipulation' }}
            >
              <Mic className="w-4 h-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onAttachClick}
            className="text-muted-foreground hover:text-accent transition-colors p-1"
            title="Attach file"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={value.trim() ? onSubmit : undefined}
            onPointerDown={onSendPointerDown}
            onPointerUp={onSendPointerUp}
            onPointerCancel={onSendPointerUp}
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
          onResult={onVoiceResult}
          onClose={onVoiceClose}
          holdMode={holdToRecord}
          onMicGranted={onMicGranted}
        />
      )}
    </div>,
    document.body,
  )
}
