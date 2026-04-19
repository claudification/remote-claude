import { Plus, Shield, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  type RclaudePermissionConfig,
  requestRclaudeConfig,
  saveRclaudeConfig,
  useSessionsStore,
} from '@/hooks/use-sessions'
import { cn } from '@/lib/utils'

const BUILTINS = ['.rclaude/project/**', '.rclaude/docs/**']

const COMMON_GLOBS = [
  '.claude/**',
  '.claude/docs/**',
  '.claude/notes/**',
  '.claude/lessons-learned/**',
  '.claude/CLAUDE.md',
  '.claude/settings.json',
  '.claude/settings.local.json',
  'CHANGELOG.md',
  'docs/**',
]

interface Preset {
  label: string
  Write: string[]
  Edit: string[]
  Read: string[]
  accent?: string
}

const PRESETS: Preset[] = [
  {
    label: 'Always allow .claude/',
    Write: ['.claude/**'],
    Edit: ['.claude/**'],
    Read: ['.claude/**'],
    accent: 'green',
  },
  {
    label: 'Docs & notes',
    Write: ['.claude/docs/**', '.claude/notes/**', '.claude/lessons-learned/**'],
    Edit: ['.claude/docs/**', '.claude/notes/**', '.claude/lessons-learned/**'],
    Read: [],
  },
  {
    label: 'CLAUDE.md only',
    Write: ['.claude/CLAUDE.md'],
    Edit: ['.claude/CLAUDE.md'],
    Read: [],
  },
]

type Tool = 'Write' | 'Edit' | 'Read'
const TOOLS: Tool[] = ['Write', 'Edit', 'Read']

interface PermissionRulesEditorProps {
  cwd: string
}

