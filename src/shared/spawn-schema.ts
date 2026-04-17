/**
 * Single source of truth for spawn requests.
 *
 * Consumers:
 * - HTTP route: src/concentrator/routes.ts (/api/spawn)
 * - MCP tool: src/wrapper/mcp-channel.ts (spawn_session)
 * - Dashboard: web/src/components/spawn-dialog.tsx
 * - Dashboard: web/src/components/project-board.tsx (RunTaskDialog)
 */

import { z } from 'zod'

export const DEFAULT_SENTINEL = '__default__'

export const MODEL_OPTIONS = [
  { value: DEFAULT_SENTINEL, label: 'Default', info: 'Use project / global default' },
  { value: 'opus', label: 'Opus (latest)', info: 'Most capable, best for complex reasoning' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7', info: 'Opus 4.7 pinned (1M context)' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', info: 'Opus 4.6 pinned (1M context)' },
  { value: 'sonnet', label: 'Sonnet (latest)', info: 'Balanced speed and capability' },
  { value: 'haiku', label: 'Haiku (latest)', info: 'Fastest, lowest cost' },
] as const

export const EFFORT_OPTIONS = [
  { value: DEFAULT_SENTINEL, label: 'Default', info: 'Use project / global default' },
  { value: 'low', label: 'Low', info: 'Minimal thinking budget' },
  { value: 'medium', label: 'Medium', info: 'Moderate thinking' },
  { value: 'high', label: 'High', info: 'Deep thinking (slower)' },
  { value: 'xhigh', label: 'XHigh', info: 'Extended deep thinking' },
  { value: 'max', label: 'Max', info: 'Maximum thinking budget' },
] as const

export const PERMISSION_MODE_OPTIONS = [
  { value: DEFAULT_SENTINEL, label: 'Default', info: 'CC default prompting behaviour' },
  { value: 'plan', label: 'Plan', info: 'Plan-first mode' },
  { value: 'acceptEdits', label: 'Accept Edits', info: 'Auto-accept file edits' },
  { value: 'auto', label: 'Auto', info: 'Auto-approve most tools' },
  { value: 'bypassPermissions', label: 'Bypass', info: 'Skip permission prompts (dangerous)' },
] as const

// Keep TIMEOUT_OPTIONS simple; used only by RunTaskDialog today
export const TIMEOUT_OPTIONS = [
  { value: '5', label: '5 min' },
  { value: '10', label: '10 min' },
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '0', label: 'No timeout' },
] as const

export const modelEnum = z.enum(['opus', 'sonnet', 'haiku', 'claude-opus-4-7', 'claude-opus-4-6'])
export const effortEnum = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export const permissionModeEnum = z.enum(['plan', 'acceptEdits', 'auto', 'bypassPermissions'])
export const spawnModeEnum = z.enum(['fresh', 'resume'])

export const spawnRequestSchema = z.object({
  cwd: z.string().describe('Working directory (absolute path, ~ supported)'),
  mkdir: z.boolean().optional().describe('Create cwd if it does not exist'),
  mode: spawnModeEnum.optional().describe('"fresh" (default) or "resume" to resume a specific CC session'),
  resumeId: z.string().optional().describe('Claude Code session ID to resume when mode=resume'),
  headless: z
    .boolean()
    .optional()
    .describe('stream-json mode. Default: true for ad-hoc, otherwise project/global default'),
  bare: z.boolean().optional().describe('Launch without injecting hooks'),
  repl: z.boolean().optional().describe('Launch CC in REPL mode'),
  name: z.string().optional().describe('Display label in sidebar'),
  model: modelEnum.optional().describe('Model preset or pinned version'),
  effort: effortEnum.optional().describe('Thinking effort budget'),
  permissionMode: permissionModeEnum.optional().describe('CC permission prompting mode'),
  autocompactPct: z.number().min(0).max(100).optional().describe('Auto-compact threshold (%)'),
  maxBudgetUsd: z.number().positive().optional().describe('Max spend in USD before auto-stop'),
  worktree: z.string().optional().describe('Branch name - creates isolated git worktree'),
  env: z.record(z.string(), z.string()).optional().describe('Env var overrides'),
  prompt: z.string().optional().describe('Initial prompt (headless only)'),
  adHoc: z.boolean().optional().describe('Mark as ad-hoc task runner session'),
  adHocTaskId: z.string().optional().describe('Project task slug when adHoc=true'),
  leaveRunning: z.boolean().optional().describe('Keep session running after prompt completes'),
  jobId: z.string().uuid().optional().describe('Caller-supplied job id for progress correlation'),
})
export type SpawnRequest = z.infer<typeof spawnRequestSchema>
