import { Plus, Shield, ShieldCheck, ShieldOff, X, Zap } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  type RclaudePermissionConfig,
  requestRclaudeConfig,
  saveRclaudeConfig,
  useConversationsStore,
} from '@/hooks/use-sessions'
import { projectPath } from '@/lib/types'
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
  project: string
}

function AllowAllBanner({
  allowAll,
  autoDetected,
  onToggle,
}: {
  allowAll: boolean
  autoDetected: boolean
  onToggle: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!allowAll)}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 py-2.5 border transition-all text-left group',
        allowAll
          ? 'border-green-500/50 bg-green-500/10 hover:bg-green-500/15'
          : 'border-border hover:border-amber-500/50 hover:bg-amber-500/5',
      )}
    >
      {allowAll ? (
        <ShieldCheck className="w-4 h-4 text-green-400 shrink-0" />
      ) : (
        <ShieldOff className="w-4 h-4 text-muted-foreground/50 shrink-0 group-hover:text-amber-400" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={cn('text-[11px] font-bold', allowAll ? 'text-green-400' : 'text-foreground/70')}>
            Allow All
          </span>
          {allowAll && autoDetected && (
            <span className="text-[8px] text-green-400/60 border border-green-500/30 px-1 uppercase">auto</span>
          )}
        </div>
        <span className="text-[9px] text-muted-foreground/60">
          {allowAll
            ? 'Auto-approving all permission requests for this project'
            : 'Click to auto-approve all tool permissions'}
        </span>
      </div>
      <div
        className={cn(
          'w-8 h-4 rounded-full relative transition-colors shrink-0',
          allowAll ? 'bg-green-500/60' : 'bg-muted-foreground/20',
        )}
      >
        <div
          className={cn(
            'absolute top-0.5 w-3 h-3 rounded-full transition-all',
            allowAll ? 'left-4 bg-green-300' : 'left-0.5 bg-muted-foreground/50',
          )}
        />
      </div>
    </button>
  )
}

