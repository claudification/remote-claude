/**
 * Canonical spawn diagnostics payload.
 *
 * Shared across the dashboard's "Copy diagnostics" buttons and the
 * `get_spawn_diagnostics` MCP tool. Single JSON shape so diagnostics pasted
 * from either side are interchangeable.
 */

import type { TaskMeta } from './spawn-prompt'
import type { SpawnRequest } from './spawn-schema'

export type DiagnosticsStep = {
  label: string
  status: string
  detail: string | null
  ts: number | null
}

export type DiagnosticsLaunchEvent = {
  step: string
  status: string
  detail: string | null
  t: number
}

export type DiagnosticsSource = 'spawn-dialog' | 'run-task-dialog' | 'mcp'

export type SpawnDiagnostics = {
  type: 'spawn_diagnostics'
  version: 1
  time: string
  source: DiagnosticsSource
  jobId: string | null
  conversationId: string | null
  ccSessionId: string | null
  elapsed: string
  error: string | null
  config: Partial<SpawnRequest>
  steps: DiagnosticsStep[]
  launchEvents: DiagnosticsLaunchEvent[]
  launchState: { completed: boolean; failed: boolean }
  task?: TaskMeta
}

export type BuildDiagnosticsInput = {
  source: DiagnosticsSource
  jobId?: string | null
  conversationId?: string | null
  ccSessionId?: string | null
  elapsedSec: number
  error?: string | null
  config: Partial<SpawnRequest>
  steps: DiagnosticsStep[]
  launchEvents: DiagnosticsLaunchEvent[]
  launchState: { completed: boolean; failed: boolean }
  task?: TaskMeta
}

export const SENSITIVE_DIAG_ENV_KEYS: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'SLACK_TOKEN',
])

function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    out[k] = SENSITIVE_DIAG_ENV_KEYS.has(k) ? '[redacted]' : v
  }
  return out
}

export function buildSpawnDiagnostics(input: BuildDiagnosticsInput): SpawnDiagnostics {
  const config: Partial<SpawnRequest> = { ...input.config }
  if (config.env) {
    config.env = redactEnv(config.env)
  }
  return {
    type: 'spawn_diagnostics',
    version: 1,
    time: new Date().toISOString(),
    source: input.source,
    jobId: input.jobId ?? null,
    conversationId: input.conversationId ?? null,
    ccSessionId: input.ccSessionId ?? null,
    elapsed: `${input.elapsedSec}s`,
    error: input.error ?? null,
    config,
    steps: input.steps,
    launchEvents: input.launchEvents,
    launchState: input.launchState,
    task: input.task,
  }
}
