import { debug } from '../debug'
import type { McpToolContext, ToolDef } from './types'

export function registerNotifyTools(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    notify: {
      description:
        "Send a push notification to the user's devices (phone, browser). Use for important alerts that need attention even when the dashboard is not in focus.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          message: { type: 'string', description: 'Notification body text' },
          title: { type: 'string', description: 'Optional notification title' },
        },
        required: ['message'],
      },
      async handle(params) {
        const message = params.message
        const title = params.title
        if (!message) return { content: [{ type: 'text', text: 'Error: message is required' }], isError: true }
        ctx.callbacks.onNotify?.(message, title)
        debug(`[channel] notify: ${message.slice(0, 80)}`)
        return { content: [{ type: 'text', text: 'Notification sent' }] }
      },
    },

    share_file: {
      description:
        'Upload a local file to the rclaude broker and get a public URL back. For images use ![description](url), for other files use [filename](url). Works for images, screenshots, build artifacts, logs, or any file.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the local file to share' },
        },
        required: ['file_path'],
      },
      async handle(params) {
        const filePath = params.file_path
        if (!filePath) return { content: [{ type: 'text', text: 'Error: file_path is required' }], isError: true }
        const url = await ctx.callbacks.onShareFile?.(filePath)
        if (!url) return { content: [{ type: 'text', text: `Failed to upload ${filePath}` }], isError: true }
        debug(`[channel] share_file: ${filePath} -> ${url}`)
        return { content: [{ type: 'text', text: url }] }
      },
    },

    toggle_plan_mode: {
      description:
        'Toggle plan mode via the terminal session. Use as a fallback when ExitPlanMode is not available. The toggle takes effect after your current response completes.',
      inputSchema: { type: 'object' as const, properties: {} },
      async handle() {
        ctx.callbacks.onTogglePlanMode?.()
        return { content: [{ type: 'text', text: 'Plan mode toggle sent via PTY.' }] }
      },
    },
  }
}
