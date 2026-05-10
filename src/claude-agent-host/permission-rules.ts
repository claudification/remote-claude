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

interface FileRule {
  allow?: string[]
}

interface PermissionConfig {
  permissions?: {
    Write?: FileRule
    Edit?: FileRule
    Read?: FileRule
  }
  allowAll?: boolean // auto-approve ALL permission requests (any tool)
  allowPlanMode?: boolean // default: true
}

export interface RulesEngine {
  shouldAutoApprove(toolName: string, inputPreview: string): boolean
  addConversationRule(toolName: string): void
  removeConversationRule(toolName: string): void
  getConversationRules(): string[]
  getProjectRulesSummary(): Record<string, string[]>
  isPlanModeAllowed(): boolean
  reload(): void
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
  const configPath = join(cwd, '.rclaude', 'rclaude.json')
  if (existsSync(configPath)) {
    try {
      projectRules = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch (err) {
      console.error(`[permission-rules] Failed to parse ${configPath}: ${err instanceof Error ? err.message : err}`)
    }
  }

  const sessionRules = new Set<string>()

  // Auto-detect: projects inside a .claude/ directory get allowAll by default
  const cwdInsideDotClaude = /[/\\]\.claude([/\\]|$)/.test(cwd)
  function isAllowAll(): boolean {
    return projectRules.allowAll ?? cwdInsideDotClaude
  }

  // Built-in rules: always auto-approve rclaude's own managed paths
  const BUILTIN_PATTERNS = ['.rclaude/project/**', '.rclaude/docs/**']

  function checkBuiltinRules(toolName: string, inputPreview: string): boolean {
    if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'Read') return false
    const filePath = extractFilePath(inputPreview)
    if (!filePath) return false
    const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath
    if (rel.startsWith('..')) return false
    return BUILTIN_PATTERNS.some(pattern => matchGlob(pattern, rel))
  }

  function checkProjectRules(toolName: string, inputPreview: string): boolean {
    if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'Read') return false

    const rules = projectRules.permissions?.[toolName as keyof typeof projectRules.permissions]
    const patterns = rules?.allow
    if (!patterns?.length) return false

    const filePath = extractFilePath(inputPreview)
    if (!filePath) return false

    const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath
    // Reject paths outside CWD (../something)
    if (rel.startsWith('..')) return false

    return patterns.some(pattern => {
      // Absolute pattern: match against absolute file path directly
      if (isAbsolute(pattern)) return matchGlob(pattern, isAbsolute(filePath) ? filePath : join(cwd, filePath))
      // Relative pattern: match against relative path
      return matchGlob(pattern, rel)
    })
  }

  return {
    shouldAutoApprove(toolName: string, inputPreview: string): boolean {
      if (isAllowAll()) return true
      if (checkBuiltinRules(toolName, inputPreview)) return true
      if (checkProjectRules(toolName, inputPreview)) return true
      if (sessionRules.has(toolName)) return true
      return false
    },

    addConversationRule(toolName: string) {
      sessionRules.add(toolName)
    },

    removeConversationRule(toolName: string) {
      sessionRules.delete(toolName)
    },

    getConversationRules(): string[] {
      return Array.from(sessionRules)
    },

    getProjectRulesSummary(): Record<string, string[]> {
      const summary: Record<string, string[]> = {}
      for (const tool of ['Write', 'Edit', 'Read'] as const) {
        const patterns = projectRules.permissions?.[tool]?.allow
        if (patterns?.length) summary[tool] = patterns
      }
      return summary
    },

    isPlanModeAllowed(): boolean {
      // Env var override for spawned sessions
      if (process.env.RCLAUDE_NO_PLAN_MODE === '1') return false
      // rclaude.json setting (default: true)
      return projectRules.allowPlanMode !== false
    },

    reload() {
      if (existsSync(configPath)) {
        try {
          projectRules = JSON.parse(readFileSync(configPath, 'utf-8'))
        } catch (err) {
          console.error(
            `[permission-rules] Reload failed for ${configPath}: ${err instanceof Error ? err.message : err}`,
          )
        }
      } else {
        projectRules = {}
      }
    },
  }
}
