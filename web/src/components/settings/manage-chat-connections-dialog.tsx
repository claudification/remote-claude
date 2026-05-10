import { useCallback, useEffect, useState } from 'react'
import { DropdownMenu } from 'radix-ui'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn, haptic } from '@/lib/utils'
import type { ChatApiConnection } from '../../../../src/shared/chat-api-types'
import type { ProviderPreset } from './chat-provider-presets'
import { ModelPicker } from './model-picker'
import { ProviderSelect } from './provider-select'
import { SafeCodeMirror } from '@/components/codemirror/safe-codemirror'
import { buildFileEditorExtensions } from '@/components/codemirror-setup'

const API_BASE = `${window.location.protocol}//${window.location.host}/api`

let _openManageChatConnections: (() => void) | null = null

export function openManageChatConnections(): void {
  _openManageChatConnections?.()
}

type View = 'list' | 'add' | 'edit'

interface FormState {
  name: string
  url: string
  apiKey: string
  model: string
}

const emptyForm: FormState = { name: '', url: '', apiKey: '', model: '' }

function formToYaml(form: FormState): string {
  const lines = [`name: ${form.name}`, `url: ${form.url}`, `apiKey: ${form.apiKey}`]
  if (form.model) lines.push(`model: ${form.model}`)
  return lines.join('\n')
}

function yamlToForm(yaml: string): FormState | string {
  const result: Record<string, string> = {}
  for (const line of yaml.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf(':')
    if (idx === -1) return `Invalid line: ${trimmed}`
    const key = trimmed.slice(0, idx).trim()
    const val = trimmed.slice(idx + 1).trim()
    if (!['name', 'url', 'apiKey', 'model'].includes(key)) return `Unknown field: ${key}`
    result[key] = val
  }
  return {
    name: result.name || '',
    url: result.url || '',
    apiKey: result.apiKey || '',
    model: result.model || '',
  }
}

const menuContentClass =
  'min-w-[120px] bg-popover border border-border rounded-lg shadow-xl py-1 z-[100] animate-in fade-in zoom-in-95 duration-100'
const menuItemClass =
  'px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'
const menuItemDestructiveClass =
  'px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none text-red-400 data-[highlighted]:bg-red-500/20 data-[highlighted]:text-red-400'

