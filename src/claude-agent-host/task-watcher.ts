/**
 * Task & Project Watcher
 * Watches ~/.claude/tasks/ for CC task state changes and .rclaude/project/
 * for project board changes. Sends updates to the broker via WS.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { watch as chokidarWatch } from 'chokidar'
import type { AgentHostMessage, TaskInfo, TasksUpdate } from '../shared/protocol'
import { TASK_STATUS_PATTERN } from '../shared/task-statuses'
import type { AgentHostContext } from './agent-host-context'
import { debug } from './debug'
import { listProjectTasks } from './project-tasks'

export function readAndSendTasks(ctx: AgentHostContext) {
  if (!ctx.wsClient?.isConnected() || !ctx.claudeSessionId) {
    debug(
      `readAndSendTasks: skipped (connected=${ctx.wsClient?.isConnected()}, ccSessionId=${ctx.claudeSessionId?.slice(0, 8)})`,
    )
    return
  }
  try {
    let tasksDir: string | null = null
    for (const dir of ctx.taskCandidateDirs) {
      if (!existsSync(dir)) continue
      const jsonFiles = readdirSync(dir).filter(f => f.endsWith('.json'))
      if (jsonFiles.length > 0) {
        tasksDir = dir
        break
      }
    }

    const files = tasksDir
      ? readdirSync(tasksDir)
          .filter(f => f.endsWith('.json'))
          .sort()
      : []

    const tasks: TaskInfo[] = []
    for (const file of files) {
      try {
        const raw = readFileSync(join(tasksDir as string, file), 'utf-8')
        const task = JSON.parse(raw)
        tasks.push({
          id: String(task.id || ''),
          subject: String(task.subject || ''),
          description: task.description ? String(task.description) : undefined,
          status: task.status || 'pending',
          blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : undefined,
          blocks: Array.isArray(task.blocks) ? task.blocks.map(String) : undefined,
          owner: task.owner ? String(task.owner) : undefined,
          updatedAt: task.updatedAt || Date.now(),
        })
      } catch {
        // Skip malformed task files
      }
    }

    const json = JSON.stringify(tasks)
    if (json !== ctx.lastTasksJson) {
      ctx.lastTasksJson = json
      const msg: TasksUpdate = { type: 'tasks_update', conversationId: ctx.claudeSessionId, tasks }
      ctx.wsClient?.send(msg)
      debug(`Tasks updated: ${tasks.length} tasks (dir: ${tasksDir?.split('/').pop()?.slice(0, 8)})`)
      ctx.diag('tasks', `Sent ${tasks.length} tasks`, { dir: tasksDir?.split('/').pop() })
    }
  } catch (err) {
    debug(`readAndSendTasks error: ${err}`)
    ctx.diag('tasks', `Read error: ${err}`, { dirs: ctx.taskCandidateDirs.map(d => d.split('/').pop()) })
  }
}

export function startTaskWatching(ctx: AgentHostContext) {
  if (ctx.taskWatcher) return
  const tasksBase = join(homedir(), '.claude', 'tasks')
  const candidates = new Set<string>()
  if (ctx.claudeSessionId) candidates.add(join(tasksBase, ctx.claudeSessionId))
  candidates.add(join(tasksBase, ctx.conversationId))
  ctx.taskCandidateDirs = Array.from(candidates)

  const watchPaths = ctx.taskCandidateDirs.map(d => join(d, '*.json'))
  debug(`Task watcher dirs: ${ctx.taskCandidateDirs.map(d => d.split('/').pop()).join(', ')}`)
  ctx.taskWatcher = chokidarWatch(watchPaths, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  })
  const reader = () => readAndSendTasks(ctx)
  ctx.taskWatcher.on('add', reader)
  ctx.taskWatcher.on('change', reader)
  ctx.taskWatcher.on('unlink', reader)
  const pollInterval = setInterval(reader, 5000)
  ctx.taskWatcher.on('close', () => clearInterval(pollInterval))
  ctx.diag('watch', 'Task watcher started', { dirs: ctx.taskCandidateDirs.map(d => d.split('/').pop()), watchPaths })
}

export function sendProjectChanged(ctx: AgentHostContext) {
  if (!ctx.wsClient?.isConnected() || !ctx.claudeSessionId) return
  const tasks = listProjectTasks(ctx.cwd)
  ctx.wsClient.send({
    type: 'project_changed',
    conversationId: ctx.conversationId,
    notes: tasks,
  } as unknown as AgentHostMessage)
  debug(`Project tasks changed: ${tasks.length} tasks`)
}

const PROJECT_TASK_PATTERN = new RegExp(`\\.rclaude/project/(${TASK_STATUS_PATTERN})/.+\\.md$`)

export function startProjectWatching(ctx: AgentHostContext) {
  if (ctx.projectWatcher) return
  const projectDir = join(ctx.cwd, '.rclaude', 'project')
  ctx.projectWatcher = chokidarWatch(join(projectDir, '**', '*.md'), {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    depth: 2,
  })

  let projectDebounce: ReturnType<typeof setTimeout> | null = null
  function onProjectTaskChange(path: string) {
    if (!PROJECT_TASK_PATTERN.test(path)) return
    if (projectDebounce) clearTimeout(projectDebounce)
    projectDebounce = setTimeout(() => {
      projectDebounce = null
      sendProjectChanged(ctx)
    }, 300)
  }

  ctx.projectWatcher.on('add', onProjectTaskChange)
  ctx.projectWatcher.on('change', onProjectTaskChange)
  ctx.projectWatcher.on('unlink', onProjectTaskChange)

  let lastProjectHash = ''
  const projectPollInterval = setInterval(() => {
    try {
      const tasks = listProjectTasks(ctx.cwd)
      const hash = tasks.map(t => `${t.slug}:${t.status}`).join('|')
      if (lastProjectHash && hash !== lastProjectHash) {
        sendProjectChanged(ctx)
      }
      lastProjectHash = hash
    } catch {}
  }, 5000)
  ctx.projectWatcher.on('close', () => clearInterval(projectPollInterval))
  debug('Project watcher started')
}
