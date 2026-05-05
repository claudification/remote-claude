import type { ProjectTask, TaskStatus } from '@/hooks/use-project'
import { RunTaskDialog, TaskEditor } from '../project-board'

interface TaskEditorOverlayProps {
  conversationId: string
  taskEditorTask: ProjectTask | null
  runTaskFromEditor: ProjectTask | null
  onUpdateTask: (
    slug: string,
    status: TaskStatus,
    patch: { title?: string; body?: string; priority?: string; tags?: string[] },
  ) => Promise<unknown>
  onMoveTask: (slug: string, from: TaskStatus, to: TaskStatus) => Promise<string | false>
  onRunTask: (task: ProjectTask) => void
  onCloseEditor: () => void
  onCloseRunDialog: () => void
  onSetTaskEditorTask: (task: ProjectTask | null) => void
}

export function TaskEditorOverlay({
  conversationId,
  taskEditorTask,
  runTaskFromEditor,
  onUpdateTask,
  onMoveTask,
  onRunTask,
  onCloseEditor,
  onCloseRunDialog,
  onSetTaskEditorTask,
}: TaskEditorOverlayProps) {
  return (
    <>
      {taskEditorTask && (
        <TaskEditor
          task={taskEditorTask}
          conversationId={conversationId}
          onSave={async (slug, status, patch) => {
            await onUpdateTask(slug, status, patch)
          }}
          onMove={async (slug, from, to) => {
            const result = await onMoveTask(slug, from, to)
            if (result)
              onSetTaskEditorTask(
                taskEditorTask.slug === slug ? { ...taskEditorTask, slug: result, status: to } : taskEditorTask,
              )
            return !!result
          }}
          onRun={task => {
            onCloseEditor()
            onRunTask(task)
          }}
          onClose={onCloseEditor}
        />
      )}
      {runTaskFromEditor && (
        <RunTaskDialog task={runTaskFromEditor} conversationId={conversationId} onClose={onCloseRunDialog} />
      )}
    </>
  )
}