export function ManageChatConnectionsDialog() {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('list')
  const [connections, setConnections] = useState<ChatApiConnection[]>([])
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [sourceMode, setSourceMode] = useState(false)
  const [yamlText, setYamlText] = useState('')
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; error?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  _openManageChatConnections = useCallback(() => {
    setOpen(true)
    setView('list')
    setError(null)
    setTestResult(null)
    setSourceMode(false)
  }, [])

  const fetchConnections = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/chat/connections`)
      if (res.ok) {
        const data = (await res.json()) as { connections: ChatApiConnection[] }
        setConnections(data.connections)
      }
    } catch {
      // network error
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) fetchConnections()
  }, [open, fetchConnections])

  function handleClose() {
    setOpen(false)
    setView('list')
    setForm(emptyForm)
    setEditId(null)
    setError(null)
    setTestResult(null)
    setSourceMode(false)
  }

  function startAdd() {
    setForm(emptyForm)
    setEditId(null)
    setView('add')
    setError(null)
    setSourceMode(false)
  }

  function startEdit(connection: ChatApiConnection) {
    setForm({
      name: connection.name,
      url: connection.url,
      apiKey: connection.apiKey,
      model: connection.model || '',
    })
    setEditId(connection.id)
    setView('edit')
    setError(null)
    setSourceMode(false)
  }

  function startDuplicate(connection: ChatApiConnection) {
    setForm({
      name: `${connection.name} (copy)`,
      url: connection.url,
      apiKey: connection.apiKey,
      model: connection.model || '',
    })
    setEditId(null)
    setView('add')
    setError(null)
    setSourceMode(false)
  }

  function copyYaml(connection: ChatApiConnection) {
    const yaml = formToYaml({
      name: connection.name,
      url: connection.url,
      apiKey: connection.apiKey,
      model: connection.model || '',
    })
    navigator.clipboard.writeText(yaml)
    haptic('success')
  }

  function toggleSourceMode() {
    if (!sourceMode) {
      setYamlText(formToYaml(form))
      setSourceMode(true)
      setError(null)
    } else {
      const parsed = yamlToForm(yamlText)
      if (typeof parsed === 'string') {
        setError(parsed)
        return
      }
      setForm(parsed)
      setSourceMode(false)
      setError(null)
    }
    haptic('tap')
  }

  async function handleSave() {
    let saveForm = form
    if (sourceMode) {
      const parsed = yamlToForm(yamlText)
      if (typeof parsed === 'string') {
        setError(parsed)
        return
      }
      saveForm = parsed
    }
    if (!saveForm.name || !saveForm.url || !saveForm.apiKey) {
      setError('Name, URL, and API key are required')
      return
    }
    haptic('tap')
    setLoading(true)
    setError(null)
    try {
      const body = {
        name: saveForm.name,
        url: saveForm.url,
        apiKey: saveForm.apiKey,
        model: saveForm.model || undefined,
      }
      if (editId) {
        await fetch(`${API_BASE}/chat/connections/${editId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        await fetch(`${API_BASE}/chat/connections`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
      await fetchConnections()
      setView('list')
      setForm(emptyForm)
      setEditId(null)
      setSourceMode(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(id: string) {
    haptic('tap')
    await fetch(`${API_BASE}/chat/connections/${id}`, { method: 'DELETE' })
    await fetchConnections()
  }

  async function handleTest(id: string) {
    haptic('tap')
    setTesting(id)
    setTestResult(null)
    try {
      const res = await fetch(`${API_BASE}/chat/connections/${id}/test`, { method: 'POST' })
      const data = await res.json()
      setTestResult({ id, ok: data.ok, error: data.error })
    } catch (err) {
      setTestResult({ id, ok: false, error: err instanceof Error ? err.message : 'Failed' })
    } finally {
      setTesting(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o: boolean) => !o && handleClose()}>
      <DialogContent className="max-w-md rounded-lg">
        <div className="p-5 flex flex-col gap-3 min-h-0 max-h-[calc(85vh-2rem)]">
          <DialogTitle className="text-sm font-bold font-mono">
            {view === 'list' ? 'MANAGE CHAT CONNECTIONS' : view === 'add' ? 'ADD CONNECTION' : 'EDIT CONNECTION'}
          </DialogTitle>

          {view === 'list' && (
            <>
              {loading && connections.length === 0 ? (
                <div className="text-xs text-muted-foreground font-mono py-4">Loading...</div>
              ) : connections.length === 0 ? (
                <div className="text-xs text-muted-foreground font-mono py-4">
                  No connections registered. Add one to get started.
                </div>
              ) : (
                <div className="overflow-y-auto flex-1 min-h-0 space-y-1">
                  {connections.map(connection => (
                    <div key={connection.id} className="rounded hover:bg-muted/30 transition-colors">
                      <div className="flex items-center gap-2 px-2 py-1.5">
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-mono font-medium truncate">{connection.name}</div>
                          <div className="text-[10px] text-muted-foreground font-mono truncate">{connection.url}</div>
                        </div>
                        <ConnectionActions
                          testing={testing === connection.id}
                          onTest={() => handleTest(connection.id)}
                          onEdit={() => startEdit(connection)}
                          onDuplicate={() => startDuplicate(connection)}
                          onCopyYaml={() => copyYaml(connection)}
                          onDelete={() => handleDelete(connection.id)}
                        />
                      </div>
                      {testResult?.id === connection.id && (
                        <div
                          className={cn(
                            'text-[10px] font-mono px-2 pb-1.5 truncate',
                            testResult.ok ? 'text-green-400' : 'text-red-400',
                          )}
                        >
                          {testResult.ok ? 'Connected' : 'Connection failed'}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={startAdd}
                className="w-full text-xs font-mono py-1.5 rounded bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
              >
                + Add connection
              </button>
            </>
          )}

          {(view === 'add' || view === 'edit') && (
            <>
              {sourceMode ? (
                <YamlEditor value={yamlText} onChange={setYamlText} />
              ) : (
                <div className="space-y-2">
                  {view === 'add' && (
                    <ProviderSelect
                      selectedUrl={form.url}
                      onSelect={(preset: ProviderPreset) => {
                        setForm(f => ({
                          ...f,
                          name: preset.id === 'custom' ? f.name : preset.name,
                          url: preset.url,
                          model: preset.defaultModel || (preset.id === 'custom' ? f.model : ''),
                        }))
                      }}
                    />
                  )}
                  <FormField
                    label="Name"
                    value={form.name}
                    onChange={v => setForm(f => ({ ...f, name: v }))}
                    placeholder="Personal"
                  />
                  <FormField
                    label="URL"
                    value={form.url}
                    onChange={v => setForm(f => ({ ...f, url: v }))}
                    placeholder="http://localhost:8642"
                  />
                  <MaskedField
                    label="API Key"
                    value={form.apiKey}
                    onChange={v => setForm(f => ({ ...f, apiKey: v }))}
                    placeholder="your-api-key"
                    visibleChars={8}
                  />
                  <ModelPicker
                    value={form.model}
                    onChange={v => setForm(f => ({ ...f, model: v }))}
                    url={form.url}
                    apiKey={form.apiKey}
                  />
                </div>
              )}
              {error && <div className="text-xs text-red-400 font-mono">{error}</div>}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setView('list')
                    setError(null)
                    setSourceMode(false)
                  }}
                  className="text-xs font-mono py-1.5 px-3 rounded bg-surface-inset hover:bg-muted/50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={toggleSourceMode}
                  className="text-xs font-mono py-1.5 px-3 rounded bg-surface-inset hover:bg-muted/50 transition-colors text-muted-foreground"
                >
                  {sourceMode ? 'form' : 'yaml'}
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={loading}
                  className="flex-1 text-xs font-mono py-1.5 rounded bg-primary/10 hover:bg-primary/20 text-primary transition-colors disabled:opacity-50"
                >
                  {loading ? 'Saving...' : 'Save'}
                </button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ConnectionActions({
  testing,
  onTest,
  onEdit,
  onDuplicate,
  onCopyYaml,
  onDelete,
}: {
  testing: boolean
  onTest: () => void
  onEdit: () => void
  onDuplicate: () => void
  onCopyYaml: () => void
  onDelete: () => void
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-surface-inset hover:bg-muted/50 transition-colors text-muted-foreground shrink-0"
        >
          ..
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={menuContentClass} align="end" sideOffset={5}>
          <DropdownMenu.Item className={menuItemClass} onSelect={onEdit}>
            Edit
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItemClass} onSelect={onDuplicate}>
            Duplicate
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItemClass} onSelect={onCopyYaml}>
            Copy as YAML
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItemClass} disabled={testing} onSelect={onTest}>
            {testing ? 'Testing...' : 'Test connection'}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="h-px bg-border my-1" />
          <DropdownMenu.Item className={menuItemDestructiveClass} onSelect={onDelete}>
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

const yamlEditorExtensions = buildFileEditorExtensions('connection.yaml')

function YamlEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <SafeCodeMirror
      value={value}
      onChange={onChange}
      extensions={yamlEditorExtensions}
      autoFocus
      basicSetup={false}
      theme="dark"
    />
  )
}

function MaskedField({
  label,
  value,
  onChange,
  placeholder,
  visibleChars,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  visibleChars: number
}) {
  const [focused, setFocused] = useState(false)
  const display =
    focused || value.length <= visibleChars
      ? value
      : value.slice(0, visibleChars) + '•'.repeat(Math.min(value.length - visibleChars, 20))

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-mono text-muted-foreground w-12 shrink-0 text-right">{label}</span>
      <input
        type="text"
        value={display}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        autoComplete="off"
        className="flex-1 bg-surface-inset border border-border rounded px-2 py-1 text-[11px] font-mono text-foreground placeholder:text-comment/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
      />
    </div>
  )
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-mono text-muted-foreground w-12 shrink-0 text-right">{label}</span>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="flex-1 bg-surface-inset border border-border rounded px-2 py-1 text-[11px] font-mono text-foreground placeholder:text-comment/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
      />
    </div>
  )
}
