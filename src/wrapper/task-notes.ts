/**
 * Task Notes - Host-side structured note storage
 *
 * Storage: {cwd}/.claude/.rclaude/tasks/{status}/{slug}.md
 * Markdown files with YAML frontmatter. Status = folder name.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type TaskStatus = 'open' | 'in-progress' | 'done' | 'archived'
const STATUSES: TaskStatus[] = ['open', 'in-progress', 'done']

export interface TaskNoteMeta {
  slug: string
  status: TaskStatus
  title: string
  priority?: 'low' | 'medium' | 'high'
  tags: string[]
  refs: string[]
  created: string
  bodyPreview: string
}

export interface TaskNote extends TaskNoteMeta {
  body: string
}

interface TaskNoteInput {
  title?: string
  body: string
  priority?: 'low' | 'medium' | 'high'
  tags?: string[]
  refs?: string[]
}

function tasksRoot(cwd: string): string {
  return join(cwd, '.claude', '.rclaude', 'tasks')
}

function statusDir(cwd: string, status: TaskStatus): string {
  const d = join(tasksRoot(cwd), status)
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

function toMarkdown(input: TaskNoteInput, created?: string): string {
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

function readNote(dir: string, filename: string, status: TaskStatus): TaskNote | null {
  try {
    const content = readFileSync(join(dir, filename), 'utf8')
    const { meta, body } = parseFrontmatter(content)
    const slug = filename.replace(/\.md$/, '')
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
      body,
      bodyPreview: body.split('\n').slice(0, 2).join(' ').slice(0, 120),
    }
  } catch {
    return null
  }
}

export function listTaskNotes(cwd: string, filterStatus?: TaskStatus): TaskNoteMeta[] {
  const statuses = filterStatus ? [filterStatus] : STATUSES
  const notes: TaskNoteMeta[] = []

  for (const s of statuses) {
    const dir = statusDir(cwd, s)
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.md')) continue
        const note = readNote(dir, file, s)
        if (note) {
          const { body: _, ...meta } = note
          notes.push(meta)
        }
      }
    } catch {
      /* empty */
    }
  }

  return notes.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 }
    const ap = priorityOrder[a.priority || 'medium'] ?? 1
    const bp = priorityOrder[b.priority || 'medium'] ?? 1
    if (ap !== bp) return ap - bp
    return (b.created || '').localeCompare(a.created || '')
  })
}

export function getTaskNote(cwd: string, status: TaskStatus, slug: string): TaskNote | null {
  const dir = statusDir(cwd, status)
  return readNote(dir, `${slug}.md`, status)
}

export function createTaskNote(cwd: string, input: TaskNoteInput): TaskNoteMeta {
  const dir = statusDir(cwd, 'open')
  const baseSlug = input.title ? slugify(input.title) : `task-${Date.now()}`
  const slug = dedupSlug(dir, baseSlug)
  const content = toMarkdown(input)
  writeFileSync(join(dir, `${slug}.md`), content, 'utf8')

  return {
    slug,
    status: 'open',
    title: input.title || slug,
    priority: input.priority,
    tags: input.tags || [],
    refs: input.refs || [],
    created: new Date().toISOString(),
    bodyPreview: input.body.split('\n').slice(0, 2).join(' ').slice(0, 120),
  }
}

export function updateTaskNote(
  cwd: string,
  status: TaskStatus,
  slug: string,
  patch: Partial<TaskNoteInput>,
): TaskNote | null {
  const note = getTaskNote(cwd, status, slug)
  if (!note) return null

  const updated: TaskNoteInput = {
    title: patch.title ?? note.title,
    body: patch.body ?? note.body,
    priority: patch.priority ?? note.priority,
    tags: patch.tags ?? note.tags,
    refs: patch.refs ?? note.refs,
  }

  const content = toMarkdown(updated, note.created)
  writeFileSync(join(statusDir(cwd, status), `${slug}.md`), content, 'utf8')
  return getTaskNote(cwd, status, slug)
}

export function moveTaskNote(cwd: string, slug: string, fromStatus: TaskStatus, toStatus: TaskStatus): boolean {
  const fromDir = statusDir(cwd, fromStatus)
  const toDir = statusDir(cwd, toStatus)
  const filename = `${slug}.md`
  const fromPath = join(fromDir, filename)
  const toPath = join(toDir, filename)

  if (!existsSync(fromPath)) return false
  renameSync(fromPath, toPath)
  return true
}

export function deleteTaskNote(cwd: string, status: TaskStatus, slug: string): boolean {
  const filepath = join(statusDir(cwd, status), `${slug}.md`)
  if (!existsSync(filepath)) return false
  unlinkSync(filepath)
  return true
}
