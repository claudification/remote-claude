import { useConversationsStore } from '@/hooks/use-conversations'
import { applyTheme, findTheme } from '@/lib/themes'
import { cn, haptic } from '@/lib/utils'

const DARK_IDS = ['tokyo-night', 'dracula', 'nord', 'catppuccin-mocha', 'one-dark', 'gruvbox', 'monochrome']
const LIGHT_IDS = ['github-light', 'claude']
const WILD_IDS = ['claude-dark', 'cyberpunk', 'matrix', 'amber']

function ThemePreview({ variables }: { variables: Record<string, string> }) {
  return (
    <div
      className="w-full h-14 rounded-sm overflow-hidden border border-white/5 relative"
      style={{ background: variables.background }}
    >
      <div className="absolute left-0 top-0 bottom-0 w-4" style={{ background: variables.sidebar }}>
        <div className="mt-1.5 mx-0.5 h-1 rounded-full" style={{ background: variables.primary, opacity: 0.8 }} />
        <div
          className="mt-0.5 mx-0.5 h-1 rounded-full"
          style={{ background: variables['muted-foreground'], opacity: 0.3 }}
        />
        <div className="mt-0.5 mx-0.5 h-1 rounded-full" style={{ background: variables.active, opacity: 0.5 }} />
      </div>
      <div className="absolute left-5 top-1.5 right-1 bottom-1">
        <div className="h-1 w-3/4 rounded-full mb-0.5" style={{ background: variables.foreground, opacity: 0.15 }} />
        <div className="h-1 w-1/2 rounded-full mb-1" style={{ background: variables.foreground, opacity: 0.15 }} />
        <div className="flex gap-0.5 items-center">
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: variables.primary }} />
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: variables.accent }} />
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: variables.active }} />
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: variables.destructive }} />
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: variables['event-prompt'] }} />
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: variables.info }} />
        </div>
      </div>
    </div>
  )
}

function ThemeCard({ themeId, currentTheme, onSelect }: { themeId: string; currentTheme: string; onSelect: (id: string) => void }) {
  const theme = findTheme(themeId)
  return (
    <button
      type="button"
      onClick={() => onSelect(theme.id)}
      className={cn(
        'text-left rounded-sm border p-1.5 transition-all',
        currentTheme === theme.id
          ? 'border-primary ring-1 ring-primary/30'
          : 'border-border/50 hover:border-primary/40',
      )}
    >
      <ThemePreview variables={theme.variables} />
      <div className="mt-1 text-[10px] font-mono font-bold text-center">{theme.name}</div>
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/60 pt-1 pb-0.5">{children}</div>
}

export function ThemeSelector() {
  const currentTheme = useConversationsStore(s => s.controlPanelPrefs.theme) || 'tokyo-night'
  const updatePrefs = useConversationsStore(s => s.updateControlPanelPrefs)

  function selectTheme(id: string) {
    haptic('tap')
    updatePrefs({ theme: id })
    applyTheme(findTheme(id))
  }

  return (
    <div className="space-y-2">
      <SectionLabel>Dark</SectionLabel>
      <div className="grid grid-cols-3 gap-1.5">
        {DARK_IDS.map(id => (
          <ThemeCard key={id} themeId={id} currentTheme={currentTheme} onSelect={selectTheme} />
        ))}
      </div>
      <SectionLabel>Light</SectionLabel>
      <div className="grid grid-cols-3 gap-1.5">
        {LIGHT_IDS.map(id => (
          <ThemeCard key={id} themeId={id} currentTheme={currentTheme} onSelect={selectTheme} />
        ))}
      </div>
      <SectionLabel>Wild</SectionLabel>
      <div className="grid grid-cols-3 gap-1.5">
        {WILD_IDS.map(id => (
          <ThemeCard key={id} themeId={id} currentTheme={currentTheme} onSelect={selectTheme} />
        ))}
      </div>
    </div>
  )
}
