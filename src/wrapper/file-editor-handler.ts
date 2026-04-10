/**
 * File Editor Handler
 * Dispatches WS file_* and project_* messages to the FileEditor engine
 * and project-tasks CRUD functions.
 */

import { isPathWithinCwd } from '../shared/path-guard'
import type { WrapperMessage } from '../shared/protocol'
import { FileEditor } from './file-editor'
import {
  createProjectTask,
  deleteProjectTask,
  getProjectTask,
  listProjectTasks,
  moveProjectTask,
  type TaskStatus,
  updateProjectTask,
} from './project-tasks'
import type { WrapperContext } from './wrapper-context'

export function ensureFileEditor(ctx: WrapperContext): FileEditor {
  if (!ctx.fileEditor) {
    ctx.fileEditor = new FileEditor(ctx.cwd, ctx.claudeSessionId || ctx.internalId)
  }
  return ctx.fileEditor
}

export function handleFileEditorMessage(ctx: WrapperContext, msg: Record<string, unknown>) {
  const type = msg.type as string
  const requestId = msg.requestId as string | undefined
  const sessionId = msg.sessionId as string | undefined
  const editor = ensureFileEditor(ctx)

  function respond(responseType: string, data: Record<string, unknown>) {
    ctx.wsClient?.send({ type: responseType, requestId, sessionId, ...data } as unknown as WrapperMessage)
  }

  function respondError(responseType: string, err: unknown) {
    respond(responseType, { error: String(err) })
  }

  // Path traversal guard: reject paths outside the session CWD
  if (msg.path && !isPathWithinCwd(msg.path as string, ctx.cwd)) {
    const errorType = type.replace('_request', '_response').replace('_save', '_save_response')
    respond(errorType, { error: `Path outside session directory: ${msg.path}` })
    return
  }

  switch (type) {
    case 'file_list_request':
      editor
        .listFiles()
        .then(files => respond('file_list_response', { files }))
        .catch(err => respondError('file_list_response', err))
      break
    case 'file_content_request':
      editor
        .readFile(msg.path as string)
        .then(result => respond('file_content_response', { content: result.content, version: result.version }))
        .catch(err => respondError('file_content_response', err))
      break
    case 'file_save':
      editor
        .saveFile({
          path: msg.path as string,
          content: msg.content as string,
          diff: (msg.diff as string) || '',
          baseVersion: (msg.baseVersion as number) || 0,
        })
        .then(result => respond('file_save_response', { ...result }))
        .catch(err => respondError('file_save_response', err))
      break
    case 'file_watch':
      editor.watchFile(msg.path as string, event => {
        ctx.wsClient?.send({ type: 'file_changed', sessionId, ...event } as unknown as WrapperMessage)
      })
      break
    case 'file_unwatch':
      editor.unwatchFile(msg.path as string)
      break
    case 'file_history_request':
      try {
        const versions = editor.getHistory(msg.path as string)
        respond('file_history_response', { versions })
      } catch (err) {
        respondError('file_history_response', err)
      }
      break
    case 'file_restore':
      editor
        .restoreVersion(msg.path as string, msg.version as number)
        .then(async result => {
          const read = await editor.readFile(msg.path as string)
          respond('file_restore_response', { version: result.version, content: read.content })
        })
        .catch(err => respondError('file_restore_response', err))
      break
    case 'project_quick_add':
      editor
        .appendNote(msg.text as string)
        .then(result => respond('project_quick_add_response', { version: result.version }))
        .catch(err => respondError('project_quick_add_response', err))
      break
    case 'project_list':
      try {
        const notes = listProjectTasks(ctx.cwd, msg.status as TaskStatus | undefined)
        respond('project_list_response', { notes })
      } catch (err) {
        respondError('project_list_response', err)
      }
      break
    case 'project_create':
      try {
        const note = createProjectTask(ctx.cwd, {
          title: msg.title as string | undefined,
          body: msg.body as string,
          priority: msg.priority as 'low' | 'medium' | 'high' | undefined,
          tags: msg.tags as string[] | undefined,
          refs: msg.refs as string[] | undefined,
        })
        respond('project_create_response', { note })
      } catch (err) {
        respondError('project_create_response', err)
      }
      break
    case 'project_move':
      try {
        const ok = moveProjectTask(ctx.cwd, msg.slug as string, msg.from as TaskStatus, msg.to as TaskStatus)
        respond('project_move_response', { ok })
      } catch (err) {
        respondError('project_move_response', err)
      }
      break
    case 'project_delete':
      try {
        const ok = deleteProjectTask(ctx.cwd, msg.status as TaskStatus, msg.slug as string)
        respond('project_delete_response', { ok })
      } catch (err) {
        respondError('project_delete_response', err)
      }
      break
    case 'project_read':
      try {
        const note = getProjectTask(ctx.cwd, msg.status as TaskStatus, msg.slug as string)
        respond('project_read_response', { note })
      } catch (err) {
        respondError('project_read_response', err)
      }
      break
    case 'project_update':
      try {
        const note = updateProjectTask(ctx.cwd, msg.status as TaskStatus, msg.slug as string, {
          title: msg.title as string | undefined,
          body: msg.body as string | undefined,
          priority: msg.priority as 'low' | 'medium' | 'high' | undefined,
          tags: msg.tags as string[] | undefined,
          refs: msg.refs as string[] | undefined,
        })
        respond('project_update_response', { note })
      } catch (err) {
        respondError('project_update_response', err)
      }
      break
  }
  ctx.debug(`File editor: ${type}${msg.path ? ` path=${msg.path}` : ''}`)
}
