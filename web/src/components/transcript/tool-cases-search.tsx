import type { ReactNode } from 'react'
import { Markdown } from '@/components/markdown'
import type { ToolDisplayKey } from '@/lib/control-panel-prefs'
import { FileListResults, GlobSummary, GrepContentResults, GrepCountResults, GrepSummary } from './grep-results'
import { TruncatedPre } from './shared'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'

export function renderWebSearch({ input, result }: ToolCaseInput): ToolCaseResult {
  const query = input.query as string
  let details = null
  if (result) {
    details = (
      <div className="max-h-96 overflow-y-auto rounded border border-border/30 bg-black/20 px-3 py-2 text-[11px]">
        <Markdown>{result}</Markdown>
      </div>
    )
  }
  return { summary: query, details }
}

export function renderWebFetch({ input, result }: ToolCaseInput): ToolCaseResult {
  const url = input.url as string
  let summary: string
  try {
    const parsed = new URL(url)
    summary = parsed.hostname + parsed.pathname
  } catch {
    summary = url
  }
  let details = null
  if (result) {
    details = <TruncatedPre text={result} tool="WebFetch" />
  }
  return { summary, details }
}

export function renderGlobGrep(name: string, { input, result, toolUseResult, isError }: ToolCaseInput): ToolCaseResult {
  const pattern = input.pattern as string
  const grepPath = (input.path as string) || ''
  const grepGlob = (input.glob as string) || ''
  const extra = toolUseResult as
    | {
        mode?: 'files_with_matches' | 'content' | 'count'
        filenames?: string[]
        numFiles?: number
        numMatches?: number
        numLines?: number
        content?: string
        truncated?: boolean
      }
    | undefined
  const filenames = Array.isArray(extra?.filenames) ? extra.filenames : undefined
  const mode = name === 'Glob' ? undefined : extra?.mode || (filenames ? 'files_with_matches' : undefined)

  let grepHighlight: RegExp | undefined
  if (pattern) {
    try {
      grepHighlight = new RegExp(pattern, input['-i'] ? 'gi' : 'g')
    } catch {
      // Invalid regex - skip highlighting
    }
  }

  let summary: ReactNode
  if (name === 'Glob') {
    summary = (
      <GlobSummary
        pattern={pattern}
        path={grepPath || undefined}
        numFiles={extra?.numFiles ?? filenames?.length}
        truncated={extra?.truncated}
        isError={isError}
      />
    )
  } else {
    summary = (
      <GrepSummary
        pattern={pattern}
        path={grepPath || undefined}
        glob={grepGlob || undefined}
        numFiles={extra?.numFiles ?? filenames?.length}
        numMatches={extra?.numMatches}
        numLines={extra?.numLines}
        mode={mode}
        isError={isError}
      />
    )
  }

  let details: ReactNode = null
  if (!isError) {
    if (mode === 'content' && extra?.content) {
      details = (
        <GrepContentResults
          content={extra.content}
          filenames={filenames ?? []}
          numLines={extra.numLines}
          numFiles={extra.numFiles}
          highlight={grepHighlight}
        />
      )
    } else if (mode === 'count' && extra?.content) {
      details = <GrepCountResults content={extra.content} numMatches={extra.numMatches} numFiles={extra.numFiles} />
    } else if (filenames) {
      details = (
        <FileListResults
          filenames={filenames}
          numFiles={extra?.numFiles}
          truncated={extra?.truncated}
          emptyLabel={name === 'Glob' ? 'No files matched' : 'No matches'}
        />
      )
    } else if (result) {
      details = <TruncatedPre text={result} tool={name as ToolDisplayKey} highlight={grepHighlight} />
    }
  } else if (result) {
    details = <TruncatedPre text={result} tool={name as ToolDisplayKey} />
  }

  return { summary, details }
}
