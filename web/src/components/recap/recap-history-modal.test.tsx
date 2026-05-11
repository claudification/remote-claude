import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RecapSummary } from '@shared/protocol'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RecapHistoryModal } from './recap-history-modal'

function summary(overrides: Partial<RecapSummary> = {}): RecapSummary {
  return {
    id: 'recap_1',
    projectUri: 'claude://default/p/foo',
    periodLabel: 'last_7',
    periodStart: 1715000000000,
    periodEnd: 1715600000000,
    status: 'done',
    title: 'Foo recap',
    subtitle: 'something happened',
    createdAt: 1715600000000,
    completedAt: 1715600000000,
    llmCostUsd: 0.01,
    progress: 100,
    model: 'anthropic/claude-haiku-4.5',
    ...overrides,
  }
}

function dispatchOpen(projectUri?: string) {
  window.dispatchEvent(new CustomEvent('rclaude-recap-history-open', { detail: { projectUri } }))
}

function mockRecaps(items: RecapSummary[]) {
  vi.spyOn(window, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ recaps: items }), { status: 200 }),
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RecapHistoryModal', () => {
  test('opens, fetches, and lists recaps for the given project', async () => {
    mockRecaps([summary({ id: 'recap_a', title: 'First' }), summary({ id: 'recap_b', title: 'Second' })])
    render(<RecapHistoryModal />)
    dispatchOpen('claude://default/p/foo')
    await waitFor(() => {
      expect(screen.getByText('First')).toBeTruthy()
      expect(screen.getByText('Second')).toBeTruthy()
    })
    expect(screen.getByText(/2 recaps/)).toBeTruthy()
  })

  test('renders friendly empty state when broker returns []', async () => {
    mockRecaps([])
    render(<RecapHistoryModal />)
    dispatchOpen('claude://default/p/empty')
    await waitFor(() => {
      expect(screen.getByText(/No recaps yet/)).toBeTruthy()
    })
  })

  test('clicking a row dispatches rclaude-recap-open', async () => {
    mockRecaps([summary({ id: 'recap_clickme', title: 'Click me' })])
    let openedId: string | null = null
    const handler = (e: Event) => {
      openedId = ((e as CustomEvent).detail as { recapId: string }).recapId
    }
    window.addEventListener('rclaude-recap-open', handler)
    render(<RecapHistoryModal />)
    dispatchOpen()
    await waitFor(() => {
      expect(screen.getByText('Click me')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('Click me'))
    expect(openedId).toBe('recap_clickme')
    window.removeEventListener('rclaude-recap-open', handler)
  })

  test('shows failed status with error message', async () => {
    mockRecaps([summary({ id: 'recap_x', status: 'failed', error: 'OpenRouter 429' })])
    render(<RecapHistoryModal />)
    dispatchOpen()
    await waitFor(() => {
      expect(screen.getByText(/OpenRouter 429/)).toBeTruthy()
    })
  })
})
