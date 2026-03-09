/**
 * Path Jail - Ironclad filesystem access control
 *
 * All file reads in the concentrator MUST go through this module.
 * Resolves symlinks, blocks traversal, and enforces allowed directory roots.
 */

import { realpathSync } from 'node:fs'

// Allowed root directories for file access - set at startup
const allowedRoots: string[] = []

// Path mappings: host path prefix -> container path prefix
// Used when transcripts are mounted at a different path than the host reports
const pathMappings: Array<{ from: string; to: string }> = []

/**
 * Register a path mapping (e.g. host /Users/jonas/.claude -> container /data/transcripts)
 */
export function addPathMapping(from: string, to: string): void {
  pathMappings.push({ from, to })
}

/**
 * Apply path mappings to translate host paths to container paths
 */
function applyMappings(filePath: string): string {
  for (const { from, to } of pathMappings) {
    if (filePath === from || filePath.startsWith(`${from}/`)) {
      return to + filePath.slice(from.length)
    }
  }
  return filePath
}

/**
 * Register an allowed root directory.
 * All file access will be restricted to these directories.
 * Resolves symlinks on the root itself at registration time.
 */
export function addAllowedRoot(dir: string): void {
  try {
    const resolved = realpathSync(dir)
    if (!allowedRoots.includes(resolved)) {
      allowedRoots.push(resolved)
    }
  } catch {
    // Directory doesn't exist yet - store as-is, will be checked at access time
    if (!allowedRoots.includes(dir)) {
      allowedRoots.push(dir)
    }
  }
}

/**
 * Validate and resolve a file path against the jail.
 *
 * Returns the resolved absolute path if it's within an allowed root.
 * Returns null if the path escapes the jail or is invalid.
 *
 * Security guarantees:
 * - Resolves ALL symlinks via realpath (no symlink escapes)
 * - Blocks .., /./, null bytes, and any traversal tricks
 * - Final resolved path MUST start with an allowed root
 */
export function resolveInJail(filePath: string): string | null {
  // Block null bytes (classic C-string truncation attack)
  if (filePath.includes('\0')) return null

  // Must be absolute
  if (!filePath.startsWith('/')) return null

  // No allowed roots configured = deny everything
  if (allowedRoots.length === 0) return null

  // Apply path mappings (host -> container path translation)
  const mapped = applyMappings(filePath)

  try {
    // realpath resolves ALL symlinks and normalizes the path
    // This is the nuclear option - no traversal trick survives realpath
    const resolved = realpathSync(mapped)

    // Check if resolved path falls within any allowed root
    for (const root of allowedRoots) {
      if (resolved === root || resolved.startsWith(`${root}/`)) {
        return resolved
      }
    }

    // Path exists but is outside the jail
    return null
  } catch {
    // File doesn't exist or permission denied - reject
    return null
  }
}

/**
 * Get the list of currently allowed roots (for debugging/logging)
 */
export function getAllowedRoots(): readonly string[] {
  return allowedRoots
}
