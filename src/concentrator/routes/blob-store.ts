/**
 * Image/Blob store and shared files log.
 * Disk-backed, survives restarts.
 * Extracted here to avoid circular imports between routes.ts and sub-routers.
 */

import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

// ─── Blob store ──────────────────────────────────────────────────────────

export let blobDir = '' // set by initBlobStore()

export function initBlobStore(cacheDir: string): void {
  blobDir = join(cacheDir, 'blobs')
  mkdirSync(blobDir, { recursive: true })
  // Count existing blobs
  try {
    const count = readdirSync(blobDir).filter(f => f.endsWith('.meta')).length
    if (count > 0) console.log(`[blobs] ${count} blobs on disk`)
  } catch {
    /* empty dir */
  }
}

export function hashString(input: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(input)
  const bytes = hasher.digest()
  // Read 8 bytes as BigInt, convert to base36 for shorter URLs
  const n = bytes.readBigUInt64BE(0)
  return n.toString(36) // ~12-13 chars base36, ~10^19 combinations
}

export function registerFilePath(path: string): string {
  if (!blobDir) return hashString(path)
  // Copy file to blob store so it survives even if source disappears
  const hash = hashString(path)
  const blobPath = join(blobDir, hash)
  if (!existsSync(blobPath)) {
    try {
      const ext = path.split('.').pop()?.toLowerCase() || 'png'
      const mediaType = `image/${ext === 'jpg' ? 'jpeg' : ext}`
      writeFileSync(blobPath, readFileSync(path))
      writeFileSync(`${blobPath}.meta`, JSON.stringify({ mediaType, createdAt: Date.now() }))
    } catch {
      /* source file might not exist yet */
    }
  }
  return hash
}

export function registerBlob(data: string, mediaType: string): string {
  const key = `${data.length}:${data.slice(0, 200)}`
  const hash = hashString(key)
  if (blobDir) {
    const blobPath = join(blobDir, hash)
    if (!existsSync(blobPath)) {
      const bytes = Buffer.from(data, 'base64')
      writeFileSync(blobPath, bytes)
      writeFileSync(`${blobPath}.meta`, JSON.stringify({ mediaType, createdAt: Date.now() }))
    }
  }
  return hash
}

/** Stream request body to temp file, compute full SHA256, rename to content hash. O(1) memory. */
export async function storeBlobStreaming(
  body: ReadableStream<Uint8Array>,
  mediaType: string,
): Promise<{ hash: string; size: number }> {
  const tempPath = join(blobDir, `_upload_${randomUUID()}`)
  const hasher = new Bun.CryptoHasher('sha256')
  const writer = Bun.file(tempPath).writer()
  let size = 0

  try {
    for await (const chunk of body) {
      hasher.update(chunk)
      writer.write(chunk)
      size += chunk.byteLength
    }
    await writer.end()

    // Content-based hash (full SHA256, not just first 200 bytes)
    const digest = hasher.digest()
    const n = digest.readBigUInt64BE(0)
    const hash = n.toString(36)

    const blobPath = join(blobDir, hash)
    if (existsSync(blobPath)) {
      // Dedup: identical content already stored
      unlinkSync(tempPath)
    } else {
      renameSync(tempPath, blobPath)
      writeFileSync(`${blobPath}.meta`, JSON.stringify({ mediaType, size, createdAt: Date.now() }))
    }

    return { hash, size }
  } catch (err) {
    // Clean up temp file on any error
    try {
      unlinkSync(tempPath)
    } catch {}
    throw err
  }
}

// ─── Shared files + clipboard log (per-CWD, server-side) ─────────────────

export interface SharedFileEntry {
  type: 'file' | 'clipboard'
  hash: string
  filename: string
  mediaType: string
  cwd?: string // project directory (primary query key)
  sessionId?: string // for attribution
  size: number
  url: string
  text?: string // clipboard text content
  dismissed?: boolean
  createdAt: number
}

let sharedFilesLogPath: string | null = null
const SHARED_FILES_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