export function PermissionRulesEditor({ cwd }: PermissionRulesEditorProps) {
  const hasConfigRw = useSessionsStore(s =>
    s.sessions.some(sess => sess.cwd === cwd && sess.capabilities?.includes('config_rw')),
  )
  const [rules, setRules] = useState<Record<Tool, string[]>>({ Write: [], Edit: [], Read: [] })
  const [allowPlanMode, setAllowPlanMode] = useState(true)
  const [linked, setLinked] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [inputValues, setInputValues] = useState<Record<Tool, string>>({ Write: '', Edit: '', Read: '' })

  const loadConfig = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await requestRclaudeConfig(cwd)
      const perms = data.config?.permissions
      setRules({
        Write: perms?.Write?.allow ? [...perms.Write.allow] : [],
        Edit: perms?.Edit?.allow ? [...perms.Edit.allow] : [],
        Read: perms?.Read?.allow ? [...perms.Read.allow] : [],
      })
      setAllowPlanMode(data.config?.allowPlanMode !== false)

      const w = new Set(perms?.Write?.allow || [])
      const e = new Set(perms?.Edit?.allow || [])
      setLinked(w.size === e.size && [...w].every(g => e.has(g)))
      setDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config')
    }
    setLoading(false)
  }, [cwd])

  useEffect(() => {
    if (hasConfigRw) loadConfig()
  }, [loadConfig, hasConfigRw])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  function addGlob(tool: Tool, pattern: string) {
    if (!pattern.trim() || rules[tool].includes(pattern.trim())) return
    const p = pattern.trim()
    setRules(prev => {
      const next = { ...prev, [tool]: [...prev[tool], p] }
      if (linked && (tool === 'Write' || tool === 'Edit')) {
        const other: Tool = tool === 'Write' ? 'Edit' : 'Write'
        if (!prev[other].includes(p)) {
          next[other] = [...prev[other], p]
        }
      }
      return next
    })
    setInputValues(prev => ({ ...prev, [tool]: '' }))
    setDirty(true)
  }

  function removeGlob(tool: Tool, pattern: string) {
    setRules(prev => {
      const next = { ...prev, [tool]: prev[tool].filter(g => g !== pattern) }
      if (linked && (tool === 'Write' || tool === 'Edit')) {
        const other: Tool = tool === 'Write' ? 'Edit' : 'Write'
        next[other] = prev[other].filter(g => g !== pattern)
      }
      return next
    })
    setDirty(true)
  }

  function applyPreset(preset: Preset) {
    setRules({ Write: [...preset.Write], Edit: [...preset.Edit], Read: [...preset.Read] })
    setDirty(true)
    showToast(`Applied: ${preset.label}`)
  }

  function resetAll() {
    setRules({ Write: [], Edit: [], Read: [] })
    setDirty(true)
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const config: RclaudePermissionConfig = {}
      const perms: RclaudePermissionConfig['permissions'] = {}
      for (const tool of TOOLS) {
        if (rules[tool].length > 0) {
          perms[tool] = { allow: rules[tool] }
        }
      }
      if (Object.keys(perms).length > 0) config.permissions = perms
      if (!allowPlanMode) config.allowPlanMode = false

      const result = await saveRclaudeConfig(cwd, config)
      if (!result.ok) throw new Error(result.error || 'Save failed')

      setDirty(false)
      showToast('Saved -- active sessions reloaded')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    }
    setSaving(false)
  }

  if (!hasConfigRw) {
    return (
      <div className="text-[10px] text-muted-foreground/50 py-2">
        Agent not connected or does not support config read/write.
      </div>
    )
  }

  if (loading) {
    return <div className="text-[10px] text-muted-foreground py-4 text-center">Loading permission rules...</div>
  }

  if (error && !dirty) {
    return (
      <div className="space-y-2">
        <div className="text-[10px] text-red-400 py-2">{error}</div>
        <button
          type="button"
          onClick={loadConfig}
          className="text-[10px] text-accent hover:text-accent/80 transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  const hasRules = TOOLS.some(t => rules[t].length > 0)

  return (
    <div className="space-y-3">
      {/* Presets */}
      <div>
        <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-1.5">Presets</div>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map(preset => (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyPreset(preset)}
              className={cn(
                'px-2 py-1 text-[10px] font-mono border transition-colors',
                preset.accent === 'green'
                  ? 'border-green-500/50 text-green-400 hover:bg-green-500/20'
                  : 'border-border text-muted-foreground hover:text-accent hover:border-accent',
              )}
            >
              {preset.accent === 'green' && <Shield className="w-3 h-3 inline mr-1 -mt-0.5" />}
              {preset.label}
            </button>
          ))}
          {hasRules && (
            <button
              type="button"
              onClick={resetAll}
              className="px-2 py-1 text-[10px] font-mono border border-red-500/30 text-red-400/70 hover:text-red-400 hover:border-red-500/50 transition-colors"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Sync toggle */}
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" checked={linked} onChange={e => setLinked(e.target.checked)} className="accent-accent" />
        <span className="text-[10px] text-muted-foreground">Sync Write &amp; Edit rules</span>
      </label>

      {/* Tool sections */}
      {TOOLS.map(tool => {
        const existing = new Set([...BUILTINS, ...rules[tool]])
        const suggestions = COMMON_GLOBS.filter(g => !existing.has(g)).slice(0, 4)

        return (
          <div key={tool}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">{tool}</span>
              <span className="flex-1 h-px bg-border" />
              <span className="text-[10px] text-muted-foreground/50">{rules[tool].length}</span>
            </div>

            {/* Built-in rules */}
            {BUILTINS.map(pattern => (
              <div key={pattern} className="flex items-center gap-1 px-1.5 py-0.5">
                <span className="text-[10px] font-mono text-muted-foreground/40 flex-1">{pattern}</span>
                <span className="text-[8px] text-muted-foreground/30 border border-border/50 px-1 uppercase">
                  built-in
                </span>
              </div>
            ))}

            {/* Custom rules */}
            {rules[tool].map(pattern => (
              <div key={pattern} className="flex items-center gap-1 px-1.5 py-0.5 group">
                <span className="text-[10px] font-mono text-foreground flex-1">{pattern}</span>
                <button
                  type="button"
                  onClick={() => removeGlob(tool, pattern)}
                  className="text-muted-foreground/30 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}

            {rules[tool].length === 0 && (
              <div className="text-[10px] text-muted-foreground/30 italic px-1.5 py-0.5">no custom rules</div>
            )}

            {/* Add input */}
            <div className="flex gap-1 mt-1">
              <input
                type="text"
                value={inputValues[tool]}
                onChange={e => setInputValues(prev => ({ ...prev, [tool]: e.target.value }))}
                onKeyDown={e => {
                  if (e.key === 'Enter') addGlob(tool, inputValues[tool])
                }}
                placeholder={tool === 'Read' ? '.secret/**' : '.claude/settings/**'}
                className="flex-1 bg-background border border-border px-1.5 py-0.5 text-foreground text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/30"
              />
              <button
                type="button"
                onClick={() => addGlob(tool, inputValues[tool])}
                disabled={!inputValues[tool].trim()}
                className="px-1.5 py-0.5 text-[10px] font-bold border border-border text-muted-foreground hover:text-accent hover:border-accent disabled:opacity-20 transition-colors"
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>

            {/* Suggestions */}
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-0.5 mt-1">
                {suggestions.map(g => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => addGlob(tool, g)}
                    className="text-[9px] font-mono px-1 py-px border border-border/50 text-muted-foreground/40 hover:text-accent hover:border-accent/50 transition-colors"
                  >
                    {g}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* Plan mode */}
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="checkbox"
          checked={allowPlanMode}
          onChange={e => {
            setAllowPlanMode(e.target.checked)
            setDirty(true)
          }}
          className="accent-accent"
        />
        <span className="text-[10px] text-foreground">Allow plan mode</span>
      </label>

      {/* Save */}
      {dirty && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider border border-accent bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save permissions'}
          </button>
          {error && <span className="text-[10px] text-red-400">{error}</span>}
        </div>
      )}

      {/* Toast */}
      {toast && <div className="text-[10px] text-green-400 py-0.5">{toast}</div>}
    </div>
  )
}
