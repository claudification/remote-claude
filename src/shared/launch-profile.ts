/**
 * Launch Profile -- a named bundle of spawn defaults the user can fire
 * via chord (Cmd+J) or palette or the spawn dialog dropdown.
 *
 * Consumers:
 * - Broker storage:  src/broker/launch-profiles/
 * - HTTP routes:     src/broker/launch-profiles/routes.ts
 * - Spawn resolver:  src/shared/spawn-defaults.ts (profile tier)
 * - Control panel:   web/src/components/launch-profiles/
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { spawnRequestSchema } from './spawn-schema'

export const LAUNCH_PROFILE_ID_PREFIX = 'lp_'
export const LAUNCH_PROFILE_MAX_APPEND_SP = 16 * 1024
export const LAUNCH_PROFILE_MAX_COUNT = 50

const MAX_NAME = 64
const MAX_SHORT_LABEL = 24

export const BACKENDS_WITH_APPEND_SYSTEM_PROMPT = ['claude', 'chat-api'] as const

export function backendSupportsAppendSystemPrompt(backend: string | undefined): boolean {
  if (!backend) return true
  return (BACKENDS_WITH_APPEND_SYSTEM_PROMPT as readonly string[]).includes(backend)
}

const PROFILE_COLOR_OPTIONS = ['primary', 'success', 'warning', 'destructive', 'info', 'muted'] as const

const profileSpawnSchema = spawnRequestSchema
  .omit({ cwd: true, jobId: true })
  .extend({
    appendSystemPrompt: z.string().max(LAUNCH_PROFILE_MAX_APPEND_SP, 'appendSystemPrompt exceeds 16 KB cap').optional(),
  })
  .partial()

export const launchProfileSchema = z.object({
  id: z.string().startsWith(LAUNCH_PROFILE_ID_PREFIX),
  name: z.string().min(1, 'name is required').max(MAX_NAME),
  shortLabel: z.string().max(MAX_SHORT_LABEL).optional(),
  icon: z.string().max(64).optional(),
  color: z.enum(PROFILE_COLOR_OPTIONS).optional(),
  order: z.number().int().optional(),

  chord: z.string().max(32).optional(),
  immediate: z.boolean().optional(),

  sentinel: z.string().max(128).optional(),
  project: z.string().max(2048).optional(),

  spawn: profileSpawnSchema,

  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),

  lastUsedAt: z.number().int().nonnegative().optional(),
  useCount: z.number().int().nonnegative().optional(),
})
export type LaunchProfile = z.infer<typeof launchProfileSchema>

export const launchProfileListSchema = z
  .array(launchProfileSchema)
  .max(LAUNCH_PROFILE_MAX_COUNT, `at most ${LAUNCH_PROFILE_MAX_COUNT} profiles`)

export function newLaunchProfileId(): string {
  return `${LAUNCH_PROFILE_ID_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

export function isLaunchProfileId(id: unknown): id is string {
  return (
    typeof id === 'string' && id.startsWith(LAUNCH_PROFILE_ID_PREFIX) && id.length > LAUNCH_PROFILE_ID_PREFIX.length
  )
}
