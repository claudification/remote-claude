import type { LaunchProfile } from '@shared/launch-profile'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { blankProfile, findDuplicateChord, findDuplicateName, findProfile, removeProfile, replaceProfile } from './draft'
import { ManagerEditor } from './manager-editor'
import { ManagerList } from './manager-list'
import { closeLaunchProfileManager, useLaunchProfileManagerState } from './manager-state'
import { useLaunchProfiles } from './use-launch-profiles'

export function LaunchProfileManager() {
  const { open, focusId } = useLaunchProfileManagerState()
  const { profiles, save } = useLaunchProfiles()
  const [draft, setDraft] = useState<LaunchProfile[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) {
      setDraft(null)
      setSelectedId(undefined)
      setError(undefined)
      return
    }
    const initial = profiles.slice()
    if (focusId === 'new') {
      const created = blankProfile()
      setDraft([...initial, created])
      setSelectedId(created.id)
    } else {
      setDraft(initial)
      setSelectedId(focusId ?? initial[0]?.id)
    }
  }, [open, focusId, profiles])

  const list = draft ?? []
  const selected = useMemo(() => findProfile(list, selectedId), [list, selectedId])
  const validationError = useMemo(() => {
    const dupName = findDuplicateName(list)
    if (dupName) return `Duplicate profile name: ${dupName}`
    const dupChord = findDuplicateChord(list)
    if (dupChord) return `Duplicate chord: Cmd+J ${dupChord.toUpperCase()}`
    return undefined
  }, [list])

  const handleCreate = useCallback(() => {
    const created = blankProfile()
    setDraft(current => (current ? [...current, created] : [created]))
    setSelectedId(created.id)
  }, [])

  const handleChange = useCallback((next: LaunchProfile) => {
    setDraft(current => (current ? replaceProfile(current, next) : [next]))
  }, [])

  const handleDelete = useCallback(
    (id: string) => {
      setDraft(current => (current ? removeProfile(current, id) : []))
      setSelectedId(id === selectedId ? undefined : selectedId)
    },
    [selectedId],
  )

  const handleSave = useCallback(async () => {
    if (!draft) return
    setSaving(true)
    setError(undefined)
    const res = await save(draft)
    setSaving(false)
    if (!res.ok) {
      setError(res.error ?? 'Save failed')
      return
    }
    closeLaunchProfileManager()
  }, [draft, save])

  return (
    <Dialog open={open} onOpenChange={v => !v && closeLaunchProfileManager()}>
      <DialogContent className="!max-w-5xl w-[92vw] h-[80vh] flex flex-col">
        <header className="px-4 pt-3 pb-2 border-b border-border flex items-center justify-between">
          <DialogTitle>Launch Profiles</DialogTitle>
          {(error || validationError) && (
            <span className="text-xs text-destructive font-mono truncate max-w-md">{error ?? validationError}</span>
          )}
        </header>
        <div className="flex-1 flex min-h-0">
          <ManagerList profiles={list} selectedId={selectedId} onSelect={setSelectedId} onCreate={handleCreate} />
          <div className="flex-1 flex flex-col min-w-0">
            {selected ? (
              <ManagerEditor profile={selected} onChange={handleChange} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
                Select a profile to edit, or create a new one.
              </div>
            )}
          </div>
        </div>
        <footer className="px-4 py-2 border-t border-border flex items-center justify-between gap-3">
          {selected ? (
            <button
              type="button"
              onClick={() => handleDelete(selected.id)}
              className="text-xs text-destructive hover:underline"
            >
              Delete profile
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => closeLaunchProfileManager()}
              className="text-xs px-3 py-1 text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !!validationError}
              title={validationError}
              className="text-xs px-3 py-1 bg-primary text-background font-bold disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
