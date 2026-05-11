/**
 * LaunchConfigFields - Controlled form for launch/spawn configuration.
 *
 * Dumb component used by both SpawnDialog and RunTaskDialog. Parents own
 * canonical state. The `show` mask controls which rows render; `disabled`
 * toggles individual fields. No project-settings fetching, no spawn logic.
 */

import { DEFAULT_SENTINEL, EFFORT_OPTIONS, MODEL_OPTION_GROUPS, PERMISSION_MODE_OPTIONS } from '@shared/spawn-schema'
import type React from 'react'
import { useMemo } from 'react'
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
import { TileToggleRow } from '@/components/ui/tile-toggle-row'
import { TogglePill } from '@/components/ui/toggle-pill'
import { parseEnvText } from '@/lib/env-parse'

type LaunchFieldKey =
  | 'model'
  | 'effort'
  | 'agent'
  | 'permissionMode'
  | 'autocompactPct'
  | 'includePartialMessages'
  | 'worktree'
  | 'autoCommit'
  | 'leaveRunning'
  | 'maxBudgetUsd'
  | 'timeout'
  | 'name'
  | 'description'
  | 'env'
  | 'headless'
  | 'bare'
  | 'repl'

export type LaunchFieldsValue = {
  // Subset of SpawnRequest -- parent owns canonical state
  model?: string
  effort?: string
  agent?: string
  permissionMode?: string
  autocompactPct?: number | ''
  maxBudgetUsd?: string
  name?: string
  description?: string
  envText?: string

  // Worktree: split into enable flag + branch name
  useWorktree?: boolean
  worktreeName?: string

  // Streaming
  includePartialMessages?: boolean

  // Claude runtime (CC-only)
  headless?: boolean
  bare?: boolean
  repl?: boolean

  // Prompt-suffix flags (not part of SpawnRequest)
  autoCommit?: boolean
  leaveRunning?: boolean

  // RunTaskDialog-only
  timeout?: string
}

type LaunchFieldsProps = {
  value: LaunchFieldsValue
  onChange: (patch: Partial<LaunchFieldsValue>) => void
  show?: Partial<Record<LaunchFieldKey, boolean>>
  disabled?: Partial<Record<LaunchFieldKey, boolean>>
  /** Render H/P hints on the headless/PTY pills. Only set when the parent
   *  actually binds those keys (e.g. spawn-dialog). */
  headlessShortcutHints?: boolean
}

