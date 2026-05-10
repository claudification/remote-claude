import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileEditor } from './file-editor'

let testDir: string
let editor: FileEditor

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'file-editor-test-'))
  editor = new FileEditor(testDir, 'test-session')
})

afterEach(() => {
  editor.destroy()
  rmSync(testDir, { recursive: true, force: true })
})

describe('listFiles', () => {
  it('finds .md files in root', async () => {
    writeFileSync(join(testDir, 'README.md'), '# Hello')
    writeFileSync(join(testDir, 'NOTES.md'), '- note')
    writeFileSync(join(testDir, 'index.ts'), 'code') // not .md

    const files = await editor.listFiles()
    const paths = files.map(f => f.path).sort()
    expect(paths).toEqual(['NOTES.md', 'README.md'])
  })

  it('finds .md files in .claude/', async () => {
    mkdirSync(join(testDir, '.claude'))
    writeFileSync(join(testDir, '.claude', 'CLAUDE.md'), '# Config')
    writeFileSync(join(testDir, 'README.md'), '# Root')

    const files = await editor.listFiles()
    const paths = files.map(f => f.path).sort()
    expect(paths).toEqual(['.claude/CLAUDE.md', 'README.md'])
  })

  it('returns empty when no .md files exist', async () => {
    const files = await editor.listFiles()
    expect(files).toEqual([])
  })

  it('handles missing .claude/ gracefully', async () => {
    writeFileSync(join(testDir, 'FILE.md'), 'x')
    const files = await editor.listFiles()
    expect(files.length).toBe(1)
  })
})

describe('readFile', () => {
  it('reads file content and returns version 1', async () => {
    writeFileSync(join(testDir, 'test.md'), 'hello world')
    const result = await editor.readFile('test.md')
    expect(result.content).toBe('hello world')
    expect(result.version).toBe(1)
  })

  it('returns same version for unchanged content on re-read', async () => {
    writeFileSync(join(testDir, 'test.md'), 'hello')
    const r1 = await editor.readFile('test.md')
    const r2 = await editor.readFile('test.md')
    expect(r1.version).toBe(r2.version)
  })

  it('increments version when content changes', async () => {
    writeFileSync(join(testDir, 'test.md'), 'v1')
    const r1 = await editor.readFile('test.md')
    writeFileSync(join(testDir, 'test.md'), 'v2')
    const r2 = await editor.readFile('test.md')
    expect(r2.version).toBe(r1.version + 1)
  })
})

describe('path validation', () => {
  it('rejects non-.md files', async () => {
    writeFileSync(join(testDir, 'test.ts'), 'code')
    await expect(editor.readFile('test.ts')).rejects.toThrow('Only .md files')
  })

  it('rejects path traversal', async () => {
    await expect(editor.readFile('../../../etc/passwd.md')).rejects.toThrow('escapes working directory')
  })

  it('rejects deeply nested paths', async () => {
    await expect(editor.readFile('deep/nested/file.md')).rejects.toThrow('not in allowed scope')
  })

  it('allows .claude/*.md', async () => {
    mkdirSync(join(testDir, '.claude'))
    writeFileSync(join(testDir, '.claude', 'CLAUDE.md'), '# hi')
    const result = await editor.readFile('.claude/CLAUDE.md')
    expect(result.content).toBe('# hi')
  })
})

describe('saveFile', () => {
  it('saves file when baseVersion matches', async () => {
    writeFileSync(join(testDir, 'test.md'), 'original')
    const { version } = await editor.readFile('test.md')

    const result = await editor.saveFile({
      path: 'test.md',
      content: 'modified',
      diff: '',
      baseVersion: version,
    })

    expect(result.conflict).toBe(false)
    expect(result.version).toBe(version + 1)
    expect(readFileSync(join(testDir, 'test.md'), 'utf-8')).toBe('modified')
  })

  it('detects conflict when baseVersion is stale', async () => {
    writeFileSync(join(testDir, 'test.md'), 'line 1\nline 2\nline 3')
    const { version: v1 } = await editor.readFile('test.md')

    // Simulate Claude modifying the file (bumps version)
    writeFileSync(join(testDir, 'test.md'), 'line 1\nline 2 edited by Claude\nline 3')
    await editor.readFile('test.md') // v2

    // User tries to save with stale baseVersion, editing same line
    const result = await editor.saveFile({
      path: 'test.md',
      content: 'line 1\nline 2 edited by user\nline 3',
      diff: '',
      baseVersion: v1,
    })

    expect(result.conflict).toBe(true)
    expect(result.mergedContent).toContain('<<<<<<< yours')
  })

  it('merges cleanly when edits dont overlap', async () => {
    writeFileSync(join(testDir, 'test.md'), 'line 1\nline 2\nline 3\nline 4\nline 5')
    const { version: v1 } = await editor.readFile('test.md')

    // Claude edits line 5
    writeFileSync(join(testDir, 'test.md'), 'line 1\nline 2\nline 3\nline 4\nline 5 edited')
    await editor.readFile('test.md')

    // User edits line 1 with stale baseVersion
    const result = await editor.saveFile({
      path: 'test.md',
      content: 'line 1 edited\nline 2\nline 3\nline 4\nline 5',
      diff: '',
      baseVersion: v1,
    })

    expect(result.conflict).toBe(false)
    const saved = readFileSync(join(testDir, 'test.md'), 'utf-8')
    expect(saved).toContain('line 1 edited')
    expect(saved).toContain('line 5 edited')
  })
})

