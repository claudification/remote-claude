import { debug } from '../debug'
import type { McpToolContext, ToolDef } from './types'

export function registerConversationTools(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    list_conversations: {
      description:
        'List other Claude Code conversations. Returns a stable addressable ID per conversation in the compound format "project:conversation-name" (e.g. "rclaude:fuzzy-rabbit"). The ID is always compound -- it does NOT change shape when the number of conversations at a cwd grows or shrinks. Each entry also has a "project" field showing the project-level grouping (the bare project slug, useful for grouping but only safe to use as a `to` target when exactly one conversation lives at that cwd). Use the returned `id` for send_message, control_session, configure_session. Messages to offline conversations are queued for delivery on reconnect. Ad-hoc conversations are hidden unless they have an established link. HINT: When the user says "tell X to Y", "ask X to Y", or "use X to Y", consider that X may be a conversation name -- call list_conversations to check.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['live', 'inactive', 'all'],
            description: 'Filter by status (default: live)',
          },
          filter: {
            type: 'string',
            description:
              'Optional glob pattern to filter sessions by name/label (case-insensitive). Supports * (any chars) and ? (single char). Example: "agent-*" or "*drop*".',
          },
          show_metadata: {
            type: 'boolean',
            description:
              'Include project metadata (icon, color, keyterms) in response. Only available for benevolent sessions.',
          },
        },
      },
      async handle(params) {
        const showMeta = String(params.show_metadata) === 'true'
        const result = (await ctx.callbacks.onListConversations?.(params.status, showMeta)) || { sessions: [] }
        let { sessions } = result
        const { self } = result
        if (params.filter) {
          const pattern = String(params.filter)
          const regex = new RegExp(
            `^${pattern
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*\*/g, '.*')
              .replace(/\*/g, '.*')
              .replace(/\?/g, '.')}$`,
            'i',
          )
          sessions = sessions.filter(
            s =>
              regex.test(s.name) ||
              (s.title && regex.test(s.title)) ||
              (s.label && regex.test(s.label)) ||
              (s.description && regex.test(s.description)),
          )
        }
        debug(
          `[channel] list_conversations: ${sessions.length} results (metadata=${showMeta}, filter=${params.filter ?? 'none'})`,
        )
        const output = self ? { self, sessions } : sessions
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] }
      },
    },

    send_message: {
      description:
        'Send a message to another Claude Code session. The `to` parameter MUST be the exact `id` field returned by `list_conversations` -- do not invent, abbreviate, or guess. The canonical form is compound "project:session-name" (e.g. "arr:blazing-igloo") and is ALWAYS accepted. A bare project slug (e.g. "arr") is also accepted ONLY when exactly one session lives at that cwd; if two or more sessions share the project, the bare form is rejected as ambiguous and the error lists the compound IDs to retry with. Always call `list_conversations` first if you are not certain. Messages to offline sessions are queued and delivered on reconnect. Returns status: "delivered" or "queued". First contact triggers an approval prompt. Include conversation_id in replies to maintain thread context.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: {
            type: 'string',
            description:
              'Target session ID. MUST be the exact `id` field from `list_conversations` output (always compound "project:session-name", e.g. "arr:blazing-igloo"). A bare project slug ("arr") is also accepted but only when one session lives at that cwd -- otherwise the resolver returns an "ambiguous" error listing the compound IDs to retry with. Do not pass the `name`, `title`, `label`, or any other field -- only `id`. When in doubt, call list_conversations first.',
          },
          intent: {
            type: 'string',
            enum: ['request', 'response', 'notify', 'progress'],
            description:
              'Message intent. Optional -- defaults to "response" when `conversation_id` is set (i.e. a reply), otherwise "request".',
          },
          message: { type: 'string', description: 'Message content' },
          context: { type: 'string', description: 'Brief context about what this relates to' },
          conversation_id: { type: 'string', description: 'Thread ID for multi-turn exchanges' },
        },
        required: ['to', 'message'],
      },
      async handle(params) {
        const { to, message, context, conversation_id } = params
        let { intent } = params
        if (!to || !message) {
          return { content: [{ type: 'text', text: 'Error: to and message are required' }], isError: true }
        }
        if (!intent) {
          intent = conversation_id ? 'response' : 'request'
          debug(`[channel] send_message: intent omitted, defaulted to "${intent}"`)
        }
        const result = await ctx.callbacks.onSendMessage?.(to, intent, message, context, conversation_id)
        if (!result?.ok) {
          debug(`[channel] send_message failed: ${result?.error}`)
          return { content: [{ type: 'text', text: result?.error || 'Failed to send message' }], isError: true }
        }
        debug(`[channel] send_message to ${to}: ${message.slice(0, 60)}`)
        const status = (result as Record<string, unknown>).status || 'delivered'
        const statusLabel = status === 'queued' ? 'Queued (target offline, will deliver on reconnect)' : 'Delivered'
        const parts = [statusLabel]
        if (result.conversationId) parts.push(`conversation_id: ${result.conversationId}`)
        if (result.targetSessionId) parts.push(`target_session_id: ${result.targetSessionId}`)
        return { content: [{ type: 'text', text: parts.join('. ') }] }
      },
    },

    control_session: {
      description:
        "Send a high-level control verb to another session's wrapper. Unlike send_message (which delivers text to the model's context), control_session bypasses the model and tells the wrapper itself what to do. Requires benevolent trust. Actions:\n- clear: reset context (headless respawns CC fresh; PTY runs /clear in CC's CLI)\n- quit: graceful shutdown (headless closes stdin; PTY sends SIGTERM)\n- interrupt: cancel the current turn (Ctrl+C equivalent)\n- set_model: switch model (requires `model`, e.g. 'sonnet', 'opus')\n- set_effort: switch thinking-effort level (requires `effort`: low | medium | high | xhigh | max | auto)\n- set_permission_mode: switch permission mode (requires `permissionMode`: plan | acceptEdits | auto | bypassPermissions | default). Headless only -- sends set_permission_mode control_request to CC.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Target ID from list_conversations' },
          action: {
            type: 'string',
            enum: ['clear', 'quit', 'interrupt', 'set_model', 'set_effort', 'set_permission_mode'],
            description: 'Control verb to execute on the target session',
          },
          model: {
            type: 'string',
            description: 'Model name/alias (e.g. "sonnet", "opus"). Required when action is "set_model".',
          },
          effort: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
            description: 'Effort level. Required when action is "set_effort". `auto` resets to model default.',
          },
          permissionMode: {
            type: 'string',
            enum: ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions'],
            description: 'Permission mode. Required when action is "set_permission_mode". Headless sessions only.',
          },
        },
        required: ['session_id', 'action'],
      },
      async handle(params) {
        const targetConversationId = params.session_id
        const action = params.action as
          | 'clear'
          | 'quit'
          | 'interrupt'
          | 'set_model'
          | 'set_effort'
          | 'set_permission_mode'
        const model = typeof params.model === 'string' ? params.model : undefined
        const effort = typeof params.effort === 'string' ? params.effort : undefined
        const permissionMode = typeof params.permissionMode === 'string' ? params.permissionMode : undefined
        if (!targetConversationId)
          return { content: [{ type: 'text', text: 'Error: session_id is required' }], isError: true }
        if (
          !action ||
          !['clear', 'quit', 'interrupt', 'set_model', 'set_effort', 'set_permission_mode'].includes(action)
        ) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: action must be one of clear | quit | interrupt | set_model | set_effort | set_permission_mode',
              },
            ],
            isError: true,
          }
        }
        if (action === 'set_model' && !model) {
          return {
            content: [{ type: 'text', text: 'Error: model is required when action is "set_model"' }],
            isError: true,
          }
        }
        if (action === 'set_effort' && !effort) {
          return {
            content: [{ type: 'text', text: 'Error: effort is required when action is "set_effort"' }],
            isError: true,
          }
        }
        if (action === 'set_permission_mode' && !permissionMode) {
          return {
            content: [
              { type: 'text', text: 'Error: permissionMode is required when action is "set_permission_mode"' },
            ],
            isError: true,
          }
        }
        const result = await ctx.callbacks.onControlSession?.({
          conversationId: targetConversationId,
          action,
          model,
          effort,
          permissionMode,
        })
        if (!result?.ok) {
          debug(`[channel] control_session(${action}) failed: ${result?.error}`)
          return {
            content: [{ type: 'text', text: result?.error || `Failed to control session (${action})` }],
            isError: true,
          }
        }
        debug(
          `[channel] control_session(${action}): ${targetConversationId.slice(0, 8)}${model ? ` model=${model}` : ''}${effort ? ` effort=${effort}` : ''}${permissionMode ? ` mode=${permissionMode}` : ''}`,
        )
        const label = result.name || targetConversationId.slice(0, 8)
        const verbText =
          action === 'clear'
            ? `Clear requested on ${label}. Context will reset in a few seconds.`
            : action === 'quit'
              ? `Quit signal sent to ${label}. The session will end within a few seconds.`
              : action === 'interrupt'
                ? `Interrupt sent to ${label}. Current turn will stop.`
                : action === 'set_model'
                  ? `Model switch requested on ${label} -> ${model}.`
                  : action === 'set_effort'
                    ? `Effort level switch requested on ${label} -> ${effort}.`
                    : `Permission mode switch requested on ${label} -> ${permissionMode}.`
        return { content: [{ type: 'text', text: verbText }] }
      },
    },

    configure_session: {
      description:
        "Update another session's project settings: label, icon, color, description, keyterms. Requires benevolent trust level. Cannot change trust/permission levels.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Target ID from list_conversations' },
          label: { type: 'string', description: 'Display name for the project' },
          icon: { type: 'string', description: 'Lucide icon ID (e.g. "rocket", "database", "globe")' },
          color: { type: 'string', description: 'Hex color (e.g. "#ff6600")' },
          description: { type: 'string', description: 'Project description for routing context' },
          keyterms: {
            type: 'array',
            items: { type: 'string' },
            description: 'Keywords for project search/categorization',
          },
        },
        required: ['session_id'],
      },
      async handle(params) {
        const targetConversationId = params.session_id
        if (!targetConversationId)
          return { content: [{ type: 'text', text: 'Error: session_id is required' }], isError: true }
        const update: Record<string, unknown> = {}
        if (params.label !== undefined) update.label = params.label
        if (params.icon !== undefined) update.icon = params.icon
        if (params.color !== undefined) update.color = params.color
        if (params.description !== undefined) update.description = params.description
        if (params.keyterms !== undefined) update.keyterms = params.keyterms
        if (Object.keys(update).length === 0) {
          return { content: [{ type: 'text', text: 'Error: at least one setting is required' }], isError: true }
        }
        const result = await ctx.callbacks.onConfigureConversation?.({
          conversationId: targetConversationId,
          ...update,
        } as Parameters<NonNullable<typeof ctx.callbacks.onConfigureConversation>>[0])
        if (!result?.ok) {
          debug(`[channel] configure_session failed: ${result?.error}`)
          return {
            content: [{ type: 'text', text: result?.error || 'Failed to configure session' }],
            isError: true,
          }
        }
        debug(`[channel] configure_session: ${targetConversationId.slice(0, 8)} ${Object.keys(update).join(',')}`)
        return { content: [{ type: 'text', text: `Session configured: ${Object.keys(update).join(', ')} updated` }] }
      },
    },

    rename_session: {
      description:
        'Rename the current session and/or set its description. The title is visible in the dashboard sidebar. Use slug-formatted names for consistency (e.g. "refactor-auth-middleware"). Pass empty name to clear and revert to auto-generated name. Description is a short line shown in sidebar and list_conversations -- use it to explain what this session is working on.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: {
            type: 'string',
            description: 'New session name/title. Empty string clears user-set name.',
          },
          description: {
            type: 'string',
            description:
              'Short description of what this session is working on. Shown in dashboard and list_conversations. Empty string clears.',
          },
        },
        required: ['name'],
      },
      async handle(params) {
        const newName = typeof params.name === 'string' ? params.name : ''
        const newDesc = typeof params.description === 'string' ? params.description : undefined
        const result = await ctx.callbacks.onRenameConversation?.(newName, newDesc)
        if (!result?.ok) {
          debug(`[channel] rename_session failed: ${result?.error}`)
          return {
            content: [{ type: 'text', text: result?.error || 'Failed to rename session' }],
            isError: true,
          }
        }
        const label = newName || '(auto)'
        debug(`[channel] rename_session: "${label}"${newDesc ? ` desc="${newDesc}"` : ''}`)
        return { content: [{ type: 'text', text: `Session renamed to "${label}"` }] }
      },
    },

    exit_session: {
      description:
        'Terminate the current session. Emits a lifecycle event, sends session end to the broker, and exits the process. Use when your work is done and you want to clean up. The MCP response may not arrive back (the process exits immediately after).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['success', 'error'],
            description: 'Exit status (default: success)',
          },
          message: {
            type: 'string',
            description: 'Reason for exiting (shown in transcript timeline)',
          },
        },
      },
      async handle(params) {
        const status = (params.status as 'success' | 'error') || 'success'
        const message = typeof params.message === 'string' ? params.message : undefined
        debug(`[channel] exit_session: status=${status} message=${message || '(none)'}`)
        ctx.callbacks.onExitConversation?.(status, message)
        return { content: [{ type: 'text', text: `Session exiting (${status})` }] }
      },
    },
  }
}
