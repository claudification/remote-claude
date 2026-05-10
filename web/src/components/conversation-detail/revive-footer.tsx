import { Button } from '@/components/ui/button'
import { BACKENDS } from '../project-list/backend-icon'
import { projectPath } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { openReviveDialog } from '../revive-dialog'

interface ReviveFooterProps {
  conversationId: string
  project: string
  sentinelConnected: boolean
  canRevive: boolean
  backend?: string
}

export function ReviveFooter({ conversationId, project, sentinelConnected, canRevive, backend }: ReviveFooterProps) {
  function handleRevive() {
    haptic('tap')
    openReviveDialog({ conversationId })
  }

  const backendLabel = (backend && BACKENDS[backend]?.label) || 'Claude Code'
  const pathLabel = projectPath(project).split('/').slice(-2).join('/')

  return (
    <div className="shrink-0 p-3 border-t border-border">
      {canRevive ? (
        <div>
          <Button
            onClick={handleRevive}
            size="sm"
            className="w-full text-xs border bg-active/20 text-active border-active/50 hover:bg-active/30"
          >
            Revive Conversation
          </Button>
          <p className="text-[10px] text-muted-foreground mt-1">
            Spawns new {backendLabel} at {pathLabel}
          </p>
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground text-center">
          {sentinelConnected ? 'Conversation ended' : 'No sentinel connected -- revive unavailable'}
        </p>
      )}
    </div>
  )
}
