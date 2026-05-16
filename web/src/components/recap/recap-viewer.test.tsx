/**
 * RecapViewer modal tests. Stubs the network with a controllable mock,
 * fires rclaude-recap-open, and verifies:
 *   - loading -> rendered markdown happy path
 *   - 404 fallback shows error
 *   - streaming state when status != done
 *   - View-raw toggle
 */

import type { PeriodRecapDoc } from '@shared/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RecapViewer } from './recap-viewer'

function doneRecap(overrides: Partial<PeriodRecapDoc> = {}): PeriodRecapDoc {
  return {
    recapId: 'recap_a',
    projectUri: 'claude://default/p',
    periodLabel: 'last_7',
    periodStart: 1715000000000,
    periodEnd: 1715600000000,
    timeZone: 'UTC',
    audience: 'human',
    status: 'done',
    progress: 100,
    inputChars: 1000,
    inputTokens: 500,
    outputTokens: 250,
    llmCostUsd: 0.0123,
    title: 'Sample Recap',
    subtitle: 'WAL incident + Phase 4',
    model: 'anthropic/claude-haiku-4.5',
    createdAt: 1715000000000,
    completedAt: 1715600000000,
    markdown: '# TL;DR\n\n- Shipped Phase 4\n- Fixed WAL corruption',
    ...overrides,
  }
}

function dispatchOpen(recapId: string) {
  window.dispatchEvent(new CustomEvent('rclaude-recap-open', { detail: { recapId } }))
}

function mockFetchOnce(recap: PeriodRecapDoc | null): void {
  vi.spyOn(window, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(recap ? { recap } : { error: 'not found' }), {
        status: recap ? 200 : 404,
      }),
  )
}

afterEach(() => {
  // Radix uses portals -- explicit cleanup also unmounts the portal node so
  // the next test isn't searching across two dialogs.
  cleanup()
  vi.restoreAllMocks()
})

describe('RecapViewer', () => {
  test('renders markdown after loading a done recap', async () => {
    mockFetchOnce(doneRecap())
    render(<RecapViewer />)
    dispatchOpen('recap_a')
    await waitFor(() => {
      expect(screen.getByText('Sample Recap')).toBeTruthy()
    })
    // Subtitle italic line
    expect(screen.getByText(/WAL incident/)).toBeTruthy()
    // Action buttons present
    expect(screen.getByText('Copy markdown')).toBeTruthy()
    expect(screen.getByText('Download .md')).toBeTruthy()
    expect(screen.getByText('Share link')).toBeTruthy()
    expect(screen.getByText('View raw')).toBeTruthy()
    // Cost in header
    expect(screen.getByText(/0\.0123/)).toBeTruthy()
  })

  test('shows error when fetch returns 404', async () => {
    mockFetchOnce(null)
    render(<RecapViewer />)
    dispatchOpen('recap_missing')
    await waitFor(() => {
      expect(screen.getByText(/Recap not found/)).toBeTruthy()
    })
  })

  test('shows streaming state for non-terminal status', async () => {
    mockFetchOnce(doneRecap({ status: 'rendering', progress: 50, phase: 'render/llm', markdown: undefined }))
    render(<RecapViewer />)
    dispatchOpen('recap_a')
    await waitFor(() => {
      expect(screen.getByText(/Generating recap/)).toBeTruthy()
    })
    expect(screen.getByText('50%')).toBeTruthy()
  })

  test('toggling View raw swaps to raw markdown view', async () => {
    mockFetchOnce(doneRecap())
    render(<RecapViewer />)
    dispatchOpen('recap_a')
    await waitFor(() => {
      expect(screen.getByText('View raw')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('View raw'))
    expect(screen.getByText('View rendered')).toBeTruthy()
    // Raw <pre> contains the source string
    expect(screen.getByText(/# TL;DR/)).toBeTruthy()
  })
})
