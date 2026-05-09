import { Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Session } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'

export function HeaderDescription({ session }: { session: Session }) {
  const isEditing = useConversationsStore(s => s.editingDescriptionConversationId === session.id)
  const setEditing = useConversationsStore(s => s.setEditingDescriptionConversationId)
  const updateDescription = useConversationsStore(s => s.updateDescription)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(session.description || '')

  useEffect(() => {
    if (isEditing) {
      setValue(session.description || '')
      const t = setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
      return () => clearTimeout(t)
    }
  }, [isEditing, session.description])

  function submit() {
    updateDescription(session.id, value.trim())
    haptic('success')
  }

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') setEditing(null)
        }}
        onBlur={submit}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        className="w-full bg-background/80 border border-accent/50 text-[10px] font-mono px-1.5 py-0.5 outline-none text-muted-foreground italic"
        placeholder="conversation description"
      />
    )
  }

  return (
    <div
      className="group/desc flex items-center gap-1 cursor-pointer"
      role="button"
      tabIndex={0}
      onClick={() => setEditing(session.id)}
      onKeyDown={e => e.key === 'Enter' && setEditing(session.id)}
    >
      <span
        className={cn(
          'text-[10px] truncate',
          session.description ? 'text-muted-foreground/70 italic' : 'text-muted-foreground/30 italic',
        )}
      >
        {session.description || 'add description...'}
      </span>
      <Pencil className="w-2.5 h-2.5 text-muted-foreground/20 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/desc:opacity-100 transition-opacity" />
    </div>
  )
}
