import type { CommitDigest, PeriodScope } from './types'

/**
 * Phase 3 stub. Phase 4 wires this to the sentinel git_log RPC.
 * Returns an empty per-project array so the rest of the pipeline can run
 * without git data; the recap builder treats missing commits as "no
 * commit data available for this period".
 */
export function gatherCommitsStub(scope: PeriodScope): CommitDigest {
  return {
    perProject: scope.projectUris.map(projectUri => ({
      projectUri,
      cwd: parseCwdFromUri(projectUri),
      commits: [],
    })),
  }
}

function parseCwdFromUri(uri: string): string {
  if (uri === '*') return ''
  const match = uri.match(/^claude:\/\/[^/]*(\/.*)$/)
  return match ? match[1] : ''
}
