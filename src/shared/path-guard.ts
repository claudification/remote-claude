/**
 * Path Guard - Validates file paths against a conversation's CWD before forwarding to wrappers.
 *
 * Uses path.resolve for normalization (handles ../, ./, etc) without filesystem access.
 * The broker doesn't have the wrapper's filesystem - this is pure string validation.
 */

import { resolve } from 'node:path'

/**
 * Check if a file path is within the given CWD after normalization.
 *
 * Returns true if the resolved path equals or is a child of the CWD.
 * Returns false for traversal attempts, relative paths, null bytes, or empty inputs.
 */
export function isPathWithinCwd(filePath: string, cwd: string): boolean {
  if (!filePath || !cwd) return false
  if (filePath.includes('\0')) return false

  // Resolve relative paths against the CWD (e.g. "DOMAINS.md" -> "/projects/foo/DOMAINS.md")
  const resolvedPath = filePath.startsWith('/') ? resolve(filePath) : resolve(cwd, filePath)
  const resolvedCwd = resolve(cwd)

  return resolvedPath === resolvedCwd || resolvedPath.startsWith(`${resolvedCwd}/`)
}
