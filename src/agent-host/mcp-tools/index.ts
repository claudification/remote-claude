import { registerConversationTools } from './conversations'
import { registerDialogTool } from './dialog'
import { registerHostTools } from './hosts'
import { registerIdentityTools } from './identity'
import { registerNotifyTools } from './notify'
import { registerProjectBoardTools } from './project-board'
import { registerSpawnTools } from './spawn'
import type { McpToolContext, ToolDef } from './types'

export type {
  AgentHostIdentity,
  ConversationInfo,
  McpChannelCallbacks,
  McpToolContext,
  PendingDialog,
  PermissionRequestData,
  ToolCtx,
  ToolDef,
  ToolResult,
} from './types'

export function registerAllTools(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    ...registerNotifyTools(ctx),
    ...registerIdentityTools(ctx),
    ...registerConversationTools(ctx),
    ...registerSpawnTools(ctx),
    ...registerHostTools(ctx),
    ...registerProjectBoardTools(ctx),
    ...registerDialogTool(ctx),
  }
}
