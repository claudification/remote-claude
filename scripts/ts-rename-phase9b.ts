#!/usr/bin/env bun
/**
 * Phase 9b: Conservative `sessionId` -> `conversationId` rename in files
 * that ONLY hold conversation IDs (no CC session ID semantics).
 *
 * We only rename in an explicit allowlist of files. Files that mix CC and
 * conversation IDs (store types, transcripts, conversation-store) are left
 * alone for a future phase.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

const ALLOW_FILES = [
  // web frontend - all conversationId
  'web/src/hooks/use-conversations.ts',
  'web/src/hooks/use-websocket.ts',
  'web/src/hooks/use-file-editor.ts',
  'web/src/hooks/use-launch-channel.ts',
  'web/src/hooks/use-launch-progress.ts',
  'web/src/hooks/use-project.ts',
  'web/src/hooks/use-voice-recording.ts',
  'web/src/components/notification-panel.tsx',
  'web/src/components/quick-task-modal.tsx',
  'web/src/components/spawn-dialog.tsx',
  'web/src/components/terminate-confirm.tsx',
  'web/src/components/revive-dialog.tsx',
  'web/src/components/toast.tsx',
  'web/src/components/project-list.tsx',
  'web/src/components/project-list/project-node.tsx',
  'web/src/components/project-list/conversation-context-menu.tsx',
  'web/src/components/project-list/conversation-item.tsx',
  'web/src/components/project-board.tsx',
  'web/src/components/file-editor.tsx',
  'web/src/components/conversation-detail.tsx',
  'web/src/components/conversation-detail/conversation-banners.tsx',
  'web/src/components/conversation-detail/conversation-input.tsx',
  'web/src/components/conversation-view.tsx',
  'web/src/components/transcript/group-view.tsx',
  'web/src/components/transcript/tool-line.tsx',
  'web/src/components/transcript/transcript-view.tsx',
  'web/src/components/markdown-input.tsx',
  'web/src/components/input-editor/backends/codemirror/extensions.ts',
  'web/src/components/input-editor/backends/codemirror/inner.tsx',
  'web/src/components/input-editor/backends/codemirror/paste-drop.ts',
  'web/src/components/input-editor/sub-commands.ts',
  'web/src/components/command-palette/types.ts',
  'web/src/components/command-palette/use-command-palette.ts',
  'web/src/components/command-palette/conversation-results.tsx',
  'web/src/components/command-palette/command-palette.tsx',
  'web/src/components/error-boundary.tsx',
  'web/src/components/diag-view.tsx',
  'web/src/components/bg-tasks-view.tsx',
  'web/src/components/action-fab.tsx',
  'web/src/components/shared-view.tsx',
  'web/src/components/subagent-view.tsx',
  'web/src/components/tasks-view.tsx',
  'web/src/lib/upload.ts',
  'web/src/lib/ui-state.ts',
  // broker handler files - mostly safe (handlers route by conversationId)
  'src/broker/handlers/control-panel-actions.ts',
  'src/broker/handlers/dialog.ts',
  'src/broker/handlers/files.ts',
  'src/broker/handlers/permissions.ts',
  'src/broker/handlers/plan-approval.ts',
  'src/broker/handlers/conversation-lifecycle.ts',
  'src/broker/handlers/rclaude-config.ts',
  'src/broker/conversation-store/project-links.ts',
  'src/broker/conversation-store/revive-queue.ts',
  'src/broker/inter-conversation-log.ts',
  'src/broker/handlers/inter-conversation.ts',
  'src/broker/handlers/boot-lifecycle.ts',
  'src/broker/routes/api.ts',
  'src/broker/handler-context.ts',
]

const SKIP_LINE_PATTERNS = [
  'claudeSessionId',
  'ccSessionId',
  'observeClaudeSessionId',
  'getCcSessionIds',
  'targetCcSessionIds',
  'hookSessionId',
  'callerSessionId',
  'rendezvousCallerSessionId',
  'previousSessionId',
  'prevSessionId',
  'fromSessionId',
  'toSessionId',
  'targetSessionId',
  'reqSessionId',
  'newSessionId',
  'setSessionId',
  'getSessionId',
  "'SessionStart'",
  "'SessionEnd'",
  '"SessionStart"',
  '"SessionEnd"',
  'session_id:',
  'session_id =',
  '"session_id"',
  'voiceSession',
  'WHERE session_id',
  'WHERE cc_session_id',
  'ChannelAck',
  'tmuxSession',
  // routing field on ControlPanelMessage / DashboardMessage
  // (the field's still named sessionId in some backward-compat slots; skip line-by-line)
]

let totalRenames = 0
let filesChanged = 0
const conflicts: string[] = []

for (const rel of ALLOW_FILES) {
  const file = join(ROOT, rel)
  let original: string
  try {
    original = readFileSync(file, 'utf-8')
  } catch {
    console.warn(`SKIP: ${rel} not found`)
    continue
  }
  const lines = original.split('\n')
  let changed = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (SKIP_LINE_PATTERNS.some(pat => line.includes(pat))) continue
    if (!line.includes('sessionId')) continue
    const replaced = line.replace(/\bsessionId\b/g, () => {
      changed++
      return 'conversationId'
    })
    if (replaced !== line) lines[i] = replaced
  }
  if (changed > 0) {
    writeFileSync(file, lines.join('\n'))
    totalRenames += changed
    filesChanged++
  }
}

console.log(`Replacements: ${totalRenames} across ${filesChanged} files`)
