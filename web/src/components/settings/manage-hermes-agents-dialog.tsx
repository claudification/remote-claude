import { useCallback, useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn, haptic } from '@/lib/utils'
import type { HermesAgent } from '../../../../src/shared/hermes-types'

const API_BASE = `${window.location.protocol}//${window.location.host}/api`

let _openManageHermes: (() => void) | null = null

export function openManageHermesAgents(): void {
  _openManageHermes?.()
}

type View = 'list' | 'add' | 'edit'

interface FormState {
  name: string
  url: string
  apiKey: string
  model: string
}

const emptyForm: FormState = { name: '', url: '', apiKey: '', model: '' }

export function ManageHermesAgentsDialog() {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('list')
  const [agents, setAgents] = useState<HermesAgent[]>([])
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; error?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  _openManageHermes = useCallback(() => {
    setOpen(true)
    setView('list')
    setError(null)
    setTestResult(null)
  }, [])

  const fetchAgents = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/hermes/agents`)
      if (res.ok) {
        const data = (await res.json()) as { agents: HermesAgent[] }
        setAgents(data.agents)
      }
    } catch {
      // network error
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) fetchAgents()
  }, [open, fetchAgents])

  function handleClose() {
    setOpen(false)
    setView('list')
    setForm(emptyForm)
    setEditId(null)
    setError(null)
    setTestResult(null)
  }

  function startAdd() {
    setForm(emptyForm)
    setEditId(null)
    setView('add')
    setError(null)
  }

  function startEdit(agent: HermesAgent) {
    setForm({
      name: agent.name,
      url: agent.url,
      apiKey: agent.apiKey,
      model: agent.model || '',
    })
    setEditId(agent.id)
    setView('edit')
    setError(null)
  }

  async function handleSave() {
    if (!form.name || !form.url || !form.apiKey) {
      setError('Name, URL, and API key are required')
      return
    }
    haptic('tap')
    setLoading(true)
    setError(null)
    try {
      const body = {
        name: form.name,
        url: form.url,
        apiKey: form.apiKey,
        model: form.model || undefined,
      }
      if (editId) {
        await fetch(`${API_BASE}/hermes/agents/${editId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        await fetch(`${API_BASE}/hermes/agents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
      await fetchAgents()
      setView('list')
      setForm(emptyForm)
      setEditId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(id: string) {
    haptic('tap')
    await fetch(`${API_BASE}/hermes/agents/${id}`, { method: 'DELETE' })
    await fetchAgents()
  }

  async function handleTest(id: string) {
    haptic('tap')
    setTesting(id)
    setTestResult(null)
    try {
      const res = await fetch(`${API_BASE}/hermes/agents/${id}/test`, { method: 'POST' })
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
            {view === 'list' ? 'MANAGE HERMES AGENTS' : view === 'add' ? 'ADD HERMES AGENT' : 'EDIT HERMES AGENT'}
          </DialogTitle>

          {view === 'list' && (
            <>
              {loading && agents.length === 0 ? (
                <div className="text-xs text-muted-foreground font-mono py-4">Loading...</div>
              ) : agents.length === 0 ? (
                <div className="text-xs text-muted-foreground font-mono py-4">
                  No Hermes agents registered. Add one to get started.
                </div>
              ) : (
                <div className="overflow-y-auto flex-1 min-h-0 space-y-1">
                  {agents.map(agent => (
                    <div key={agent.id} className="rounded hover:bg-muted/30 transition-colors">
                      <div className="flex items-center gap-2 px-2 py-1.5">
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-mono font-medium truncate">{agent.name}</div>
                          <div className="text-[10px] text-muted-foreground font-mono truncate">{agent.url}</div>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleTest(agent.id)}
                            disabled={testing === agent.id}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-inset hover:bg-muted/50 transition-colors disabled:opacity-50"
                          >
                            {testing === agent.id ? '...' : 'test'}
                          </button>
                          <button
                            type="button"
                            onClick={() => startEdit(agent)}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-inset hover:bg-muted/50 transition-colors"
                          >
                            edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(agent.id)}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-inset hover:bg-red-500/20 text-red-400 transition-colors"
                          >
                            del
                          </button>
                        </div>
                      </div>
                      {testResult?.id === agent.id && (
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
                + Add agent
              </button>
            </>
          )}

          {(view === 'add' || view === 'edit') && (
            <>
              <div className="space-y-2">
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
                <FormField
                  label="API Key"
                  value={form.apiKey}
                  onChange={v => setForm(f => ({ ...f, apiKey: v }))}
                  placeholder="your-api-key"
                  type="password"
                />
                <FormField
                  label="Model"
                  value={form.model}
                  onChange={v => setForm(f => ({ ...f, model: v }))}
                  placeholder="(optional)"
                />
              </div>
              {error && <div className="text-xs text-red-400 font-mono">{error}</div>}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setView('list')
                    setError(null)
                  }}
                  className="flex-1 text-xs font-mono py-1.5 rounded bg-surface-inset hover:bg-muted/50 transition-colors"
                >
                  Cancel
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

function FormField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-mono text-muted-foreground w-12 shrink-0 text-right">{label}</span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-surface-inset border border-border rounded px-2 py-1 text-[11px] font-mono text-foreground placeholder:text-comment/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
      />
    </div>
  )
}
