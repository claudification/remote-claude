/**
 * User admin modal: manage users, grants, invites.
 * Gated behind canEditUsers (user-editor server role).
 */

import { Copy, KeyRound, Plus, Shield, ShieldOff, Trash2, UserPlus, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { haptic } from '@/lib/utils'

const API = ''

interface UserSummary {
  name: string
  createdAt: number
  lastUsedAt?: number
  revoked: boolean
  grants: Array<{
    cwd: string
    roles?: string[]
    permissions?: string[]
    notBefore?: number
    notAfter?: number
  }>
  serverRoles?: string[]
  credentialCount: number
  credentials: Array<{
    credentialId: string
    registeredAt: number
    counter: number
    transports?: string[]
  }>
  pushSubscriptionCount: number
}

// ─── Grant Editor ─────────────────────────────────────────────────

const AVAILABLE_PERMISSIONS = [
  'chat',
  'chat:read',
  'terminal',
  'terminal:read',
  'files',
  'files:read',
  'spawn',
  'settings',
  'voice',
  'notifications',
]
const AVAILABLE_ROLES = ['admin']

interface GrantEditorProps {
  grants: UserSummary['grants']
  onChange: (grants: UserSummary['grants']) => void
}

function PermissionToggles({
  roles,
  permissions,
  onToggleRole,
  onTogglePerm,
}: {
  roles: string[]
  permissions: string[]
  onToggleRole: (role: string) => void
  onTogglePerm: (perm: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {AVAILABLE_ROLES.map(r => (
        <button
          key={r}
          type="button"
          onClick={() => onToggleRole(r)}
          className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${
            roles.includes(r)
              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
              : 'bg-secondary text-muted-foreground border border-transparent hover:border-border'
          }`}
        >
          {r}
        </button>
      ))}
      {AVAILABLE_PERMISSIONS.map(p => (
        <button
          key={p}
          type="button"
          onClick={() => onTogglePerm(p)}
          className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
            permissions.includes(p)
              ? 'bg-accent/20 text-accent border border-accent/40'
              : 'bg-secondary text-muted-foreground border border-transparent hover:border-border'
          }`}
        >
          {p}
        </button>
      ))}
    </div>
  )
}

function GrantEditor({ grants, onChange }: GrantEditorProps) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [newCwd, setNewCwd] = useState('')
  const [newPerms, setNewPerms] = useState<string[]>(['chat'])
  const [newRoles, setNewRoles] = useState<string[]>([])

  function addGrant() {
    if (!newCwd.trim()) return
    haptic('tap')
    onChange([
      ...grants,
      {
        cwd: newCwd.trim(),
        ...(newRoles.length > 0 && { roles: newRoles }),
        ...(newPerms.length > 0 && { permissions: newPerms }),
      },
    ])
    setNewCwd('')
    setNewPerms(['chat'])
    setNewRoles([])
  }

  function removeGrant(idx: number) {
    haptic('tick')
    if (editingIdx === idx) setEditingIdx(null)
    onChange(grants.filter((_, i) => i !== idx))
  }

  function updateGrant(idx: number, update: Partial<UserSummary['grants'][0]>) {
    onChange(grants.map((g, i) => (i === idx ? { ...g, ...update } : g)))
  }

  function toggleGrantPerm(idx: number, perm: string) {
    const g = grants[idx]
    const perms = g.permissions || []
    const next = perms.includes(perm) ? perms.filter(p => p !== perm) : [...perms, perm]
    updateGrant(idx, { permissions: next })
  }

  function toggleGrantRole(idx: number, role: string) {
    const g = grants[idx]
    const roles = g.roles || []
    const next = roles.includes(role) ? roles.filter(r => r !== role) : [...roles, role]
    updateGrant(idx, { roles: next })
  }

  return (
    <div className="space-y-3">
      {/* Existing grants - click to edit */}
      {grants.map((g, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: grants may share cwd, positional index needed for disambiguation
        <div key={`${g.cwd}-${i}`} className="bg-secondary/50 rounded text-xs">
          <div
            role="button"
            tabIndex={0}
            className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-secondary/80 transition-colors"
            onClick={() => {
              haptic('tap')
              setEditingIdx(editingIdx === i ? null : i)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                haptic('tap')
                setEditingIdx(editingIdx === i ? null : i)
              }
            }}
          >
            <div className="flex-1 min-w-0">
              <div className="font-mono text-foreground truncate">{g.cwd}</div>
              <div className="text-muted-foreground mt-0.5">
                {[
                  ...(g.roles || []).map(r => (
                    <span key={r} className="text-amber-400">
                      {r}
                    </span>
                  )),
                  ...(g.permissions || []).map(p => <span key={p}>{p}</span>),
                ].reduce<React.ReactNode[]>((acc, el, idx) => {
                  if (idx === 0) return [el]
                  acc.push(', ', el)
                  return acc
                }, [])}
              </div>
              {(g.notBefore || g.notAfter) && (
                <div className="text-muted-foreground/60 mt-0.5">
                  {g.notBefore && `from ${new Date(g.notBefore).toLocaleDateString()}`}
                  {g.notBefore && g.notAfter && ' '}
                  {g.notAfter && `until ${new Date(g.notAfter).toLocaleDateString()}`}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                removeGrant(i)
              }}
              className="text-muted-foreground hover:text-destructive p-1"
            >
              <X className="w-3 h-3" />
            </button>
          </div>

          {/* Expanded edit mode */}
          {editingIdx === i && (
            <div className="px-3 pb-3 pt-1 border-t border-border/50 space-y-2">
              <input
                type="text"
                value={g.cwd}
                onChange={e => updateGrant(i, { cwd: e.target.value })}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-accent"
              />
              <PermissionToggles
                roles={g.roles || []}
                permissions={g.permissions || []}
                onToggleRole={role => toggleGrantRole(i, role)}
                onTogglePerm={perm => toggleGrantPerm(i, perm)}
              />
              <div className="flex gap-2">
                <div className="flex-1">
                  <label htmlFor={`grant-from-${i}`} className="text-[9px] text-muted-foreground uppercase">
                    From
                  </label>
                  <input
                    id={`grant-from-${i}`}
                    type="date"
                    value={g.notBefore ? new Date(g.notBefore).toISOString().split('T')[0] : ''}
                    onChange={e =>
                      updateGrant(i, {
                        notBefore: e.target.value ? new Date(e.target.value).getTime() : undefined,
                      })
                    }
                    className="w-full bg-background border border-border rounded px-2 py-1 text-[10px] font-mono focus:outline-none focus:border-accent"
                  />
                </div>
                <div className="flex-1">
                  <label htmlFor={`grant-until-${i}`} className="text-[9px] text-muted-foreground uppercase">
                    Until
                  </label>
                  <input
                    id={`grant-until-${i}`}
                    type="date"
                    value={g.notAfter ? new Date(g.notAfter).toISOString().split('T')[0] : ''}
                    onChange={e =>
                      updateGrant(i, {
                        notAfter: e.target.value ? new Date(e.target.value).getTime() : undefined,
                      })
                    }
                    className="w-full bg-background border border-border rounded px-2 py-1 text-[10px] font-mono focus:outline-none focus:border-accent"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* Add new grant */}
      <div className="border border-dashed border-border rounded p-3 space-y-2">
        <input
          type="text"
          placeholder="CWD path or * for all"
          value={newCwd}
          onChange={e => setNewCwd(e.target.value)}
          className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-accent"
        />
        <PermissionToggles
          roles={newRoles}
          permissions={newPerms}
          onToggleRole={role =>
            setNewRoles(prev => (prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]))
          }
          onTogglePerm={perm =>
            setNewPerms(prev => (prev.includes(perm) ? prev.filter(p => p !== perm) : [...prev, perm]))
          }
        />
        <Button size="sm" variant="outline" onClick={addGrant} disabled={!newCwd.trim()} className="text-xs h-7">
          <Plus className="w-3 h-3 mr-1" /> Add grant
        </Button>
      </div>
    </div>
  )
}

// ─── Invite Dialog ────────────────────────────────────────────────

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('')
  const [grants, setGrants] = useState<UserSummary['grants']>([])
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  async function handleCreate() {
    if (!name.trim()) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch(`${API}/api/users/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), grants: grants.length > 0 ? grants : undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create invite')
      setInviteUrl(data.inviteUrl)
      haptic('success')
    } catch (err) {
      setError((err as Error).message)
      haptic('error')
    }
    setCreating(false)
  }

  function handleCopy() {
    if (inviteUrl) {
      navigator.clipboard.writeText(inviteUrl)
      haptic('tap')
    }
  }

  function handleClose() {
    setName('')
    setGrants([])
    setInviteUrl(null)
    setError(null)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="text-accent font-bold uppercase tracking-wider text-[10px]">Create Invite</DialogTitle>

        {inviteUrl ? (
          <div className="space-y-3 mt-2">
            <p className="text-xs text-muted-foreground">
              Share this link with <span className="text-foreground font-bold">{name}</span>. One-time use, expires in
              30 minutes.
            </p>
            <div className="flex items-center gap-2 bg-secondary rounded p-2">
              <code className="text-xs flex-1 break-all select-all">{inviteUrl}</code>
              <Button size="sm" variant="ghost" onClick={handleCopy} className="shrink-0">
                <Copy className="w-3 h-3" />
              </Button>
            </div>
            <Button size="sm" onClick={handleClose} className="w-full">
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-4 mt-2">
            <div>
              <label htmlFor="invite-name" className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Name
              </label>
              <input
                id="invite-name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. lisa"
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm font-mono mt-1 focus:outline-none focus:border-accent"
                autoFocus
              />
            </div>

            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Grants</div>
              <p className="text-[10px] text-muted-foreground/60 mb-2">Leave empty for admin access.</p>
              <GrantEditor grants={grants} onChange={setGrants} />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={handleClose} className="flex-1">
                Cancel
              </Button>
              <Button size="sm" onClick={handleCreate} disabled={!name.trim() || creating} className="flex-1">
                <UserPlus className="w-3 h-3 mr-1" />
                {creating ? 'Creating...' : 'Create invite'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ─── User Edit Panel ──────────────────────────────────────────────

function UserEditPanel({ user, onSave, onClose }: { user: UserSummary; onSave: () => void; onClose: () => void }) {
  const [grants, setGrants] = useState(user.grants)
  const [serverRoles, setServerRoles] = useState<string[]>(user.serverRoles || [])
  const [saving, setSaving] = useState(false)
  const [deletingCredential, setDeletingCredential] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  async function handleDeleteCredential(credentialId: string) {
    setDeletingCredential(credentialId)
    try {
      const res = await fetch(
        `${API}/api/users/${encodeURIComponent(user.name)}/credentials/${encodeURIComponent(credentialId)}`,
        { method: 'DELETE' },
      )
      const data = await res.json()
      if (!res.ok) {
        console.error('Delete passkey failed:', data.error)
        haptic('error')
      } else {
        haptic('success')
        onSave()
      }
    } catch {
      haptic('error')
    }
    setDeletingCredential(null)
    setConfirmDelete(null)
  }

  async function handleSave() {
    setSaving(true)
    await fetch(`${API}/api/users/${encodeURIComponent(user.name)}/grants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grants }),
    })
    await fetch(`${API}/api/users/${encodeURIComponent(user.name)}/server-roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverRoles }),
    })
    setSaving(false)
    haptic('success')
    onSave()
  }

  async function handleRevoke() {
    haptic('error')
    await fetch(`${API}/api/users/${encodeURIComponent(user.name)}/${user.revoked ? 'unrevoke' : 'revoke'}`, {
      method: 'POST',
    })
    onSave()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-foreground">{user.name}</h3>
          <p className="text-[10px] text-muted-foreground">
            {user.credentialCount} passkey{user.credentialCount !== 1 ? 's' : ''}
            {user.pushSubscriptionCount > 0 &&
              ` / ${user.pushSubscriptionCount} push device${user.pushSubscriptionCount !== 1 ? 's' : ''}`}
            {user.lastUsedAt && ` / last seen ${new Date(user.lastUsedAt).toLocaleDateString()}`}
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Server roles */}
      <div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Server Roles</div>
        <div className="flex gap-1 mt-1">
          <button
            type="button"
            onClick={() =>
              setServerRoles(prev =>
                prev.includes('user-editor') ? prev.filter(r => r !== 'user-editor') : [...prev, 'user-editor'],
              )
            }
            className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${
              serverRoles.includes('user-editor')
                ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                : 'bg-secondary text-muted-foreground border border-transparent hover:border-border'
            }`}
          >
            user-editor
          </button>
        </div>
      </div>

      {/* Passkeys */}
      <div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
          Passkeys ({user.credentials.length})
        </div>
        <div className="mt-1 space-y-1.5">
          {user.credentials.map(cred => (
            <div
              key={cred.credentialId}
              className="flex items-center gap-2 bg-secondary/50 rounded px-3 py-2 text-xs group"
            >
              <KeyRound className="w-3 h-3 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-foreground/80 truncate text-[10px]">
                  {cred.credentialId.slice(0, 24)}...
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {new Date(cred.registeredAt).toLocaleDateString()}
                  {cred.transports?.length ? ` / ${cred.transports.join(', ')}` : ''}
                  {cred.counter > 0 && ` / ${cred.counter} uses`}
                </div>
              </div>
              {confirmDelete === cred.credentialId ? (
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-destructive">Kill sessions?</span>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="text-[10px] h-5 px-2"
                    disabled={deletingCredential === cred.credentialId}
                    onClick={() => handleDeleteCredential(cred.credentialId)}
                  >
                    {deletingCredential === cred.credentialId ? '...' : 'Yes'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-[10px] h-5 px-2"
                    onClick={() => setConfirmDelete(null)}
                  >
                    No
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    haptic('tick')
                    setConfirmDelete(cred.credentialId)
                  }}
                  className="text-muted-foreground/40 hover:text-destructive p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete passkey"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Grants */}
      <div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Grants</div>
        <div className="mt-1">
          <GrantEditor grants={grants} onChange={setGrants} />
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-2 border-t border-border">
        <Button size="sm" variant={user.revoked ? 'outline' : 'destructive'} onClick={handleRevoke} className="text-xs">
          {user.revoked ? (
            <>
              <Shield className="w-3 h-3 mr-1" /> Restore
            </>
          ) : (
            <>
              <ShieldOff className="w-3 h-3 mr-1" /> Revoke
            </>
          )}
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={onClose} className="text-xs">
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving} className="text-xs">
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

// ─── Main Modal ───────────────────────────────────────────────────

export function UserAdminDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [users, setUsers] = useState<UserSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [editingUser, setEditingUser] = useState<string | null>(null)
  const [showInvite, setShowInvite] = useState(false)

  const loadUsers = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API}/api/users`)
      if (res.ok) {
        const data = await res.json()
        setUsers(data.users)
      }
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    if (open) loadUsers()
  }, [open, loadUsers])

  const editUser = users.find(u => u.name === editingUser)

  return (
    <>
      <Dialog open={open && !showInvite} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg max-h-[80vh] p-0">
          <div className="flex items-center justify-between px-6 pt-5 pb-3 pr-12">
            <DialogTitle className="text-accent font-bold uppercase tracking-wider text-[10px]">Users</DialogTitle>
            <Button size="sm" variant="outline" onClick={() => setShowInvite(true)} className="text-xs h-7">
              <UserPlus className="w-3 h-3 mr-1" /> Invite
            </Button>
          </div>
          <div className="px-6 pb-6 overflow-y-auto">
            {editUser ? (
              <UserEditPanel
                user={editUser}
                onSave={() => {
                  setEditingUser(null)
                  loadUsers()
                }}
                onClose={() => setEditingUser(null)}
              />
            ) : loading ? (
              <p className="text-xs text-muted-foreground text-center py-4">Loading...</p>
            ) : (
              <div className="space-y-2">
                {users.map(user => (
                  <div
                    key={user.name}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      haptic('tap')
                      setEditingUser(user.name)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        haptic('tap')
                        setEditingUser(user.name)
                      }
                    }}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-secondary/50 hover:bg-secondary transition-colors cursor-pointer"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-foreground">{user.name}</span>
                        {user.revoked && (
                          <span className="px-1.5 py-0.5 text-[9px] font-bold bg-destructive/20 text-destructive rounded">
                            REVOKED
                          </span>
                        )}
                        {user.serverRoles?.includes('user-editor') && (
                          <span className="px-1.5 py-0.5 text-[9px] font-bold bg-violet-500/20 text-violet-400 rounded">
                            editor
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {user.grants
                          .map(g => {
                            const parts = [...(g.roles || []), ...(g.permissions || [])]
                            const cwdLabel = g.cwd === '*' ? 'all' : g.cwd.split('/').pop()
                            return `${cwdLabel}: ${parts.join(', ')}`
                          })
                          .join(' / ')}
                      </div>
                    </div>
                    <div className="text-muted-foreground/40 text-[10px] shrink-0">
                      {user.credentialCount} key{user.credentialCount !== 1 ? 's' : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <InviteDialog
        open={showInvite}
        onClose={() => {
          setShowInvite(false)
          loadUsers()
        }}
      />
    </>
  )
}
