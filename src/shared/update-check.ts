/**
 * Check for rclaude updates via the GitHub API.
 * Used by both CLI flags (--rclaude-version, --rclaude-check-update)
 * and the MCP check_update tool.
 */
import { BUILD_VERSION } from './version'

export interface UpdateCheckResult {
  current: {
    hash: string
    hashShort: string
    branch: string
    repo: string
    buildTime: string
    dirty: boolean
    recentCommits: Array<{ hash: string; message: string }>
  }
  upToDate: boolean
  behindBy?: number
  latestHash?: string
  changes?: Array<{ hash: string; message: string }>
  error?: string
}

export function getVersionInfo(): UpdateCheckResult['current'] {
  return {
    hash: BUILD_VERSION.gitHash,
    hashShort: BUILD_VERSION.gitHashShort,
    branch: BUILD_VERSION.branch,
    repo: BUILD_VERSION.githubRepo,
    buildTime: BUILD_VERSION.buildTime,
    dirty: BUILD_VERSION.dirty,
    recentCommits: BUILD_VERSION.recentCommits,
  }
}

export function formatVersion(claudeCodeVersion?: string): string {
  const v = getVersionInfo()
  const lines = [`rclaude wrapper ${v.hashShort} (built ${v.buildTime})`]
  lines.push(`  commit: ${v.hash}`)
  if (v.branch) lines.push(`  branch: ${v.branch}`)
  if (v.repo) lines.push(`  repo:   ${v.repo}`)
  if (claudeCodeVersion) lines.push(`  Claude Code CLI: ${claudeCodeVersion}`)
  if (v.recentCommits.length > 0) {
    lines.push('  recent:')
    for (const c of v.recentCommits) {
      lines.push(`    ${c.hash} ${c.message}`)
    }
  }
  return lines.join('\n')
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = getVersionInfo()
  const result: UpdateCheckResult = { current, upToDate: true }

  if (!current.repo) {
    result.error = 'No GitHub repo was captured at build time — cannot check for updates.'
    return result
  }

  const url = `https://api.github.com/repos/${current.repo}/commits/${encodeURIComponent(current.branch)}`
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'rclaude' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      result.error = `GitHub API returned ${res.status} for ${current.repo}@${current.branch}`
      return result
    }
    const data = (await res.json()) as { sha: string }
    const remoteHead = data.sha

    if (remoteHead === current.hash) {
      return result
    }

    result.upToDate = false
    result.latestHash = remoteHead

    // Fetch commit comparison
    const compareUrl = `https://api.github.com/repos/${current.repo}/compare/${current.hash.slice(0, 7)}...${remoteHead.slice(0, 7)}`
    const compareRes = await fetch(compareUrl, {
      headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'rclaude' },
      signal: AbortSignal.timeout(10_000),
    })

    if (compareRes.ok) {
      const compare = (await compareRes.json()) as {
        ahead_by: number
        commits: Array<{ sha: string; commit: { message: string } }>
      }
      result.behindBy = compare.ahead_by
      result.changes = compare.commits.slice(-15).map(c => ({
        hash: c.sha.slice(0, 7),
        message: c.commit.message.split('\n')[0],
      }))
    }

    return result
  } catch (err) {
    result.error = `Could not reach GitHub: ${err instanceof Error ? err.message : err}`
    return result
  }
}

export function formatUpdateResult(result: UpdateCheckResult, claudeCodeVersion?: string): string {
  const lines = [formatVersion(claudeCodeVersion), '']

  if (result.error) {
    lines.push(result.error)
    return lines.join('\n')
  }

  if (result.upToDate) {
    lines.push(`Up to date with ${result.current.repo}@${result.current.branch}.`)
    return lines.join('\n')
  }

  const behind = result.behindBy ? `${result.behindBy} commit(s)` : 'commits'
  lines.push(`Update available: ${behind} behind ${result.current.repo}@${result.current.branch}`)
  lines.push(`  installed: ${result.current.hash.slice(0, 7)}`)
  lines.push(`  latest:    ${result.latestHash?.slice(0, 7)}`)

  if (result.changes && result.changes.length > 0) {
    lines.push('')
    lines.push('Changes:')
    for (const c of result.changes) {
      lines.push(`  ${c.hash} ${c.message}`)
    }
    if (result.behindBy && result.behindBy > 15) {
      lines.push(`  ... and ${result.behindBy - 15} more`)
    }
  }

  lines.push('')
  lines.push('To update: cd <repo> && git pull && bun run build:client')

  return lines.join('\n')
}
