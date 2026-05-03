/**
 * File Editor Engine
 * Manages reading, writing, watching, versioning, and merging of markdown files
 * within a conversation's working directory.
 */

import { readFile as fsReadFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { type FSWatcher as ChokidarWatcher, watch as chokidarWatch } from 'chokidar'
import { computeUnifiedDiff, merge3way } from '../shared/diff'
import type { FileInfo } from '../shared/protocol'

const MAX_VERSIONS = 50
const NOTES_FILE = 'NOTES.md'

interface VersionEntry {
  version: number
  content: string
  timestamp: number
  source: 'user' | 'disk'
}

interface FileChangeEvent {
  path: string
  diff: string
  content: string
  version: number
  source: 'disk'
}

interface ReadResult {
  content: string
  version: number
}

interface SaveResult {
  version: number
  conflict: boolean
  mergedContent?: string
}

interface HistoryEntry {
  version: number
  timestamp: number
  size: number
  source: 'user' | 'disk'
  diffFromPrev?: string
}

export class FileEditor {
  private cwd: string
  private versions = new Map<string, VersionEntry[]>()
  private currentVersion = new Map<string, number>()
  private watchers = new Map<string, ChokidarWatcher>()
  private skipNextChange = new Map<string, boolean>()

  constructor(cwd: string, _conversationId: string) {
    this.cwd = resolve(cwd)
  }

  /**
   * Scan cwd/*.md + cwd/.claude/*.md and return file info
   */
  async listFiles(): Promise<FileInfo[]> {
    const files: FileInfo[] = []

    // Scan root *.md
    await this.scanDir('.', files, false)
    // Scan .claude/**/*.md (recursive)
    await this.scanDir('.claude', files, true)

    return files
  }

  private async scanDir(relDir: string, out: FileInfo[], recursive: boolean): Promise<void> {
    const absDir = join(this.cwd, relDir)
    let entries: string[]
    try {
      entries = await readdir(absDir)
    } catch {
      return // directory doesn't exist, that's fine
    }

    for (const name of entries) {
      const relPath = relDir === '.' ? name : join(relDir, name)
      const absPath = join(absDir, name)
      try {
        const s = await stat(absPath)
        if (s.isDirectory() && recursive) {
          await this.scanDir(relPath, out, true)
        } else if (s.isFile() && name.endsWith('.md')) {
          out.push({
            path: relPath,
            name,
            size: s.size,
            modifiedAt: s.mtimeMs,
          })
        }
      } catch {
        // file disappeared between readdir and stat, skip
      }
    }
  }

  /**
   * Read a file, store as version if content is new
   */
  async readFile(path: string): Promise<ReadResult> {
    this.validatePath(path)
    const absPath = join(this.cwd, path)
    const content = await fsReadFile(absPath, 'utf-8')
    const ver = this.storeIfNew(path, content, 'disk')
    return { content, version: ver }
  }

  /**
   * Watch a file for disk changes. Calls onChange when the file is modified externally.
   */
  watchFile(path: string, onChange: (event: FileChangeEvent) => void): void {
    this.validatePath(path)
    if (this.watchers.has(path)) return // already watching

    const absPath = resolve(this.cwd, path)

    const watcher = chokidarWatch(absPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    })

    watcher.on('change', async () => {
      // Echo suppression: skip changes we caused
      if (this.skipNextChange.get(path)) {
        this.skipNextChange.delete(path)
        return
      }

      try {
        const content = await fsReadFile(absPath, 'utf-8')
        const history = this.versions.get(path)
        const lastContent = history && history.length > 0 ? history[history.length - 1].content : undefined

        // Only emit if content actually changed
        if (content === lastContent) return

        const diff = computeUnifiedDiff(lastContent ?? '', content, path)
        const version = this.storeVersion(path, content, 'disk')

        onChange({ path, diff, content, version, source: 'disk' })
      } catch {
        // File might have been deleted between event and read
      }
    })

    this.watchers.set(path, watcher)
  }

  /**
   * Stop watching a file
   */
  unwatchFile(path: string): void {
    const watcher = this.watchers.get(path)
    if (watcher) {
      watcher.close()
      this.watchers.delete(path)
    }
  }

  /**
   * Save file with conflict detection via 3-way merge
   */
  async saveFile(opts: { path: string; content: string; diff: string; baseVersion: number }): Promise<SaveResult> {
    this.validatePath(opts.path)
    const absPath = join(this.cwd, opts.path)
    const current = this.currentVersion.get(opts.path) ?? 0

    if (opts.baseVersion === current || current === 0) {
      // No conflict - direct write
      this.skipNextChange.set(opts.path, true)
      await writeFile(absPath, opts.content, 'utf-8')
      const version = this.storeVersion(opts.path, opts.content, 'user')
      return { version, conflict: false }
    }

    // baseVersion < currentVersion - need 3-way merge
    const history = this.versions.get(opts.path) ?? []
    const baseEntry = history.find(e => e.version === opts.baseVersion)
    const latestEntry = history[history.length - 1]

    if (!baseEntry || !latestEntry) {
      // Can't find base version - treat as conflict with no merge
      return { version: current, conflict: true, mergedContent: opts.content }
    }

    const base = baseEntry.content
    const theirs = latestEntry.content
    const ours = opts.content

    const { result, hasConflicts } = merge3way(base, ours, theirs)

    if (hasConflicts) {
      // Don't write - return conflict markers for user to resolve
      return { version: current, conflict: true, mergedContent: result }
    }

    // Clean merge - write result
    this.skipNextChange.set(opts.path, true)
    await writeFile(absPath, result, 'utf-8')
    const version = this.storeVersion(opts.path, result, 'user')
    return { version, conflict: false }
  }

  /**
   * Append a quick note to NOTES.md
   */
  async appendNote(text: string): Promise<{ version: number }> {
    const path = NOTES_FILE
    this.validatePath(path)
    const absPath = join(this.cwd, path)

    let existing = ''
    try {
      existing = await fsReadFile(absPath, 'utf-8')
    } catch {
      // File doesn't exist yet, that's fine
    }

    // Indent continuation lines to stay within the markdown list item (6 chars = "- [ ] ")
    const parts = text.split('\n')
    const line =
      parts.length === 1
        ? `- [ ] ${text}\n`
        : `- [ ] ${parts[0]}\n${parts
            .slice(1)
            .map(l => `      ${l}`)
            .join('\n')}\n`
    const content = existing ? (existing.endsWith('\n') ? existing + line : `${existing}\n${line}`) : line

    // No skip flag for quick notes - we want watchers to see this change
    await writeFile(absPath, content, 'utf-8')
    const version = this.storeVersion(path, content, 'user')
    return { version }
  }

  /**
   * Get version history for a file
   */
  getHistory(path: string): HistoryEntry[] {
    this.validatePath(path)
    const history = this.versions.get(path) ?? []

    return history.map((entry, i) => {
      const prev = i > 0 ? history[i - 1] : undefined
      return {
        version: entry.version,
        timestamp: entry.timestamp,
        size: Buffer.byteLength(entry.content, 'utf-8'),
        source: entry.source,
        diffFromPrev: prev ? computeUnifiedDiff(prev.content, entry.content, path) : undefined,
      }
    })
  }

  /**
   * Restore a file to a previous version
   */
  async restoreVersion(path: string, version: number): Promise<SaveResult> {
    this.validatePath(path)
    const history = this.versions.get(path) ?? []
    const entry = history.find(e => e.version === version)

    if (!entry) {
      throw new Error(`Version ${version} not found for ${path}`)
    }

    const absPath = join(this.cwd, path)
    this.skipNextChange.set(path, true)
    await writeFile(absPath, entry.content, 'utf-8')
    const newVersion = this.storeVersion(path, entry.content, 'user')
    return { version: newVersion, conflict: false }
  }

  /**
   * Clean up all watchers and state
   */
  destroy(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
    this.versions.clear()
    this.currentVersion.clear()
    this.skipNextChange.clear()
  }

  // --- Private helpers ---

  /**
   * Validate that a path is a .md file within allowed scope
   */
  private validatePath(relPath: string): void {
    if (!relPath.endsWith('.md')) {
      throw new Error(`Only .md files are allowed: ${relPath}`)
    }

    const absPath = resolve(this.cwd, relPath)

    // Must resolve within cwd
    if (!absPath.startsWith(`${this.cwd}/`) && absPath !== this.cwd) {
      throw new Error(`Path escapes working directory: ${relPath}`)
    }

    // Compute relative from cwd to check depth/location
    const rel = relative(this.cwd, absPath)

    // Allow: root-level .md files (no slash) or .claude/**/*.md (any depth)
    const segments = rel.split('/')
    if (segments.length === 1) {
      // Root level .md - allowed
      return
    }
    if (segments[0] === '.claude') {
      // .claude/**/*.md - allowed at any depth
      return
    }
    throw new Error(`Path not in allowed scope (root/*.md or .claude/**/*.md): ${relPath}`)
  }

  /**
   * Store content as a new version only if it differs from the latest
   */
  private storeIfNew(path: string, content: string, source: 'user' | 'disk'): number {
    const history = this.versions.get(path)
    if (history && history.length > 0) {
      const latest = history[history.length - 1]
      if (latest.content === content) {
        return latest.version
      }
    }
    return this.storeVersion(path, content, source)
  }

  /**
   * Store a new version, maintaining ring buffer limit
   */
  private storeVersion(path: string, content: string, source: 'user' | 'disk'): number {
    let history = this.versions.get(path)
    if (!history) {
      history = []
      this.versions.set(path, history)
    }

    const prevVersion = this.currentVersion.get(path) ?? 0
    const version = prevVersion + 1
    this.currentVersion.set(path, version)

    history.push({
      version,
      content,
      timestamp: Date.now(),
      source,
    })

    // Ring buffer: evict oldest when over limit
    if (history.length > MAX_VERSIONS) {
      history.splice(0, history.length - MAX_VERSIONS)
    }

    return version
  }
}

export default FileEditor
