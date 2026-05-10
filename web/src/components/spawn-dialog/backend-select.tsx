import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { haptic } from '@/lib/utils'
import { getBackendIconElement } from '../project-list/backend-icon'

export type BackendKind = 'claude' | 'chat-api' | 'hermes' | 'opencode'

interface BackendOption {
  value: BackendKind
  label: string
  info: string
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
    { value: 'claude', label: 'Claude', info: 'Native Claude Code agent host' },
    {
      value: 'chat-api',
      label: 'Chat',
      info: 'OpenAI / OpenRouter / generic chat-completions',
      setupNeeded: chatAvailable ? undefined : 'no chat connections configured',
    },
    {
      value: 'hermes',
      label: 'Hermes',
      info: 'Bring-your-own gateway',
      setupNeeded: hermesAvailable ? undefined : 'no Hermes gateway connected',
    },
    { value: 'opencode', label: 'OpenCode', info: '75+ providers, free models supported' },
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
            <span className="inline-flex items-center gap-2">
              {getBackendIconElement(opt.value, 13)}
              {opt.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
