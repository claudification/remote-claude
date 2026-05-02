/**
 * Single source of truth for spawn requests.
 *
 * Consumers:
 * - HTTP route: src/broker/routes.ts (/api/spawn)
 * - MCP tool: src/agent-host/mcp-channel.ts (spawn_session)
 * - Dashboard: web/src/components/spawn-dialog.tsx
 * - Dashboard: web/src/components/project-board.tsx (RunTaskDialog)
 */

import { z } from 'zod'
import { ALL_CC_SLUGS, DROPDOWN_MODEL_ENTRIES } from './models'

export const DEFAULT_SENTINEL = '__default__'

type ModelOption = { value: string; label: string; info: string }
export type ModelOptionGroup = { group: string; options: ModelOption[] }

export const MODEL_OPTION_GROUPS: ModelOptionGroup[] = (() => {
  const current: ModelOption[] = []
  const previous: ModelOption[] = []
  const legacy: ModelOption[] = []

  for (const m of DROPDOWN_MODEL_ENTRIES) {
    const opt = { value: m.id, label: m.label, info: m.info }
    if (m.id.startsWith('claude-3-')) legacy.push(opt)
    else if (/claude-(opus|sonnet)-4-[0-5]/.test(m.id)) previous.push(opt)
    else current.push(opt)
  }

  const groups: ModelOptionGroup[] = [{ group: 'Current', options: current }]
  if (previous.length > 0) groups.push({ group: 'Previous', options: previous })
  if (legacy.length > 0) groups.push({ group: 'Legacy', options: legacy })
  return groups
})()

/** Flat list for backwards compat -- includes Default sentinel. */
export const MODEL_OPTIONS = [
  { value: DEFAULT_SENTINEL, label: 'Default', info: 'Use project / global default' },
  ...DROPDOWN_MODEL_ENTRIES.map(m => ({ value: m.id, label: m.label, info: m.info })),
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

// Accept any slug CC recognizes. The full list lives in CC_MODELS (models.ts).
// dispatchSpawn does the real validation with a helpful error listing valid models.
export const modelEnum = z.enum(ALL_CC_SLUGS as unknown as [string, ...string[]])
export const effortEnum = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export const permissionModeEnum = z.enum(['plan', 'acceptEdits', 'auto', 'bypassPermissions'])
export const spawnModeEnum = z.enum(['fresh', 'resume'])

export const spawnRequestSchema = z.object({
  cwd: z
    .string()
    .min(1, 'cwd is required')
    .describe(
      'Working directory. Absolute (/…), ~-relative (~/…), or relative — relative paths resolve against agent spawnRoot ($HOME by default).',
    ),
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
  description: z
    .string()
    .optional()
    .describe('Short description of what this conversation is about. Shown in dashboard and list_sessions.'),
  model: modelEnum.optional().describe('Model preset or pinned version'),
  effort: effortEnum.optional().describe('Thinking effort budget'),
  permissionMode: permissionModeEnum.optional().describe('CC permission prompting mode'),
  autocompactPct: z.number().min(0).max(100).optional().describe('Auto-compact threshold (%)'),
  maxBudgetUsd: z.number().positive().optional().describe('Max spend in USD before auto-stop'),
  includePartialMessages: z
    .boolean()
    .optional()
    .describe('Include partial message chunks (token streaming). Default: true for normal, false for ad-hoc'),
  agent: z.string().optional().describe('Agent name (passed as --agent to claude CLI)'),
  worktree: z.string().optional().describe('Branch name - creates isolated git worktree'),
  env: z.record(z.string(), z.string()).optional().describe('Env var overrides'),
  prompt: z.string().optional().describe('Initial prompt (headless only)'),
  adHoc: z.boolean().optional().describe('Mark as ad-hoc task runner session'),
  adHocTaskId: z.string().optional().describe('Project task slug when adHoc=true'),
  leaveRunning: z
    .boolean()
    .optional()
    .describe('Keep session running after prompt completes (only applies when adHoc=true, ignored otherwise)'),
  sentinel: z.string().optional().describe('Target sentinel alias for spawn routing. Default sentinel if omitted.'),
  jobId: z.string().uuid().optional().describe('Caller-supplied job id for progress correlation'),
})
export type SpawnRequest = z.infer<typeof spawnRequestSchema>