function ToolSection({
  tool,
  rules,
  linked,
  inputValue,
  onAdd,
  onRemove,
  onInputChange,
}: {
  tool: Tool
  rules: Record<Tool, string[]>
  linked: boolean
  inputValue: string
  onAdd: (tool: Tool, pattern: string) => void
  onRemove: (tool: Tool, pattern: string) => void
  onInputChange: (tool: Tool, value: string) => void
}) {
  const existing = new Set([...BUILTINS, ...rules[tool]])
  const suggestions = COMMON_GLOBS.filter(g => !existing.has(g)).slice(0, 4)
  const isLinkedSecondary = linked && tool === 'Edit'

  return (
    <div className={cn(isLinkedSecondary && 'opacity-50 pointer-events-none')}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-bold">{tool}</span>
        {isLinkedSecondary && (
          <span className="text-[8px] text-muted-foreground/40 border border-border/50 px-1">synced</span>
        )}
        <span className="flex-1 h-px bg-border" />
        <span className="text-[10px] text-muted-foreground/50 tabular-nums">
          {BUILTINS.length + rules[tool].length}
        </span>
      </div>

      {/* Built-in rules */}
      {BUILTINS.map(pattern => (
        <div key={pattern} className="flex items-center gap-1 px-1.5 py-0.5">
          <Shield className="w-3 h-3 text-muted-foreground/20 shrink-0" />
          <span className="text-[10px] font-mono text-muted-foreground/40 flex-1">{pattern}</span>
          <span className="text-[8px] text-muted-foreground/30 border border-border/50 px-1 uppercase">built-in</span>
        </div>
      ))}

      {/* Custom rules */}
      {rules[tool].map(pattern => (
        <div key={pattern} className="flex items-center gap-1 px-1.5 py-0.5 group">
          <Zap className="w-3 h-3 text-accent/40 shrink-0" />
          <span className="text-[10px] font-mono text-foreground flex-1">{pattern}</span>
          <button
            type="button"
            onClick={() => onRemove(tool, pattern)}
            className="text-muted-foreground/30 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}

      {rules[tool].length === 0 && (
        <div className="text-[10px] text-muted-foreground/30 italic px-1.5 py-0.5 pl-6">no custom rules</div>
      )}

      {/* Add input */}
      <div className="flex gap-1 mt-1">
        <input
          type="text"
          value={inputValue}
          onChange={e => onInputChange(tool, e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onAdd(tool, inputValue)
          }}
          placeholder={tool === 'Read' ? '.secret/**' : '.claude/settings/**'}
          className="flex-1 bg-background border border-border px-1.5 py-0.5 text-foreground text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/30"
        />
        <button
          type="button"
          onClick={() => onAdd(tool, inputValue)}
          disabled={!inputValue.trim()}
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
              onClick={() => onAdd(tool, g)}
              className="text-[9px] font-mono px-1 py-px border border-border/50 text-muted-foreground/40 hover:text-accent hover:border-accent/50 transition-colors"
            >
              {g}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function PermissionRulesEditor({ project }: PermissionRulesEditorProps) {
  const hasConfigRw = useConversationsStore(s =>
    s.sessions.some(sess => sess.project === project && sess.capabilities?.includes('config_rw')),
  )
  const [rules, setRules] = useState<Record<Tool, string[]>>({ Write: [], Edit: [], Read: [] })
  const [allowAll, setAllowAll] = useState(false)
  const [allowAllAutoDetected, setAllowAllAutoDetected] = useState(false)
  const [allowPlanMode, setAllowPlanMode] = useState(true)
  const [linked, setLinked] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [inputValues, setInputValues] = useState<Record<Tool, string>>({ Write: '', Edit: '', Read: '' })

  const resolvedPath = projectPath(project)
  const pathInsideDotClaude = /[/\\]\.claude([/\\]|$)/.test(resolvedPath)

  const loadConfig = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await requestRclaudeConfig(project)
      const perms = data.config?.permissions
      setRules({
        Write: perms?.Write?.allow ? [...perms.Write.allow] : [],
        Edit: perms?.Edit?.allow ? [...perms.Edit.allow] : [],
        Read: perms?.Read?.allow ? [...perms.Read.allow] : [],
      })
      const explicitAllowAll = data.config?.allowAll
      const effective = explicitAllowAll ?? pathInsideDotClaude
      setAllowAll(effective)
      setAllowAllAutoDetected(explicitAllowAll === undefined && pathInsideDotClaude)
      setAllowPlanMode(data.config?.allowPlanMode !== false)

      const w = new Set(perms?.Write?.allow || [])
      const e = new Set(perms?.Edit?.allow || [])
      setLinked(w.size === e.size && [...w].every(g => e.has(g)))
      setDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config')
    }
    setLoading(false)
  }, [project, pathInsideDotClaude])

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
    setAllowAll(false)
    setAllowAllAutoDetected(false)
    setDirty(true)
  }

  function handleAllowAllToggle(v: boolean) {
    setAllowAll(v)
    setAllowAllAutoDetected(false)
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
      if (allowAll) config.allowAll = true
      if (!allowPlanMode) config.allowPlanMode = false

      const result = await saveRclaudeConfig(project, config)
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
      {/* Allow All toggle */}
      <AllowAllBanner allowAll={allowAll} autoDetected={allowAllAutoDetected} onToggle={handleAllowAllToggle} />

      {/* File-level rules (dimmed when allowAll is on) */}
      <div className={cn('space-y-3 transition-opacity', allowAll && 'opacity-40')}>
        {/* Presets */}
        <div>
          <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-1.5 font-bold">Presets</div>
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
          <input
            type="checkbox"
            checked={linked}
            onChange={e => setLinked(e.target.checked)}
            className="accent-accent"
          />
          <span className="text-[10px] text-muted-foreground">Sync Write &amp; Edit rules</span>
        </label>

        {/* Tool sections */}
        {TOOLS.map(tool => (
          <ToolSection
            key={tool}
            tool={tool}
            rules={rules}
            linked={linked}
            inputValue={inputValues[tool]}
            onAdd={addGlob}
            onRemove={removeGlob}
            onInputChange={(t, v) => setInputValues(prev => ({ ...prev, [t]: v }))}
          />
        ))}
      </div>

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
            className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-accent bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save permissions'}
          </button>
          <button
            type="button"
            onClick={loadConfig}
            className="px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground border border-border transition-colors"
          >
            Discard
          </button>
          {error && <span className="text-[10px] text-red-400">{error}</span>}
        </div>
      )}

      {/* Toast */}
      {toast && <div className="text-[10px] text-green-400 py-0.5">{toast}</div>}
    </div>
  )
}
