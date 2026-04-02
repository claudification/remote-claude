/**
 * Permission auto-approve rules for rclaude.
 *
 * Two sources of rules, checked in order:
 * 1. Project-level: .claude/rclaude.json (per-project, Write/Edit path patterns)
 * 2. Session-level: in-memory Set<toolName> (from dashboard "ALWAYS ALLOW" button, dies with process)
 *
 * Only Write and Edit are supported for project-level rules. These are the tools
 * that trigger CC's protected-directory permission prompts for .claude/, .git/, etc.
 * All other tool permissions are handled by Claude Code's own permission system.
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

interface PermissionConfig {
  permissions?: {
    Write?: { allow?: string[] }
    Edit?: { allow?: string[] }
  }
}

interface RulesEngine {
  shouldAutoApprove(toolName: string, inputPreview: string): boolean
  addSessionRule(toolName: string): void
  removeSessionRule(toolName: string): void
  getSessionRules(): string[]
  getProjectRulesSummary(): Record<string, string[]>
}

function matchGlob(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

function extractFilePath(inputPreview: string): string | undefined {
  try {
    const input = JSON.parse(inputPreview)
    return (input.file_path || input.path) as string | undefined
  } catch {
    return inputPreview.match(/"file_path"\s*:\s*"([^"]+)"/)?.[1]
  }
}

export function createRulesEngine(cwd: string): RulesEngine {
  let projectRules: PermissionConfig = {}
  const configPath = join(cwd, '.claude', 'rclaude.json')
  if (existsSync(configPath)) {
    try {
      projectRules = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch (err) {
      console.error(`[permission-rules] Failed to parse ${configPath}: ${err instanceof Error ? err.message : err}`)
    }
  }

  const sessionRules = new Set<string>()

  function checkProjectRules(toolName: string, inputPreview: string): boolean {
    if (toolName !== 'Write' && toolName !== 'Edit') return false

    const patterns = projectRules.permissions?.[toolName]?.allow
    if (!patterns?.length) return false

    const filePath = extractFilePath(inputPreview)
    if (!filePath) return false

    const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath
    if (rel.startsWith('..')) return false

    return patterns.some(pattern => matchGlob(pattern, rel))
  }

  return {
    shouldAutoApprove(toolName: string, inputPreview: string): boolean {
      if (checkProjectRules(toolName, inputPreview)) return true
      if (sessionRules.has(toolName)) return true
      return false
    },

    addSessionRule(toolName: string) {
      sessionRules.add(toolName)
    },

    removeSessionRule(toolName: string) {
      sessionRules.delete(toolName)
    },

    getSessionRules(): string[] {
      return Array.from(sessionRules)
    },

    getProjectRulesSummary(): Record<string, string[]> {
      const summary: Record<string, string[]> = {}
      if (projectRules.permissions?.Write?.allow) summary.Write = projectRules.permissions.Write.allow
      if (projectRules.permissions?.Edit?.allow) summary.Edit = projectRules.permissions.Edit.allow
      return summary
    },
  }
}
