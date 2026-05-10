/**
 * Project Tasks - Host-side structured task storage for the project board
 *
 * Storage: {cwd}/.rclaude/project/{status}/{slug}.md
 * Markdown files with YAML frontmatter. Status = folder name.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { TASK_STATUSES, type TaskStatus } from '../shared/task-statuses'

export type { TaskStatus } from '../shared/task-statuses'

const STATUSES = TASK_STATUSES

export interface ProjectTaskMeta {
  slug: string
  status: TaskStatus
  title: string
  priority?: 'low' | 'medium' | 'high'
  tags: string[]
  refs: string[]
  created: string
  /** File mtime in ms since epoch - used for sorting (most recently changed first) */
  mtime: number
  bodyPreview: string
}

export interface ProjectTask extends ProjectTaskMeta {
  body: string
}

interface ProjectTaskInput {
  title?: string
  body: string
  priority?: 'low' | 'medium' | 'high'
  tags?: string[]
  refs?: string[]
}

function projectRoot(cwd: string): string {
  return join(cwd, '.rclaude', 'project')
}

function statusDir(cwd: string, status: TaskStatus): string {
  const d = join(projectRoot(cwd), status)
  mkdirSync(d, { recursive: true })
  return d
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `task-${Date.now()}`
  )
}

function dedupSlug(dir: string, base: string): string {
  if (!existsSync(join(dir, `${base}.md`))) return base
  for (let i = 2; i < 100; i++) {
    if (!existsSync(join(dir, `${base}-${i}.md`))) return `${base}-${i}`
  }
  return `${base}-${Date.now()}`
}

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }

  const meta: Record<string, unknown> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let val: unknown = line.slice(idx + 1).trim()
    if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    }
    meta[key] = val
  }
  return { meta, body: match[2].trim() }
}

function toMarkdown(input: ProjectTaskInput, created?: string): string {
  const lines = ['---']
  if (input.title) lines.push(`title: ${input.title}`)
  if (input.priority) lines.push(`priority: ${input.priority}`)
  if (input.tags?.length) lines.push(`tags: [${input.tags.join(', ')}]`)
  if (input.refs?.length) lines.push(`refs: [${input.refs.join(', ')}]`)
  lines.push(`created: ${created || new Date().toISOString()}`)
  lines.push('---')
  lines.push('')
  lines.push(input.body)
  return lines.join('\n')
}

function readTask(dir: string, filename: string, status: TaskStatus): ProjectTask | null {
  try {
    const filepath = join(dir, filename)
    const content = readFileSync(filepath, 'utf8')
    const { meta, body } = parseFrontmatter(content)
    const slug = filename.replace(/\.md$/, '')
    const mtime = statSync(filepath).mtimeMs
    return {
      slug,
      status,
      title: String(meta.title || slug),
      priority: ['low', 'medium', 'high'].includes(String(meta.priority))
        ? (String(meta.priority) as 'low' | 'medium' | 'high')
        : undefined,
      tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
      refs: Array.isArray(meta.refs) ? meta.refs.map(String) : [],
      created: String(meta.created || ''),
      mtime,
      body,
      bodyPreview: body.split('\n').filter(Boolean).join(' ').slice(0, 600),
    }
  } catch {
    return null
  }
}

export function listProjectTasks(cwd: string, filterStatus?: TaskStatus): ProjectTaskMeta[] {
  const statuses = filterStatus ? [filterStatus] : STATUSES
  const tasks: ProjectTaskMeta[] = []

  for (const s of statuses) {
    const dir = statusDir(cwd, s)
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.md')) continue
        const task = readTask(dir, file, s)
        if (task) {
          const { body: _, ...meta } = task
          tasks.push(meta)
        }
      }
    } catch {
      /* empty */
    }
  }

  return tasks.sort((a, b) => b.mtime - a.mtime)
}

export function getProjectTask(cwd: string, status: TaskStatus, slug: string): ProjectTask | null {
  const dir = statusDir(cwd, status)
  return readTask(dir, `${slug}.md`, status)
}

export function createProjectTask(cwd: string, input: ProjectTaskInput): ProjectTaskMeta {
  const dir = statusDir(cwd, 'inbox')
  const baseSlug = input.title ? slugify(input.title) : `task-${Date.now()}`
  const slug = dedupSlug(dir, baseSlug)
  const content = toMarkdown(input)
  const filepath = join(dir, `${slug}.md`)
  writeFileSync(filepath, content, 'utf8')

  return {
    slug,
    status: 'inbox',
    title: input.title || slug,
    priority: input.priority,
    tags: input.tags || [],
    refs: input.refs || [],
    created: new Date().toISOString(),
    mtime: Date.now(),
    bodyPreview: input.body.split('\n').filter(Boolean).join(' ').slice(0, 600),
  }
}

export function updateProjectTask(
  cwd: string,
  status: TaskStatus,
  slug: string,
  patch: Partial<ProjectTaskInput>,
): ProjectTask | null {
  const task = getProjectTask(cwd, status, slug)
  if (!task) return null

  const updated: ProjectTaskInput = {
    title: patch.title ?? task.title,
    body: patch.body ?? task.body,
    priority: patch.priority ?? task.priority,
    tags: patch.tags ?? task.tags,
    refs: patch.refs ?? task.refs,
  }

  const content = toMarkdown(updated, task.created)
  writeFileSync(join(statusDir(cwd, status), `${slug}.md`), content, 'utf8')
  return getProjectTask(cwd, status, slug)
}

/** Move a task between status folders. Returns the (possibly deduplicated) slug, or null on failure. */
export function moveProjectTask(
  cwd: string,
  slug: string,
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
): string | null {
  const fromDir = statusDir(cwd, fromStatus)
  const toDir = statusDir(cwd, toStatus)
  const fromPath = join(fromDir, `${slug}.md`)

  if (!existsSync(fromPath)) return null
  const newSlug = dedupSlug(toDir, slug)
  const destPath = join(toDir, `${newSlug}.md`)
  renameSync(fromPath, destPath)
  // Touch mtime so the moved task sorts to top of its new column
  const now = new Date()
  utimesSync(destPath, now, now)
  return newSlug
}

export function deleteProjectTask(cwd: string, status: TaskStatus, slug: string): boolean {
  const filepath = join(statusDir(cwd, status), `${slug}.md`)
  if (!existsSync(filepath)) return false
  unlinkSync(filepath)
  return true
}
