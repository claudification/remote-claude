import { debug } from '../debug'
import type { McpToolContext, ToolDef } from './types'

export function registerHostTools(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    list_hosts: {
      description:
        'List connected sentinel hosts. Each sentinel is a machine that can spawn sessions. Use the alias as the `host` parameter in spawn_session to target a specific machine.',
      inputSchema: { type: 'object' as const, properties: {} },
      async handle() {
        const result = (await ctx.callbacks.onListHosts?.()) || []
        debug(`[channel] list_hosts: ${result.length} hosts`)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    },

    get_spawn_diagnostics: {
      description:
        'Fetch a diagnostic snapshot for a spawn job by jobId. Returns the resolved config, the full event timeline (job_created, spawn_sent, agent_acked, wrapper_booted, session_connected, job_complete/job_failed), and any error. Use this to debug spawn failures after spawn_session returned a conversationId but the session never connected. Jobs expire ~5 minutes after creation. The jobId is returned in every spawn_session response.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          job_id: {
            type: 'string',
            description: 'The jobId returned by a prior spawn_session call (or any spawn dispatch).',
          },
        },
        required: ['job_id'],
      },
      async handle(params) {
        const jobId = typeof params.job_id === 'string' ? params.job_id.trim() : ''
        if (!jobId) {
          return {
            content: [{ type: 'text', text: 'Error: job_id is required' }],
            isError: true,
          }
        }
        if (!ctx.callbacks.onGetSpawnDiagnostics) {
          return {
            content: [{ type: 'text', text: 'Error: diagnostics channel not available' }],
            isError: true,
          }
        }
        const result = await ctx.callbacks.onGetSpawnDiagnostics(jobId)
        if (!result.ok) {
          debug(`[channel] get_spawn_diagnostics(${jobId.slice(0, 8)}) failed: ${result.error}`)
          return {
            content: [{ type: 'text', text: result.error || 'Diagnostics unavailable' }],
            isError: true,
          }
        }
        debug(`[channel] get_spawn_diagnostics(${jobId.slice(0, 8)}): ok`)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result.diagnostics, null, 2),
            },
          ],
        }
      },
    },
  }
}
