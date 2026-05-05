import type { DialogLayout, DialogResult } from '../../shared/dialog-schema'
import type { SpawnRequest } from '../../shared/spawn-schema'

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export interface ToolCtx {
  progressToken?: string | number
  rawArgs: unknown
  extra: unknown
}

export interface ToolDef {
  description: string
  inputSchema: unknown
  hidden?: boolean
  handle: (params: Record<string, string>, ctx: ToolCtx) => Promise<ToolResult>
}

export interface PendingDialog {
  resolve: (result: DialogResult) => void
  timer: ReturnType<typeof setTimeout>
  timeoutMs: number
  deadline: number
}

export interface ConversationInfo {
  id: string
  project: string
  session_id?: string
  name: string
  status: 'live' | 'inactive'
  ccSessionIds?: string[]
  label?: string
  description?: string
  title?: string
  summary?: string
}

export interface AgentHostIdentity {
  ccSessionId: string
  conversationId: string
  cwd: string
  configuredModel?: string
  headless: boolean
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
}

// fallow-ignore-next-line duplicate-export
export interface PermissionRequestData {
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}

export interface McpChannelCallbacks {
  onNotify?: (message: string, title?: string) => void
  onShareFile?: (filePath: string) => Promise<string | null>
  onListConversations?: (
    status?: string,
    showMetadata?: boolean,
  ) => Promise<{ sessions: ConversationInfo[]; self?: Record<string, unknown> }>
  onSendMessage?: (
    to: string,
    intent: string,
    message: string,
    context?: string,
    conversationId?: string,
  ) => Promise<{ ok: boolean; error?: string; conversationId?: string; targetSessionId?: string }>
  onPermissionRequest?: (data: PermissionRequestData) => void
  onDisconnect?: () => void
  onTogglePlanMode?: () => void
  onReviveConversation?: (conversationId: string) => Promise<{ ok: boolean; error?: string; name?: string }>
  onControlSession?: (params: {
    conversationId: string
    action: 'clear' | 'quit' | 'interrupt' | 'set_model' | 'set_effort' | 'set_permission_mode'
    model?: string
    effort?: string
    permissionMode?: string
  }) => Promise<{ ok: boolean; error?: string; name?: string }>
  onRestartConversation?: (conversationId: string) => Promise<{
    ok: boolean
    error?: string
    name?: string
    selfRestart?: boolean
    alreadyEnded?: boolean
  }>
  onSpawnConversation?: (
    params: Omit<SpawnRequest, 'jobId'> & {
      onProgress?: (event: Record<string, unknown>) => void
    },
  ) => Promise<{ ok: boolean; error?: string; conversationId?: string; jobId?: string }>
  onListHosts?: () => Promise<Array<{ alias: string; hostname?: string; connected: boolean; sessionCount: number }>>
  onGetSpawnDiagnostics?: (
    jobId: string,
  ) => Promise<{ ok: boolean; error?: string; diagnostics?: Record<string, unknown> }>
  onConfigureConversation?: (params: {
    conversationId: string
    label?: string
    icon?: string
    color?: string
    description?: string
    keyterms?: string[]
  }) => Promise<{ ok: boolean; error?: string }>
  onDialogShow?: (dialogId: string, layout: DialogLayout) => void
  onDialogDismiss?: (dialogId: string) => void
  onDeliverMessage?: (content: string, meta: Record<string, string>) => void
  onRenameConversation?: (name: string, description?: string) => Promise<{ ok: boolean; error?: string }>
  onProjectChanged?: () => void
  onExitConversation?: (status: 'success' | 'error', message?: string) => void
}

export interface McpToolContext {
  callbacks: McpChannelCallbacks
  getIdentity: () => AgentHostIdentity | null
  getClaudeCodeVersion: () => string | undefined
  getDialogCwd: () => string
  pendingDialogs: Map<string, PendingDialog>
  elog: (msg: string) => void
}
