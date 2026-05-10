import { checkForUpdate, formatUpdateResult } from '../../shared/update-check'
import { BUILD_VERSION } from '../../shared/version'
import { debug } from '../debug'
import type { McpToolContext, ToolDef } from './types'

export function registerIdentityTools(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    whoami: {
      description:
        'Returns extensive identity and environment information about the current session: session IDs, project, CWD, model, Claude Code version, rclaude version/git info, backend mode (headless/PTY), and auth context. Use this to understand your own identity within the rclaude ecosystem.',
      inputSchema: { type: 'object' as const, properties: {} },
      async handle() {
        const identity = ctx.getIdentity()
        const gitInfo = {
          hash: BUILD_VERSION.gitHash,
          hashShort: BUILD_VERSION.gitHashShort,
          branch: BUILD_VERSION.branch,
          buildTime: BUILD_VERSION.buildTime,
          dirty: BUILD_VERSION.dirty,
          repo: BUILD_VERSION.githubRepo,
          recentCommits: BUILD_VERSION.recentCommits,
        }

        const info: Record<string, unknown> = {
          ccSessionId: identity?.ccSessionId,
          conversationId: identity?.conversationId,
          cwd: identity?.cwd,
          model: identity?.configuredModel,
          backend: identity?.headless ? 'headless' : 'pty',
          claudeCodeVersion: identity?.claudeVersion || ctx.getClaudeCodeVersion(),
          auth: identity?.claudeAuth,
          rclaude: {
            version: `rclaude/${BUILD_VERSION.gitHashShort}`,
            git: gitInfo,
          },
          platform: {
            os: process.platform,
            arch: process.arch,
            bun: Bun.version,
            pid: process.pid,
          },
        }

        return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] }
      },
    },

    check_update: {
      description:
        'Check if a newer version of rclaude is available. Queries the GitHub API to compare the installed build against the latest commit on the branch it was built from. No arguments needed.',
      inputSchema: { type: 'object' as const, properties: {} },
      async handle() {
        const result = await checkForUpdate()
        debug(`[channel] check_update: ${result.upToDate ? 'up to date' : `${result.behindBy} behind`}`)
        return { content: [{ type: 'text', text: formatUpdateResult(result, ctx.getClaudeCodeVersion()) }] }
      },
    },
  }
}