/** Tiny row component for label + right-aligned control. Optional subtitle. */
function Row({
  label,
  subtitle,
  htmlFor,
  children,
}: {
  label: string
  subtitle?: string
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-0.5">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-[10px] font-mono text-muted-foreground block">
          {label}
        </label>
        {subtitle && <div className="text-[9px] text-comment mt-0.5 leading-snug">{subtitle}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function LaunchConfigFields({
  value,
  onChange,
  show = {},
  disabled = {},
  headlessShortcutHints = false,
}: LaunchFieldsProps) {
  // Live env validation: recompute errors whenever envText changes so the user
  // sees feedback as they type, rather than only on spawn/run submit.
  const envErrors = useMemo(() => {
    if (!show.env) return []
    const [, errors] = parseEnvText(value.envText ?? '')
    return errors
  }, [show.env, value.envText])

  return (
    <div className="space-y-3">
      {show.headless && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-mono text-muted-foreground">Mode</div>
          <div className="flex gap-2">
            <TogglePill
              active={value.headless ?? true}
              onClick={() => onChange({ headless: true })}
              label="Headless"
              shortcut={headlessShortcutHints ? 'H' : undefined}
            />
            <TogglePill
              active={!(value.headless ?? true)}
              onClick={() => onChange({ headless: false })}
              label="PTY"
              shortcut={headlessShortcutHints ? 'P' : undefined}
            />
          </div>
        </div>
      )}
      {show.model && (
        <Row label="Model" subtitle="Claude model version" htmlFor="lcf-model">
          <div className="flex-1 max-w-[220px]">
            <Select
              value={value.model ? value.model : DEFAULT_SENTINEL}
              onValueChange={v => onChange({ model: v === DEFAULT_SENTINEL ? '' : v })}
              disabled={disabled.model}
            >
              <SelectTrigger id="lcf-model" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_SENTINEL} info="Use project / global default">
                  Default
                </SelectItem>
                {MODEL_OPTION_GROUPS.map((g, gi) => (
                  <SelectGroup key={g.group}>
                    {gi > 0 && <SelectSeparator />}
                    <SelectLabel>{g.group}</SelectLabel>
                    {g.options.map(opt => (
                      <SelectItem key={opt.value} value={opt.value} info={opt.info}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Row>
      )}
      {show.effort && (
        <Row label="Effort" subtitle="Thinking budget (higher = slower, deeper)" htmlFor="lcf-effort">
          <div className="flex-1 max-w-[220px]">
            <Select
              value={value.effort ? value.effort : DEFAULT_SENTINEL}
              onValueChange={v => onChange({ effort: v === DEFAULT_SENTINEL ? '' : v })}
              disabled={disabled.effort}
            >
              <SelectTrigger id="lcf-effort" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EFFORT_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value} info={opt.info}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Row>
      )}
      {show.agent && (
        <Row label="Agent" subtitle="Named agent from agents.md or --agents config" htmlFor="lcf-agent">
          <input
            id="lcf-agent"
            type="text"
            value={value.agent ?? ''}
            onChange={e => onChange({ agent: e.target.value })}
            disabled={disabled.agent}
            placeholder="(none)"
            className="flex-1 max-w-[220px] text-[10px] font-mono bg-surface-inset border border-primary/20 text-foreground px-2 py-1 outline-none"
          />
        </Row>
      )}
      {show.permissionMode && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-mono text-muted-foreground">Permissions</div>
          <div className="flex flex-wrap gap-1.5">
            {PERMISSION_MODE_OPTIONS.map(opt => {
              const current = value.permissionMode ? value.permissionMode : DEFAULT_SENTINEL
              return (
                <TogglePill
                  key={opt.value}
                  small
                  label={opt.label}
                  title={opt.info}
                  active={current === opt.value}
                  onClick={() => onChange({ permissionMode: opt.value === DEFAULT_SENTINEL ? '' : opt.value })}
                />
              )
            })}
          </div>
        </div>
      )}
      {show.autocompactPct && (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <label htmlFor="lcf-compact" className="text-[10px] font-mono text-muted-foreground block">
                Auto-compact %
              </label>
              <div className="text-[9px] text-comment mt-0.5 leading-snug">
                Compact context when usage hits this % of the window
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-2 font-mono text-[11px] tabular-nums">
              <span className={value.autocompactPct === '' ? 'text-comment' : 'text-primary'}>
                {value.autocompactPct === '' ? 'off' : `${value.autocompactPct}%`}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="lcf-compact"
              type="range"
              min={0}
              max={99}
              step={1}
              value={value.autocompactPct === '' ? 0 : (value.autocompactPct ?? 0)}
              onChange={e => {
                const n = Number(e.target.value)
                onChange({ autocompactPct: n === 0 ? '' : n })
              }}
              disabled={disabled.autocompactPct}
              className="flex-1 accent-primary cursor-pointer"
            />
            <button
              type="button"
              onClick={() => onChange({ autocompactPct: '' })}
              disabled={disabled.autocompactPct || value.autocompactPct === ''}
              className="text-[9px] font-mono text-comment hover:text-muted-foreground transition-colors disabled:opacity-30 disabled:hover:text-comment"
              title="Disable auto-compact"
            >
              clear
            </button>
          </div>
        </div>
      )}
      {show.maxBudgetUsd && (
        <Row
          label="Max budget USD"
          subtitle="Stop conversation when spend reaches this (blank = no limit)"
          htmlFor="lcf-budget"
        >
          <input
            id="lcf-budget"
            type="number"
            min={0}
            step={0.01}
            placeholder="(none)"
            value={value.maxBudgetUsd ?? ''}
            onChange={e => onChange({ maxBudgetUsd: e.target.value })}
            disabled={disabled.maxBudgetUsd}
            className="w-[100px] text-[10px] font-mono bg-surface-inset border border-primary/20 text-foreground px-2 py-1 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
        </Row>
      )}
      {show.timeout && (
        <Row label="Timeout" subtitle="Max runtime before forced stop" htmlFor="lcf-timeout">
          <select
            id="lcf-timeout"
            value={value.timeout ?? ''}
            onChange={e => onChange({ timeout: e.target.value })}
            disabled={disabled.timeout}
            className="text-[10px] font-mono bg-surface-inset border border-primary/20 text-foreground px-2 py-1 outline-none"
          >
            <option value="5">5 min</option>
            <option value="10">10 min</option>
            <option value="15">15 min</option>
            <option value="30">30 min</option>
            <option value="0">unlimited</option>
          </select>
        </Row>
      )}
      {show.name && (
        <Row label="Name" subtitle="Display label in sidebar" htmlFor="lcf-name">
          <input
            id="lcf-name"
            type="text"
            value={value.name ?? ''}
            onChange={e => onChange({ name: e.target.value })}
            disabled={disabled.name}
            className="flex-1 max-w-[220px] text-[10px] font-mono bg-surface-inset border border-primary/20 text-foreground px-2 py-1 outline-none"
          />
        </Row>
      )}
      {show.description && (
        <Row label="Description" subtitle="What this conversation is about" htmlFor="lcf-description">
          <input
            id="lcf-description"
            type="text"
            value={value.description ?? ''}
            onChange={e => onChange({ description: e.target.value })}
            disabled={disabled.description}
            placeholder="optional"
            className="flex-1 max-w-[220px] text-[10px] font-mono bg-surface-inset border border-primary/20 text-foreground px-2 py-1 outline-none placeholder:text-comment/80"
          />
        </Row>
      )}
      {show.includePartialMessages && (
        <TileToggleRow
          title="Partial messages"
          subtitle="Stream token-by-token output (increases data volume)"
          checked={value.includePartialMessages ?? true}
          onToggle={() => onChange({ includePartialMessages: !(value.includePartialMessages ?? true) })}
          disabled={disabled.includePartialMessages}
        />
      )}
      {show.worktree && (
        <div className="space-y-1.5">
          <TileToggleRow
            title="Git worktree"
            subtitle="Isolated branch, auto-merges on completion"
            checked={value.useWorktree ?? false}
            onToggle={() => onChange({ useWorktree: !(value.useWorktree ?? false) })}
            disabled={disabled.worktree}
          />
          {value.useWorktree && (
            <input
              type="text"
              value={value.worktreeName ?? ''}
              onChange={e => onChange({ worktreeName: e.target.value })}
              disabled={disabled.worktree}
              placeholder="Branch name..."
              className="w-full text-[10px] font-mono bg-surface-inset border border-primary/20 text-foreground px-2 py-1 outline-none"
            />
          )}
        </div>
      )}
      {show.repl && (
        <TileToggleRow
          title="REPL tool"
          subtitle="JS sandbox for batched tool calls (CLAUDE_CODE_REPL)"
          checked={value.repl ?? false}
          onToggle={() => onChange({ repl: !(value.repl ?? false) })}
          disabled={disabled.repl}
        />
      )}
      {show.bare && (
        <div className="space-y-1.5">
          <TileToggleRow
            title="Bare conversation"
            subtitle="Skip hooks, plugins, CLAUDE.md, auto-memory"
            checked={value.bare ?? false}
            onToggle={() => onChange({ bare: !(value.bare ?? false) })}
            disabled={disabled.bare}
          />
          {value.bare && (
            <div className="text-[10px] font-mono text-amber-400/80 bg-amber-950/20 border border-amber-400/30 rounded px-2 py-1.5 leading-snug">
              <span className="font-bold">warning:</span> --bare uses a separate Claude auth cache and may force a fresh
              login the first time. Plugins, CLAUDE.md and auto-memory are also disabled.
            </div>
          )}
        </div>
      )}
      {show.autoCommit && (
        <TileToggleRow
          title="Auto-commit"
          subtitle="Adds a prompt instruction to commit when the task finishes"
          checked={value.autoCommit ?? false}
          onToggle={() => onChange({ autoCommit: !(value.autoCommit ?? false) })}
          disabled={disabled.autoCommit}
        />
      )}
      {show.leaveRunning && (
        <TileToggleRow
          title="Leave conversation running"
          subtitle="Keep conversation alive after the task completes for follow-up work"
          checked={value.leaveRunning ?? false}
          onToggle={() => onChange({ leaveRunning: !(value.leaveRunning ?? false) })}
          disabled={disabled.leaveRunning}
        />
      )}
      {show.env && (
        <div className="space-y-1">
          <label htmlFor="lcf-env" className="text-[10px] font-mono text-muted-foreground">
            Env (KEY=value per line)
          </label>
          <textarea
            id="lcf-env"
            value={value.envText ?? ''}
            onChange={e => onChange({ envText: e.target.value })}
            disabled={disabled.env}
            rows={3}
            spellCheck={false}
            className={`w-full text-[10px] font-mono bg-surface-inset border text-foreground px-2 py-1 outline-none transition-colors ${
              envErrors.length > 0 ? 'border-red-500/50 focus-visible:border-red-500' : 'border-primary/20'
            }`}
          />
          {envErrors.length > 0 && (
            <div className="text-[10px] font-mono text-red-400 space-y-0.5 pt-0.5">
              {envErrors.map(e => (
                <div key={e}>{e}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
