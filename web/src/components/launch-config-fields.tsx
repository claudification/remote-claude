/**
 * LaunchConfigFields - Controlled form for launch/spawn configuration.
 *
 * Dumb component used by both SpawnDialog and RunTaskDialog. Parents own
 * canonical state. The `show` mask controls which rows render; `disabled`
 * toggles individual fields. No project-settings fetching, no spawn logic.
 */

import { DEFAULT_SENTINEL, EFFORT_OPTIONS, MODEL_OPTIONS, PERMISSION_MODE_OPTIONS } from '@shared/spawn-schema'
import type React from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TileToggleRow } from '@/components/ui/tile-toggle-row'
import { TogglePill } from '@/components/ui/toggle-pill'

export type LaunchFieldKey =
  | 'model'
  | 'effort'
  | 'permissionMode'
  | 'autocompactPct'
  | 'worktree'
  | 'autoCommit'
  | 'leaveRunning'
  | 'maxBudgetUsd'
  | 'timeout'
  | 'name'
  | 'env'

export type LaunchFieldsValue = {
  // Subset of SpawnRequest -- parent owns canonical state
  model?: string
  effort?: string
  permissionMode?: string
  autocompactPct?: number | ''
  maxBudgetUsd?: string
  name?: string
  envText?: string

  // Worktree: split into enable flag + branch name
  useWorktree?: boolean
  worktreeName?: string

  // Prompt-suffix flags (not part of SpawnRequest)
  autoCommit?: boolean
  leaveRunning?: boolean

  // RunTaskDialog-only
  timeout?: string
}

export type LaunchFieldsProps = {
  value: LaunchFieldsValue
  onChange: (patch: Partial<LaunchFieldsValue>) => void
  show?: Partial<Record<LaunchFieldKey, boolean>>
  disabled?: Partial<Record<LaunchFieldKey, boolean>>
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
        {subtitle && <div className="text-[9px] text-[#565f89] mt-0.5 leading-snug">{subtitle}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function LaunchConfigFields({ value, onChange, show = {}, disabled = {} }: LaunchFieldsProps) {
  return (
    <div className="space-y-3">
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
                {MODEL_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value} info={opt.info}>
                    {opt.label}
                  </SelectItem>
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
        <Row
          label="Auto-compact %"
          subtitle="Compact context when usage hits this % of the window"
          htmlFor="lcf-compact"
        >
          <input
            id="lcf-compact"
            type="number"
            min={0}
            max={99}
            value={value.autocompactPct ?? ''}
            onChange={e => onChange({ autocompactPct: e.target.value === '' ? '' : Number(e.target.value) })}
            disabled={disabled.autocompactPct}
            className="w-[80px] text-[10px] font-mono bg-[#1a1b26] border border-[#33467c]/50 text-foreground px-2 py-1 outline-none"
          />
        </Row>
      )}
      {show.maxBudgetUsd && (
        <Row
          label="Max budget USD"
          subtitle="Stop session when spend reaches this (blank = no limit)"
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
            className="w-[100px] text-[10px] font-mono bg-[#1a1b26] border border-[#33467c]/50 text-foreground px-2 py-1 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
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
            className="text-[10px] font-mono bg-[#1a1b26] border border-[#33467c]/50 text-foreground px-2 py-1 outline-none"
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
            className="flex-1 max-w-[220px] text-[10px] font-mono bg-[#1a1b26] border border-[#33467c]/50 text-foreground px-2 py-1 outline-none"
          />
        </Row>
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
              className="w-full text-[10px] font-mono bg-[#1a1b26] border border-[#33467c]/50 text-foreground px-2 py-1 outline-none"
            />
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
          title="Leave session running"
          subtitle="Keep session alive after the task completes for follow-up work"
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
            className="w-full text-[10px] font-mono bg-[#1a1b26] border border-[#33467c]/50 text-foreground px-2 py-1 outline-none"
          />
        </div>
      )}
    </div>
  )
}
