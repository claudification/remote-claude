/**
 * Handler registry barrel: registers all WS message handlers.
 * Call registerAllHandlers() once at startup before accepting connections.
 */

import { registerBootLifecycleHandlers } from './boot-lifecycle'
import { registerChannelHandlers } from './channel'
import { registerDashboardActionHandlers } from './control-panel-actions'
import { registerConversationLifecycleHandlers } from './conversation-lifecycle'
import { registerDialogHandlers } from './dialog'
import { registerFileHandlers } from './files'
import { registerInterConversationHandlers } from './inter-conversation'
import { registerJsonStreamHandlers } from './json-stream'
import { registerPermissionHandlers } from './permissions'
import { registerPlanApprovalHandlers } from './plan-approval'
import { registerRclaudeConfigHandlers } from './rclaude-config'
import { registerSentinelHandlers } from './sentinel'
import { registerSpawnHandlers } from './spawn'
import { registerTerminalHandlers } from './terminal'
import { registerTranscriptHandlers } from './transcript'
import { registerVoiceHandlers } from './voice'

export function registerAllHandlers(): void {
  registerSentinelHandlers()
  registerBootLifecycleHandlers()
  registerChannelHandlers()
  registerDashboardActionHandlers()
  registerDialogHandlers()
  registerFileHandlers()
  registerInterConversationHandlers()
  registerJsonStreamHandlers()
  registerPermissionHandlers()
  registerPlanApprovalHandlers()
  registerRclaudeConfigHandlers()
  registerConversationLifecycleHandlers()
  registerSpawnHandlers()
  registerTerminalHandlers()
  registerTranscriptHandlers()
  registerVoiceHandlers()
}
