import type { Theme } from '@/lib/themes'
import { cn } from '@/lib/utils'

function ColorDot({ color }: { color: string }) {
  return <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
}

function ThemeRow({
  theme,
  active,
  selected,
  onMouseEnter,
  onClick,
}: {
  theme: Theme
  active: boolean
  selected: boolean
  onMouseEnter: () => void
  onClick: () => void
}) {
  const v = theme.variables
  return (
    <button
      type="button"
      className={cn(
        'w-full flex items-center gap-3 px-4 py-2 text-left transition-colors',
        active ? 'bg-primary/20 text-foreground' : 'text-foreground hover:bg-primary/6',
      )}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
    >
      <span className="text-xs font-mono font-bold w-28 truncate">{theme.name}</span>
      <div className="flex gap-1 items-center">
        <ColorDot color={v.background} />
        <ColorDot color={v.primary} />
        <ColorDot color={v.accent} />
        <ColorDot color={v.active} />
        <ColorDot color={v.destructive} />
        <ColorDot color={v['event-prompt']} />
      </div>
      {selected && <span className="ml-auto text-[9px] text-primary font-mono">current</span>}
    </button>
  )
}

export function ThemeResults({
  themes,
  currentThemeId,
  activeIndex,
  setActiveIndex,
  onSelect,
}: {
  themes: readonly Theme[]
  currentThemeId: string
  activeIndex: number
  setActiveIndex: (i: number) => void
  onSelect: (index: number) => void
}) {
  return (
    <div>
      {themes.map((theme, i) => (
        <ThemeRow
          key={theme.id}
          theme={theme}
          active={i === activeIndex}
          selected={theme.id === currentThemeId}
          onMouseEnter={() => setActiveIndex(i)}
          onClick={() => onSelect(i)}
        />
      ))}
    </div>
  )
}
