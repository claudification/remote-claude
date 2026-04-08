/**
 * Handler registry barrel: registers all WS message handlers.
 * Call registerAllHandlers() once at startup before accepting connections.
 */

import { registerAgentHandlers } from './agent'
import { registerChannelHandlers } from './channel'
import { registerDashboardActionHandlers } from './dashboard-actions'
import { registerDialogHandlers } from './dialog'
import { registerFileHandlers } from './files'
import { registerInterSessionHandlers } from './inter-session'
import { registerPermissionHandlers } from './permissions'
import { registerSessionLifecycleHandlers } from './session-lifecycle'
import { registerTerminalHandlers } from './terminal'
import { registerTranscriptHandlers } from './transcript'
import { registerVoiceHandlers } from './voice'

export function registerAllHandlers(): void {
  registerAgentHandlers()
  registerChannelHandlers()
  registerDashboardActionHandlers()
  registerDialogHandlers()
  registerFileHandlers()
  registerInterSessionHandlers()
  registerPermissionHandlers()
  registerSessionLifecycleHandlers()
  registerTerminalHandlers()
  registerTranscriptHandlers()
  registerVoiceHandlers()
}
