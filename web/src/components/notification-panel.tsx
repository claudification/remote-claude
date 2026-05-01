import type { ReactNode } from 'react'
import { renderProjectIcon } from '@/components/project-settings-editor'
import { BannerButton, SessionBanner } from '@/components/ui/session-banner'
import { useConversationsStore } from '@/hooks/use-sessions'
import { projectPath } from '@/lib/types'
import { haptic, projectDisplayName } from '@/lib/utils'

interface NotificationPanelProps {
  onClose: () => void
}

interface GroupedItem {
  type: 'permission' | 'plan_approval' | 'ask' | 'link' | 'notification'
  key: string
  sessionId: string
  timestamp: number
  render: () => ReactNode
}

export function NotificationPanel({ onClose }: NotificationPanelProps) {
  const sessions = useConversationsStore(s => s.sessionsById)
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const selectSession = useConversationsStore(s => s.selectSession)

  const perms = useConversationsStore(s => s.pendingPermissions)
  const respondPerm = useConversationsStore(s => s.respondToPermission)
  const sendRule = useConversationsStore(s => s.sendPermissionRule)
  const links = useConversationsStore(s => s.pendingProjectLinks)
  const respondLink = useConversationsStore(s => s.respondToProjectLink)
  const asks = useConversationsStore(s => s.pendingAskQuestions)
  const dialogs = useConversationsStore(s => s.pendingDialogs)
  const notifs = useConversationsStore(s => s.notifications)
  const dismissNotif = useConversationsStore(s => s.dismissNotification)

  const items: GroupedItem[] = []

  for (const p of perms) {
    items.push({
      type: 'permission',
      key: `perm-${p.requestId}`,
      sessionId: p.sessionId,
      timestamp: p.timestamp,
      render: () => (
        <SessionBanner
          accent="amber"
          label="PERMISSION"
          title={<span className="font-bold">{p.toolName}</span>}
          actions={
            <>
              <BannerButton
                accent="emerald"
                label="ALLOW"
                size="sm"
                onClick={() => {
                  haptic('success')
                  respondPerm(p.sessionId, p.requestId, 'allow')
                }}
              />
              <BannerButton
                accent="blue"
                label="ALWAYS"
                size="sm"
                onClick={() => {
                  haptic('double')
                  respondPerm(p.sessionId, p.requestId, 'allow')
                  sendRule(p.sessionId, p.toolName, 'allow')
                }}
              />
              <BannerButton
                accent="red"
                label="DENY"
                size="sm"
                onClick={() => {
                  haptic('error')
                  respondPerm(p.sessionId, p.requestId, 'deny')
                }}
              />
            </>
          }
        >
          {p.description && <div className="text-foreground/70 text-[11px]">{p.description}</div>}
          {p.inputPreview && <PermissionPreview toolName={p.toolName} input={p.inputPreview} />}
        </SessionBanner>
      ),
    })
  }

  for (const [sessionId, dialog] of Object.entries(dialogs)) {
    if (dialog.source !== 'plan_approval') continue
    items.push({
      type: 'plan_approval',
      key: `plan-${dialog.dialogId}`,
      sessionId,
      timestamp: dialog.timestamp,
      render: () => (
        <SessionBanner accent="blue" label="PLAN APPROVAL">
          <div className="text-foreground/70 text-[11px] line-clamp-3">Plan ready for review</div>
          <div className="flex items-center gap-2 mt-0.5">
            <BannerButton
              accent="emerald"
              label="VIEW"
              size="sm"
              onClick={() => {
                haptic('tap')
                navigate(sessionId)
              }}
            />
          </div>
        </SessionBanner>
      ),
    })
  }

  for (const ask of asks) {
    items.push({
      type: 'ask',
      key: `ask-${ask.toolUseId}`,
      sessionId: ask.sessionId,
      timestamp: ask.timestamp,
      render: () => (
        <SessionBanner accent="violet" label="QUESTION">
          <div className="text-foreground/70 text-[11px] line-clamp-2">
            {ask.questions[0]?.question || 'Waiting for input'}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <BannerButton
              accent="violet"
              label="ANSWER"
              size="sm"
              onClick={() => {
                haptic('tap')
                navigate(ask.sessionId)
              }}
            />
          </div>
        </SessionBanner>
      ),
    })
  }

  for (const link of links) {
    items.push({
      type: 'link',
      key: `link-${link.fromSession}-${link.toSession}`,
      sessionId: link.toSession,
      timestamp: Date.now(),
      render: () => (
        <SessionBanner
          accent="teal"
          label="LINK"
          layout="row"
          title={
            <>
              <span className="text-teal-300">{link.fromProject}</span>
              {' -> '}
              <span className="text-teal-300">{link.toProject}</span>
            </>
          }
          actions={
            <>
              <BannerButton
                accent="emerald"
                label="ALLOW"
                size="sm"
                onClick={() => {
                  haptic('success')
                  respondLink(link.fromSession, link.toSession, 'approve')
                }}
              />
              <BannerButton
                accent="red"
                label="BLOCK"
                size="sm"
                onClick={() => {
                  haptic('error')
                  respondLink(link.fromSession, link.toSession, 'block')
                }}
              />
            </>
          }
        />
      ),
    })
  }

  for (const n of notifs) {
    items.push({
      type: 'notification',
      key: n.id,
      sessionId: n.sessionId,
      timestamp: n.timestamp,
      render: () => (
        <SessionBanner
          accent="muted"
          label="NOTIFY"
          layout="row"
          title={<span className="text-foreground/70">{n.message}</span>}
          meta={formatTime(n.timestamp)}
          actions={
            <BannerButton
              accent="muted"
              label="X"
              size="sm"
              onClick={() => {
                haptic('tick')
                dismissNotif(n.id)
              }}
            />
          }
        />
      ),
    })
  }

  // Group by session, sort by most recent first
  const grouped = new Map<string, GroupedItem[]>()
  for (const item of items) {
    const list = grouped.get(item.sessionId) || []
    list.push(item)
    grouped.set(item.sessionId, list)
  }
  const sessionGroups = [...grouped.entries()].sort((a, b) => {
    const aMax = Math.max(...a[1].map(i => i.timestamp))
    const bMax = Math.max(...b[1].map(i => i.timestamp))
    return bMax - aMax
  })

  function navigate(sessionId: string) {
    haptic('tap')
    selectSession(sessionId, 'notification-panel')
    onClose()
  }

  if (items.length === 0) {
    return <div className="p-6 text-center text-muted-foreground text-xs">No pending notifications</div>
  }

  return (
    <div className="divide-y divide-border/50">
      {sessionGroups.map(([sessionId, groupItems]) => {
        const session = sessions[sessionId]
        const ps = session ? projectSettings[session.project] : undefined
        const displayColor = ps?.color
        const sessionName = session?.title || session?.agentName || sessionId.slice(0, 8)
        const projectName = session ? projectDisplayName(projectPath(session.project), ps?.label) : ''

        return (
          <div key={sessionId} className="p-2 space-y-1.5">
            <button
              type="button"
              className="flex items-center gap-1.5 w-full text-left hover:opacity-80 transition-opacity cursor-pointer"
              onClick={() => navigate(sessionId)}
            >
              {ps?.icon && (
                <span className="shrink-0" style={displayColor ? { color: displayColor } : undefined}>
                  {renderProjectIcon(ps.icon, 'w-3 h-3')}
                </span>
              )}
              {projectName && (
                <span
                  className="text-[11px] font-bold truncate"
                  style={displayColor ? { color: displayColor } : undefined}
                >
                  {projectName}
                </span>
              )}
              <span className="text-[9px] text-muted-foreground/50 truncate ml-auto">{sessionName}</span>
            </button>
            {groupItems
              .sort((a, b) => b.timestamp - a.timestamp)
              .map(item => (
                <div key={item.key}>{item.render()}</div>
              ))}
          </div>
        )
      })}
    </div>
  )
}

function PermissionPreview({ toolName, input }: { toolName: string; input: string }) {
  try {
    const parsed = JSON.parse(input)
    if ((toolName === 'Write' || toolName === 'Edit') && parsed.file_path) {
      return <div className="text-amber-300 text-[10px] truncate">{parsed.file_path}</div>
    }
    if (toolName === 'Bash' && (parsed.command || parsed.cmd)) {
      return (
        <pre className="text-cyan-400 text-[10px] bg-background/50 px-1.5 py-0.5 rounded whitespace-pre-wrap line-clamp-2">
          {(parsed.command || parsed.cmd).slice(0, 200)}
        </pre>
      )
    }
    if (toolName === 'Read' && parsed.file_path) {
      return <div className="text-amber-300 text-[10px] truncate">{parsed.file_path}</div>
    }
  } catch {
    // ignore
  }
  return input.length > 0 ? (
    <pre className="text-muted-foreground text-[9px] bg-background/50 px-1.5 py-0.5 rounded whitespace-pre-wrap line-clamp-2">
      {input.slice(0, 150)}
    </pre>
  ) : null
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}