describe('appendNote', () => {
  it('creates NOTES.md if missing', async () => {
    const { version } = await editor.appendNote('buy milk')
    expect(version).toBeGreaterThan(0)
    const content = readFileSync(join(testDir, 'NOTES.md'), 'utf-8')
    expect(content).toBe('- [ ] buy milk\n')
  })

  it('appends to existing NOTES.md', async () => {
    writeFileSync(join(testDir, 'NOTES.md'), '- [ ] first\n')
    await editor.appendNote('second')
    const content = readFileSync(join(testDir, 'NOTES.md'), 'utf-8')
    expect(content).toBe('- [ ] first\n- [ ] second\n')
  })

  it('adds newline before appending if missing', async () => {
    writeFileSync(join(testDir, 'NOTES.md'), '- [ ] first')
    await editor.appendNote('second')
    const content = readFileSync(join(testDir, 'NOTES.md'), 'utf-8')
    expect(content).toBe('- [ ] first\n- [ ] second\n')
  })
})

describe('getHistory', () => {
  it('returns empty for unread files', () => {
    const history = editor.getHistory('test.md')
    expect(history).toEqual([])
  })

  it('tracks versions across reads and saves', async () => {
    writeFileSync(join(testDir, 'test.md'), 'v1')
    await editor.readFile('test.md')

    writeFileSync(join(testDir, 'test.md'), 'v2')
    await editor.readFile('test.md')

    const history = editor.getHistory('test.md')
    expect(history.length).toBe(2)
    expect(history[0].version).toBe(1)
    expect(history[1].version).toBe(2)
    expect(history[0].source).toBe('disk')
  })
})

describe('restoreVersion', () => {
  it('restores file to a previous version', async () => {
    writeFileSync(join(testDir, 'test.md'), 'version 1')
    const { version: v1 } = await editor.readFile('test.md')

    await editor.saveFile({ path: 'test.md', content: 'version 2', diff: '', baseVersion: v1 })

    const result = await editor.restoreVersion('test.md', v1)
    expect(result.conflict).toBe(false)
    expect(readFileSync(join(testDir, 'test.md'), 'utf-8')).toBe('version 1')
  })

  it('throws for non-existent version', async () => {
    writeFileSync(join(testDir, 'test.md'), 'hello')
    await editor.readFile('test.md')
    await expect(editor.restoreVersion('test.md', 999)).rejects.toThrow('Version 999 not found')
  })
})

describe('watchFile', () => {
  it('emits file_changed on disk modification', async () => {
    writeFileSync(join(testDir, 'watch.md'), 'initial')
    await editor.readFile('watch.md')

    const onChange = vi.fn()
    editor.watchFile('watch.md', onChange)

    // Wait for watcher to be ready
    await new Promise(r => setTimeout(r, 200))

    // Modify file
    writeFileSync(join(testDir, 'watch.md'), 'modified')

    // Wait for chokidar debounce
    await new Promise(r => setTimeout(r, 500))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'watch.md',
        content: 'modified',
        source: 'disk',
      }),
    )
  })
})

describe('destroy', () => {
  it('cleans up without errors', async () => {
    writeFileSync(join(testDir, 'test.md'), 'hello')
    await editor.readFile('test.md')
    editor.watchFile('test.md', () => {})
    editor.destroy()
    // Should not throw
  })
})
