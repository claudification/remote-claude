import { useState } from 'react'
import { cn, haptic } from '@/lib/utils'
import { Markdown } from '../markdown'

export function SkillDivider({ name, content }: { name: string; content: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="my-3">
      <button
        type="button"
        onClick={() => {
          haptic('tap')
          setExpanded(!expanded)
        }}
        className="flex items-center gap-2 w-full group"
      >
        <div
          className="flex-1 h-px"
          style={{
            backgroundImage:
              'repeating-linear-gradient(90deg, var(--info) 0px, var(--info) 8px, transparent 8px, transparent 16px)',
          }}
        />
        <span className="px-2 py-0.5 text-[10px] font-bold font-mono uppercase tracking-widest text-teal-400/80 bg-teal-400/10 border border-teal-400/30 shrink-0 flex items-center gap-1.5">
          <span className={cn('transition-transform text-[8px]', expanded ? 'rotate-90' : '')}>&#9654;</span>/{name}
        </span>
        <div
          className="flex-1 h-px"
          style={{
            backgroundImage:
              'repeating-linear-gradient(90deg, var(--info) 0px, var(--info) 8px, transparent 8px, transparent 16px)',
          }}
        />
      </button>
      {expanded && (
        <div className="mt-2 px-3 py-2 border border-teal-400/20 bg-teal-400/5 rounded text-xs max-h-[400px] overflow-y-auto">
          <Markdown>{content}</Markdown>
        </div>
      )}
    </div>
  )
}