export function initSharedFilesLog(cacheDir: string): void {
  sharedFilesLogPath = join(cacheDir, 'shared-files.jsonl')
}

export function appendSharedFile(entry: SharedFileEntry): void {
  if (!sharedFilesLogPath) return
  try {
    appendFileSync(sharedFilesLogPath, `${JSON.stringify(entry)}\n`)
  } catch {
    // First write or permission issue
  }
}

export function readSharedFiles(): SharedFileEntry[] {
  if (!sharedFilesLogPath || !existsSync(sharedFilesLogPath)) return []
  try {
    const cutoff = Date.now() - SHARED_FILES_MAX_AGE_MS
    return readFileSync(sharedFilesLogPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as SharedFileEntry)
      .filter(e => e.createdAt > cutoff && !e.dismissed)
      .reverse() // newest first
  } catch {
    return []
  }
}

export function dismissSharedFile(hash: string): boolean {
  if (!sharedFilesLogPath || !existsSync(sharedFilesLogPath)) return false
  try {
    const lines = readFileSync(sharedFilesLogPath, 'utf-8').trim().split('\n').filter(Boolean)
    const updated = lines.map(line => {
      const entry = JSON.parse(line) as SharedFileEntry
      if (entry.hash === hash) return JSON.stringify({ ...entry, dismissed: true })
      return line
    })
    writeFileSync(sharedFilesLogPath, `${updated.join('\n')}\n`)
    return true
  } catch {
    return false
  }
}

// ─── MIME type helpers ────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'svg']

export function mediaTypeToExt(mediaType: string, fallback = 'bin'): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/heic': 'heic',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
    'application/json': 'json',
    'application/zip': 'zip',
    'text/plain': 'txt',
    'text/html': 'html',
    'text/css': 'css',
    'application/octet-stream': 'bin',
  }
  if (map[mediaType]) return map[mediaType]
  // Fallback: use MIME subtype if it looks like a clean extension (no hyphens/plus)
  const sub = mediaType.split('/')[1] || ''
  if (sub && /^[a-z0-9]+$/i.test(sub)) return sub
  return fallback
}

export function processImagesInEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const images: Array<{ hash: string; ext: string; url: string; originalPath: string }> = []
  let modified = false

  const msg = entry?.message as Record<string, unknown> | undefined
  const content = msg?.content
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const block = content[i] as Record<string, unknown> | undefined
      const source = block?.source as Record<string, unknown> | undefined
      if (block?.type === 'image' && source?.type === 'base64' && source?.data && source?.media_type) {
        const mt = source.media_type as string
        const ext = mediaTypeToExt(mt)
        const hash = registerBlob(source.data as string, mt)
        images.push({ hash, ext, url: `/file/${hash}.${ext}`, originalPath: `inline:${mt}` })
        if (!modified) {
          entry = { ...entry, message: { ...msg, content: [...content] } }
          modified = true
        }
        const entryMsg = entry.message as Record<string, unknown>
        ;(entryMsg.content as unknown[])[i] = { type: 'text', text: `[Image: ${hash}.${ext}]` }
      }
    }
  }

  const imagePattern = /\[Image:\s*source:\s*([^\]]+)\]/gi
  function scanText(value: unknown): void {
    if (typeof value === 'string') {
      let match: RegExpExecArray | null = imagePattern.exec(value)
      while (match !== null) {
        const imagePath = match[1].trim()
        const ext = imagePath.split('.').pop()?.toLowerCase() || 'png'
        if (IMAGE_EXTENSIONS.includes(ext)) {
          const hash = registerFilePath(imagePath)
          if (!images.some(img => img.hash === hash)) {
            images.push({ hash, ext, url: `/file/${hash}.${ext}`, originalPath: imagePath })
          }
        }
        match = imagePattern.exec(value)
      }
    } else if (Array.isArray(value)) {
      value.forEach(scanText)
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(scanText)
    }
  }
  scanText(entry)

  if (images.length > 0) return { ...entry, images }
  return entry
}
