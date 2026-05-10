import { Kbd } from '@/components/ui/kbd'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { haptic } from '@/lib/utils'
import { getBackendIconElement } from '../project-list/backend-icon'

export type BackendKind = 'claude' | 'chat-api' | 'hermes' | 'opencode'

interface BackendOption {
  value: BackendKind
  label: string
  info: string
  hotkey: string // alt+N -- discoverable in dropdown, bound in spawn-dialog.tsx
  setupNeeded?: string
}

interface BackendSelectProps {
  value: BackendKind
  onChange: (value: BackendKind) => void
  chatAvailable: boolean
  hermesAvailable: boolean
}

export function BackendSelect({ value, onChange, chatAvailable, hermesAvailable }: BackendSelectProps) {
  const options: BackendOption[] = [
    { value: 'claude', label: 'Claude', info: 'Native Claude Code agent host', hotkey: 'Alt+1' },
    {
      value: 'chat-api',
      label: 'Chat',
      info: 'OpenAI / OpenRouter / generic chat-completions',
      hotkey: 'Alt+2',
      setupNeeded: chatAvailable ? undefined : 'no chat connections configured',
    },
    {
      value: 'hermes',
      label: 'Hermes',
      info: 'Bring-your-own gateway',
      hotkey: 'Alt+3',
      setupNeeded: hermesAvailable ? undefined : 'no Hermes gateway connected',
    },
    { value: 'opencode', label: 'OpenCode', info: '75+ providers, free models supported', hotkey: 'Alt+4' },
  ]

  return (
    <Select
      value={value}
      onValueChange={v => {
        onChange(v as BackendKind)
        haptic('tap')
      }}
    >
      <SelectTrigger size="sm" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(opt => (
          <SelectItem
            key={opt.value}
            value={opt.value}
            disabled={!!opt.setupNeeded}
            info={opt.setupNeeded ? `${opt.info} -- ${opt.setupNeeded}` : opt.info}
          >
            <span className="inline-flex items-center gap-2 w-full">
              {getBackendIconElement(opt.value, 13)}
              <span className="flex-1">{opt.label}</span>
              <Kbd className="ml-auto opacity-70">{opt.hotkey}</Kbd>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
