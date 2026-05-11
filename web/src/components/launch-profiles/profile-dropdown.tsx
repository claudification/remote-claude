import type { LaunchProfile } from '@shared/launch-profile'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatShortcut } from '@/lib/commands'

export const CUSTOM_VALUE = '__custom__'
export const MANAGE_VALUE = '__manage__'
export const NEW_VALUE = '__new__'

interface Props {
  selectedId: string | undefined
  profiles: LaunchProfile[]
  onSelectProfile: (id: string) => void
  onPickCustom: () => void
  onManage: () => void
  onCreate: () => void
}

export function ProfileDropdown({ selectedId, profiles, onSelectProfile, onPickCustom, onManage, onCreate }: Props) {
  const current = selectedId && profiles.some(p => p.id === selectedId) ? selectedId : CUSTOM_VALUE

  function handleChange(value: string) {
    if (value === CUSTOM_VALUE) return onPickCustom()
    if (value === MANAGE_VALUE) return onManage()
    if (value === NEW_VALUE) return onCreate()
    onSelectProfile(value)
  }

  return (
    <Select value={current} onValueChange={handleChange}>
      <SelectTrigger size="sm" className="w-[260px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={CUSTOM_VALUE} info="No profile applied -- configure the form by hand">
            Custom
          </SelectItem>
        </SelectGroup>
        {profiles.length > 0 && (
          <SelectGroup>
            <SelectSeparator />
            <SelectLabel>Profiles</SelectLabel>
            {profiles.map(p => (
              <SelectItem key={p.id} value={p.id} info={p.chord ? formatShortcut(`mod+j ${p.chord}`) : undefined}>
                {p.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        <SelectGroup>
          <SelectSeparator />
          <SelectLabel>Actions</SelectLabel>
          <SelectItem value={NEW_VALUE}>+ New profile...</SelectItem>
          <SelectItem value={MANAGE_VALUE}>Manage profiles...</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
