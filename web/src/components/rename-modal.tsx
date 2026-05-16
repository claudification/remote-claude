import { Pencil } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { focusInputEditor } from '@/lib/focus-input'
import { haptic, isMobileViewport } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Kbd } from './ui/kbd'

export function openRenameModal(name?: string) {
  window.dispatchEvent(new CustomEvent('open-rename-modal', { detail: { name } }))
}

export function RenameModal() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)
  const conversation = useConversationsStore(s =>
    s.selectedConversationId ? s.conversationsById[s.selectedConversationId] : undefined,
  )
  const renameConversation = useConversationsStore(s => s.renameConversation)

  useEffect(() => {
    function handleOpen(e: Event) {
      if (!selectedConversationId) return
      const detail = (e as CustomEvent).detail
      const sess = useConversationsStore.getState().conversationsById[selectedConversationId]
      if (detail?.name) {
        setName(detail.name)
      } else {
        setName(sess?.title || '')
      }
      setDescription(sess?.description || '')
      haptic('tap')
      setOpen(true)
    }
    window.addEventListener('open-rename-modal', handleOpen)
    return () => window.removeEventListener('open-rename-modal', handleOpen)
  }, [selectedConversationId])

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        nameRef.current?.focus()
        nameRef.current?.select()
      })
    }
  }, [open])

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next)
    if (!next) {
      setName('')
      setDescription('')
      if (!isMobileViewport()) requestAnimationFrame(() => focusInputEditor())
    }
  }, [])

  const handleSubmit = useCallback(() => {
    if (!selectedConversationId) return
    renameConversation(selectedConversationId, name.trim(), description.trim() || undefined)
    haptic('success')
    setOpen(false)
  }, [selectedConversationId, name, description, renameConversation])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  if (!selectedConversationId) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md flex flex-col p-0 top-[20vh] translate-y-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <Pencil className="w-4 h-4 text-accent" />
          <DialogTitle className="text-xs">Rename conversation</DialogTitle>
          <span className="text-[10px] text-muted-foreground ml-1 truncate max-w-[200px]">
            {conversation?.title || conversation?.agentName || selectedConversationId.slice(0, 12)}
          </span>
        </div>

        <div className="p-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="rename-name"
              className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider"
            >
              Name
            </label>
            <input
              ref={nameRef}
              id="rename-name"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
              className="w-full bg-muted/50 border border-border text-sm font-mono px-2 py-1.5 outline-none text-foreground focus:border-accent transition-colors"
              placeholder="conversation name"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="rename-desc"
              className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider"
            >
              Description <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <input
              id="rename-desc"
              value={description}
              onChange={e => setDescription(e.target.value)}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
              className="w-full bg-muted/50 border border-border text-sm font-mono px-2 py-1.5 outline-none text-foreground focus:border-accent transition-colors"
              placeholder="short description"
            />
          </div>
        </div>

        <div className="flex items-center justify-between px-3 py-2 border-t border-border shrink-0">
          <span className="text-[10px] text-muted-foreground flex items-center gap-1.5">
            <Kbd>Enter</Kbd> save
            <span className="text-muted-foreground/40">·</span>
            <Kbd>Esc</Kbd> cancel
          </span>
          <button
            type="button"
            onClick={handleSubmit}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
          >
            Save
            <Kbd className="bg-accent/20 text-accent/70">Enter</Kbd>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
