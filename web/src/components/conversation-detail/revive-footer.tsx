import { Button } from '@/components/ui/button'
import { projectPath } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { openReviveDialog } from '../revive-dialog'

interface ReviveFooterProps {
  conversationId: string
  project: string
  sentinelConnected: boolean
  canRevive: boolean
}

export function ReviveFooter({ conversationId, project, sentinelConnected, canRevive }: ReviveFooterProps) {
  function handleRevive() {
    haptic('tap')
    openReviveDialog({ conversationId })
  }

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
            Spawns new rclaude in tmux at {projectPath(project).split('/').slice(-2).join('/')}
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
