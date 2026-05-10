import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { findPresetByUrl, PROVIDER_PRESETS, type ProviderPreset } from './chat-provider-presets'

interface ProviderSelectProps {
  selectedUrl: string
  onSelect: (preset: ProviderPreset) => void
}

export function ProviderSelect({ selectedUrl, onSelect }: ProviderSelectProps) {
  const current = findPresetByUrl(selectedUrl)?.id ?? 'custom'

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-mono text-muted-foreground w-12 shrink-0 text-right">Provider</span>
      <Select
        value={current}
        onValueChange={id => {
          const preset = PROVIDER_PRESETS.find(p => p.id === id)
          if (preset) onSelect(preset)
        }}
      >
        <SelectTrigger size="sm" className="flex-1 text-[11px] h-7">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROVIDER_PRESETS.map(p => (
            <SelectItem key={p.id} value={p.id} className="text-[11px] font-mono">
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
