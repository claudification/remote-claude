import { debug } from '../debug'
import type { McpToolContext, ToolDef } from './types'

export function registerConversationTools(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    list_conversations: {
      description:
        'List all Claude Code conversations, including this one (marked with `self: true`). Returns a stable addressable ID per conversation in the compound format "project:conversation-name" (e.g. "rclaude:fuzzy-rabbit"). The ID is always compound -- it does NOT change shape when the number of conversations at a cwd grows or shrinks. Each entry also has a "project" field showing the project-level grouping (the bare project slug, useful for grouping but only safe to use as a `to` target when exactly one conversation lives at that cwd). Use the returned `id` for send_message, control_conversation, configure_conversation. Messages to offline conversations are queued for delivery on reconnect. Ad-hoc conversations are hidden unless they have an established link. HINT: When the user says "tell X to Y", "ask X to Y", or "use X to Y", consider that X may be a conversation name -- call list_conversations to check.',
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
        const result = (await ctx.callbacks.onListConversations?.(params.status, showMeta)) || {
          conversations: [],
        }
        let { conversations } = result
        const { self, issues } = result
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
          conversations = conversations.filter(
            s =>
              regex.test(s.name) ||
              (s.title && regex.test(s.title)) ||
              (s.label && regex.test(s.label)) ||
              (s.description && regex.test(s.description)),
          )
        }
        debug(
          `[channel] list_conversations: ${conversations.length} results (metadata=${showMeta}, filter=${params.filter ?? 'none'}, issues=${issues?.length ?? 0})`,
        )
        const hasIssues = issues && issues.length > 0
        const output: unknown = self
          ? { self, conversations, ...(hasIssues ? { issues } : {}) }
          : hasIssues
            ? { conversations, issues }
            : conversations
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] }
      },
    },

    send_message: {
      description:
        'Send a message to one or more other Claude Code sessions. `to` accepts a single target ID (string) OR an array of IDs for multicast -- the same message is fanned out to every recipient and you get back one response with a per-target breakdown (delivered / queued / error). The single `conversation_id` is shared by every recipient so any reply lands in the same thread; use the `from_conversation` field on the incoming reply to disambiguate who answered. Each target MUST be the exact `id` field returned by `list_conversations` -- do not invent, abbreviate, or guess. The canonical form is compound "project:session-name" (e.g. "arr:blazing-igloo"). A bare project slug ("arr") works only when exactly one session lives at that cwd; otherwise the resolver returns "ambiguous" with the compound IDs to retry. Messages to offline sessions are queued and delivered on reconnect. First contact triggers an approval prompt. Multicast cap: 25 targets per call -- split larger fan-outs into batches.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: {
            oneOf: [
              {
                type: 'string',
                description:
                  'Single target session ID. Exact `id` from `list_conversations` (compound "project:session-name", or bare project slug when unambiguous).',
              },
              {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
                maxItems: 25,
                description:
                  'Array of target session IDs for multicast. Each is the exact `id` from `list_conversations`. Returns a per-target results breakdown so you can see which sessions got the message and which were queued/errored.',
              },
            ],
            description:
              'Target session ID or array of IDs. Use a string for one recipient, an array for multicast (max 25). Each ID MUST be the exact `id` field from `list_conversations` output. Do not pass `name`, `title`, `label`, or any other field. When in doubt, call list_conversations first.',
          },
          intent: {
            type: 'string',
            enum: ['request', 'response', 'notify', 'progress'],
            description:
              'Message intent. Optional -- defaults to "response" when `conversation_id` is set (i.e. a reply), otherwise "request".',
          },
          message: { type: 'string', description: 'Message content' },
          context: { type: 'string', description: 'Brief context about what this relates to' },
          conversation_id: {
            type: 'string',
            description:
              'Thread ID for multi-turn exchanges. In multicast, the SAME thread id is used for every recipient -- replies from different recipients will share this id; read the `from_conversation` field on each delivery to tell them apart.',
          },
        },
        required: ['to', 'message'],
      },
      async handle(params) {
        const { to, message, context, conversation_id } = params
        let { intent } = params
        if (to === undefined || to === null || !message) {
          return { content: [{ type: 'text', text: 'Error: to and message are required' }], isError: true }
        }
        const isArrayTarget = Array.isArray(to)
        const targets = (isArrayTarget ? (to as unknown[]) : [to]).filter(
          (t): t is string => typeof t === 'string' && t.length > 0,
        )
        if (targets.length === 0) {
          return {
            content: [{ type: 'text', text: 'Error: to must be a non-empty string or non-empty array of strings' }],
            isError: true,
          }
        }
        if (!intent) {
          intent = conversation_id ? 'response' : 'request'
          debug(`[channel] send_message: intent omitted, defaulted to "${intent}"`)
        }
        const sendTarget = isArrayTarget ? targets : targets[0]
        const result = await ctx.callbacks.onSendMessage?.(sendTarget, intent, message, context, conversation_id)
        if (!result) {
          return { content: [{ type: 'text', text: 'Failed to send message' }], isError: true }
        }

        // Multicast: render per-target breakdown.
        if (isArrayTarget && result.results) {
          const lines: string[] = []
          const delivered = result.results.filter(r => r.ok && r.status === 'delivered')
          const queued = result.results.filter(r => r.ok && r.status === 'queued')
          const failed = result.results.filter(r => !r.ok)
          lines.push(
            `Multicast to ${result.results.length} target(s): ${delivered.length} delivered, ${queued.length} queued, ${failed.length} failed.`,
          )
          if (result.conversationId) lines.push(`conversation_id: ${result.conversationId}`)
          for (const r of result.results) {
            const label = r.ok ? (r.status === 'queued' ? 'queued' : 'delivered') : 'failed'
            const detail = r.error
              ? ` -- ${r.error}`
              : r.targetConversationId
                ? ` (target_conversation_id: ${r.targetConversationId})`
                : ''
            lines.push(`  - ${r.to}: ${label}${detail}`)
          }
          debug(
            `[channel] send_message multicast to ${result.results.length}: ${delivered.length}/${queued.length}/${failed.length} (delivered/queued/failed)`,
          )
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            isError: !result.ok,
          }
        }

        // Single target: flat shape (back-compat).
        if (!result.ok) {
          debug(`[channel] send_message failed: ${result.error}`)
          return { content: [{ type: 'text', text: result.error || 'Failed to send message' }], isError: true }
        }
        debug(`[channel] send_message to ${targets[0]}: ${message.slice(0, 60)}`)
        const status = result.status || 'delivered'
        const statusLabel = status === 'queued' ? 'Queued (target offline, will deliver on reconnect)' : 'Delivered'
        const parts = [statusLabel]
        if (result.conversationId) parts.push(`conversation_id: ${result.conversationId}`)
        if (result.targetConversationId) parts.push(`target_conversation_id: ${result.targetConversationId}`)
        return { content: [{ type: 'text', text: parts.join('. ') }] }
      },
    },

    control_conversation: {
      description:
        "Send a high-level control verb to another conversation's agent host. Unlike send_message (which delivers text to the model's context), control_conversation bypasses the model and tells the agent host itself what to do. Requires benevolent trust. Actions:\n- clear: reset context (headless respawns CC fresh; PTY runs /clear in CC's CLI)\n- quit: graceful shutdown (headless closes stdin; PTY sends SIGTERM)\n- interrupt: cancel the current turn (Ctrl+C equivalent)\n- set_model: switch model (requires `model`, e.g. 'sonnet', 'opus')\n- set_effort: switch thinking-effort level (requires `effort`: low | medium | high | xhigh | max | auto)\n- set_permission_mode: switch permission mode (requires `permissionMode`: plan | acceptEdits | auto | bypassPermissions | default). Headless only -- sends set_permission_mode control_request to CC.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          conversation_id: { type: 'string', description: 'Target ID from list_conversations' },
          action: {
            type: 'string',
            enum: ['clear', 'quit', 'interrupt', 'set_model', 'set_effort', 'set_permission_mode'],
            description: 'Control verb to execute on the target conversation',
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
            description: 'Permission mode. Required when action is "set_permission_mode". Headless conversations only.',
          },
        },
        required: ['conversation_id', 'action'],
      },
      async handle(params) {
        const targetConversationId = params.conversation_id
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
          return { content: [{ type: 'text', text: 'Error: conversation_id is required' }], isError: true }
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
            content: [{ type: 'text', text: 'Error: permissionMode is required when action is "set_permission_mode"' }],
            isError: true,
          }
        }
        const result = await ctx.callbacks.onControlConversation?.({
          conversationId: targetConversationId,
          action,
          model,
          effort,
          permissionMode,
        })
        if (!result?.ok) {
          debug(`[channel] control_conversation(${action}) failed: ${result?.error}`)
          return {
            content: [{ type: 'text', text: result?.error || `Failed to control conversation (${action})` }],
            isError: true,
          }
        }
        debug(
          `[channel] control_conversation(${action}): ${targetConversationId.slice(0, 8)}${model ? ` model=${model}` : ''}${effort ? ` effort=${effort}` : ''}${permissionMode ? ` mode=${permissionMode}` : ''}`,
        )
        const label = result.name || targetConversationId.slice(0, 8)
        const verbText =
          action === 'clear'
            ? `Clear requested on ${label}. Context will reset in a few seconds.`
            : action === 'quit'
              ? `Quit signal sent to ${label}. The conversation will end within a few seconds.`
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

    configure_conversation: {
      description:
        "Update another conversation's project settings: label, icon, color, description, keyterms. Requires benevolent trust level. Cannot change trust/permission levels.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          conversation_id: { type: 'string', description: 'Target ID from list_conversations' },
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
        required: ['conversation_id'],
      },
      async handle(params) {
        const targetConversationId = params.conversation_id
        if (!targetConversationId)
          return { content: [{ type: 'text', text: 'Error: conversation_id is required' }], isError: true }
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
          debug(`[channel] configure_conversation failed: ${result?.error}`)
          return {
            content: [{ type: 'text', text: result?.error || 'Failed to configure conversation' }],
            isError: true,
          }
        }
        debug(`[channel] configure_conversation: ${targetConversationId.slice(0, 8)} ${Object.keys(update).join(',')}`)
        return {
          content: [{ type: 'text', text: `Conversation configured: ${Object.keys(update).join(', ')} updated` }],
        }
      },
    },

    rename_conversation: {
      description:
        'Rename the current conversation and/or set its description. The title is visible in the control panel sidebar. Use slug-formatted names for consistency (e.g. "refactor-auth-middleware"). Pass empty name to clear and revert to auto-generated name. Description is a short line shown in sidebar and list_conversations -- use it to explain what this conversation is working on.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: {
            type: 'string',
            description: 'New conversation name/title. Empty string clears user-set name.',
          },
          description: {
            type: 'string',
            description:
              'Short description of what this conversation is working on. Shown in control panel and list_conversations. Empty string clears.',
          },
        },
        required: ['name'],
      },
      async handle(params) {
        const newName = typeof params.name === 'string' ? params.name : ''
        const newDesc = typeof params.description === 'string' ? params.description : undefined
        const result = await ctx.callbacks.onRenameConversation?.(newName, newDesc)
        if (!result?.ok) {
          debug(`[channel] rename_conversation failed: ${result?.error}`)
          return {
            content: [{ type: 'text', text: result?.error || 'Failed to rename conversation' }],
            isError: true,
          }
        }
        const label = newName || '(auto)'
        debug(`[channel] rename_conversation: "${label}"${newDesc ? ` desc="${newDesc}"` : ''}`)
        return { content: [{ type: 'text', text: `Conversation renamed to "${label}"` }] }
      },
    },

    exit_conversation: {
      description:
        'Terminate the current conversation. Emits a lifecycle event, sends end-of-conversation to the broker, and exits the process. Use when your work is done and you want to clean up. The MCP response may not arrive back (the process exits immediately after).',
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
        debug(`[channel] exit_conversation: status=${status} message=${message || '(none)'}`)
        ctx.callbacks.onExitConversation?.(status, message)
        return { content: [{ type: 'text', text: `Conversation exiting (${status})` }] }
      },
    },
  }
}
