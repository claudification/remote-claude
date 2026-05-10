import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Session } from '@/lib/types'

vi.mock('@/hooks/use-conversations', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    fetchSubagentTranscript: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('./conversation-detail/conversation-banners', () => ({
  AskQuestionBanners: () => <div data-testid="ask-question-banners" />,
  ClipboardBanners: () => <div data-testid="clipboard-banners" />,
}))
vi.mock('./conversation-detail/conversation-header', () => ({
  ConversationHeader: (props: { session: unknown }) => (
    <div data-testid="conversation-header" data-session={!!props.session} />
  ),
}))
vi.mock('./conversation-detail/conversation-input', () => ({
  DialogOverlay: () => <div data-testid="dialog-overlay" />,
  InputBar: () => <div data-testid="input-bar" />,
}))
vi.mock('./conversation-detail/conversation-tabs', () => ({
  ConversationTabs: () => <div data-testid="conversation-tabs" />,
}))
vi.mock('./conversation-detail/empty-state', () => ({
  EmptyState: () => <div data-testid="empty-state" />,
}))
vi.mock('./conversation-detail/revive-footer', () => ({
  ReviveFooter: (props: { canRevive: boolean; backend?: string }) => (
    <div data-testid="revive-footer" data-can-revive={props.canRevive} />
  ),
}))
vi.mock('./conversation-detail/subagent-detail-view', () => ({
  SubagentDetailView: () => <div data-testid="subagent-detail-view" />,
}))
vi.mock('./conversation-detail/tab-content-panels', () => ({
  TabContentPanels: () => <div data-testid="tab-content-panels" />,
}))
vi.mock('./conversation-detail/task-editor-overlay', () => ({
  TaskEditorOverlay: () => <div data-testid="task-editor-overlay" />,
}))
vi.mock('./conversation-detail/terminal-overlay', () => ({
  TerminalOverlay: () => <div data-testid="terminal-overlay" />,
}))
vi.mock('./share-panel', () => ({
  ShareBanner: () => <div data-testid="share-banner" />,
}))
vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ tasks: [], readTask: vi.fn(), updateTask: vi.fn(), moveTask: vi.fn() }),
}))

import { ConversationDetail } from './conversation-detail'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-session-1',
    cwd: '/home/user/project',
    status: 'idle',
    startedAt: Date.now() - 60000,
    lastActivity: Date.now(),
    eventCount: 5,
    activeSubagentCount: 0,
    totalSubagentCount: 0,
    subagents: [],
    taskCount: 0,
    pendingTaskCount: 0,
    activeTasks: [],
    pendingTasks: [],
    runningBgTaskCount: 0,
    bgTasks: [],
    teammates: [],
    project: '/home/user/project',
    ...overrides,
  } as Session
}

function setStoreState(state: Record<string, unknown>) {
  useConversationsStore.setState({
    selectedConversationId: null,
    sessionsById: {},
    events: {},
    transcripts: {},
    expandAll: false,
    showTerminal: false,
    terminalWrapperId: null,
    requestedTab: null,
    requestedTabSeq: 0,
    sentinelConnected: false,
    controlPanelPrefs: { showThinking: false, showDiag: false, sanitizePaths: true },
    permissions: {
      canAdmin: false,
      canChat: true,
      canReadTerminal: true,
      canReadFiles: true,
      canFiles: true,
      canSpawn: true,
    },
    sessionPermissions: {},
    selectedSubagentId: null,
    selectSubagent: vi.fn(),
    subagentTranscripts: {},
    pendingTaskEdit: null,
    projectSettings: {},
    ...state,
  } as unknown as ReturnType<typeof useConversationsStore.getState>)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ConversationDetail - empty state', () => {
  beforeEach(() => {
    setStoreState({ selectedConversationId: null })
  })

  it('renders EmptyState when no session selected', () => {
    render(<ConversationDetail />)
    expect(screen.getByTestId('empty-state')).toBeDefined()
  })

  it('does not render header when no session', () => {
    render(<ConversationDetail />)
    expect(screen.queryByTestId('conversation-header')).toBeNull()
  })

  it('does not render tabs when no session', () => {
    render(<ConversationDetail />)
    expect(screen.queryByTestId('conversation-tabs')).toBeNull()
  })
})

describe('ConversationDetail - active session', () => {
  beforeEach(() => {
    const session = makeSession({ status: 'idle' })
    setStoreState({
      selectedConversationId: 'test-session-1',
      sessionsById: { 'test-session-1': session },
      events: { 'test-session-1': [] },
      transcripts: { 'test-session-1': [] },
    })
  })

  it('renders conversation header', () => {
    render(<ConversationDetail />)
    expect(screen.getByTestId('conversation-header')).toBeDefined()
  })

  it('renders conversation tabs', () => {
    render(<ConversationDetail />)
    expect(screen.getByTestId('conversation-tabs')).toBeDefined()
  })

  it('renders tab content panels', () => {
    render(<ConversationDetail />)
    expect(screen.getByTestId('tab-content-panels')).toBeDefined()
  })

  it('renders input bar for active session with chat permission', () => {
    render(<ConversationDetail />)
    expect(screen.getByTestId('input-bar')).toBeDefined()
  })

  it('renders dialog overlay', () => {
    render(<ConversationDetail />)
    expect(screen.getByTestId('dialog-overlay')).toBeDefined()
  })

  it('does not render EmptyState', () => {
    render(<ConversationDetail />)
    expect(screen.queryByTestId('empty-state')).toBeNull()
  })

  it('does not render revive footer for active session', () => {
    render(<ConversationDetail />)
    expect(screen.queryByTestId('revive-footer')).toBeNull()
  })

  it('renders clipboard banners', () => {
    render(<ConversationDetail />)
    expect(screen.getByTestId('clipboard-banners')).toBeDefined()
  })
})

describe('ConversationDetail - ended session', () => {
  beforeEach(() => {
    const session = makeSession({ status: 'ended' })
    setStoreState({
      selectedConversationId: 'test-session-1',
      sessionsById: { 'test-session-1': session },
      events: { 'test-session-1': [] },
      transcripts: { 'test-session-1': [] },
      sentinelConnected: true,
    })
  })

  it('renders revive footer when ended + sentinel connected + canSpawn', () => {
    render(<ConversationDetail />)
    expect(screen.getByTestId('revive-footer')).toBeDefined()
  })

  it('does not render input bar for ended session', () => {
    render(<ConversationDetail />)
    expect(screen.queryByTestId('input-bar')).toBeNull()
  })
})

describe('ConversationDetail - ended without spawn permission', () => {
  beforeEach(() => {
    const session = makeSession({ status: 'ended' })
    setStoreState({
      selectedConversationId: 'test-session-1',
      sessionsById: { 'test-session-1': session },
      events: { 'test-session-1': [] },
      transcripts: { 'test-session-1': [] },
      sentinelConnected: true,
      permissions: {
        canAdmin: false,
        canChat: true,
        canReadTerminal: true,
        canReadFiles: true,
        canFiles: true,
        canSpawn: false,
      },
    })
  })

  it('does not render revive footer without canSpawn', () => {
    render(<ConversationDetail />)
    expect(screen.queryByTestId('revive-footer')).toBeNull()
  })
})

describe('ConversationDetail - ended without sentinel', () => {
  beforeEach(() => {
    const session = makeSession({ status: 'ended' })
    setStoreState({
      selectedConversationId: 'test-session-1',
      sessionsById: { 'test-session-1': session },
      events: { 'test-session-1': [] },
      transcripts: { 'test-session-1': [] },
      sentinelConnected: false,
    })
  })

  it('still renders revive footer (button disabled internally)', () => {
    render(<ConversationDetail />)
    expect(screen.getByTestId('revive-footer')).toBeDefined()
  })
})

describe('ConversationDetail - admin permissions', () => {
  beforeEach(() => {
    const session = makeSession({ status: 'idle' })
    setStoreState({
      selectedConversationId: 'test-session-1',
      sessionsById: { 'test-session-1': session },
      events: { 'test-session-1': [] },
      transcripts: { 'test-session-1': [] },
      permissions: {
        canAdmin: true,
        canChat: true,
        canReadTerminal: true,
        canReadFiles: true,
        canFiles: true,
        canSpawn: true,
      },
    })
  })

  it('renders share banner for admin', () => {
    render(<ConversationDetail />)
    expect(screen.getByTestId('share-banner')).toBeDefined()
  })
})

describe('ConversationDetail - non-admin permissions', () => {
  beforeEach(() => {
    const session = makeSession({ status: 'idle' })
    setStoreState({
      selectedConversationId: 'test-session-1',
      sessionsById: { 'test-session-1': session },
      events: { 'test-session-1': [] },
      transcripts: { 'test-session-1': [] },
      permissions: {
        canAdmin: false,
        canChat: true,
        canReadTerminal: true,
        canReadFiles: true,
        canFiles: true,
        canSpawn: true,
      },
    })
  })

  it('does not render share banner for non-admin', () => {
    render(<ConversationDetail />)
    expect(screen.queryByTestId('share-banner')).toBeNull()
  })
})

describe('ConversationDetail - no chat permission', () => {
  beforeEach(() => {
    const session = makeSession({ status: 'idle' })
    setStoreState({
      selectedConversationId: 'test-session-1',
      sessionsById: { 'test-session-1': session },
      events: { 'test-session-1': [] },
      transcripts: { 'test-session-1': [] },
      permissions: {
        canAdmin: false,
        canChat: false,
        canReadTerminal: true,
        canReadFiles: true,
        canFiles: true,
        canSpawn: true,
      },
    })
  })

  it('does not render input bar without chat permission', () => {
    render(<ConversationDetail />)
    expect(screen.queryByTestId('input-bar')).toBeNull()
  })
})

describe('ConversationDetail - subagent view', () => {
  beforeEach(() => {
    const session = makeSession({
      status: 'idle',
      subagents: [{ agentId: 'sub-1', agentType: 'Explore', status: 'running', startedAt: 1000, eventCount: 3 }],
    })
    setStoreState({
      selectedConversationId: 'test-session-1',
      sessionsById: { 'test-session-1': session },
      events: { 'test-session-1': [] },
      transcripts: { 'test-session-1': [] },
      selectedSubagentId: 'sub-1',
      subagentTranscripts: {},
    })
  })

  it('renders subagent detail view', () => {
    render(<ConversationDetail />)
    expect(screen.getByTestId('subagent-detail-view')).toBeDefined()
  })

  it('does not render tabs when viewing subagent', () => {
    render(<ConversationDetail />)
    expect(screen.queryByTestId('conversation-tabs')).toBeNull()
  })

  it('does not render tab content panels when viewing subagent', () => {
    render(<ConversationDetail />)
    expect(screen.queryByTestId('tab-content-panels')).toBeNull()
  })

  it('does not render input bar when viewing subagent', () => {
    render(<ConversationDetail />)
    expect(screen.queryByTestId('input-bar')).toBeNull()
  })
})

describe('ConversationDetail - terminal overlay', () => {
  beforeEach(() => {
    const session = makeSession({ status: 'idle' })
    setStoreState({
      selectedConversationId: 'test-session-1',
      sessionsById: { 'test-session-1': session },
      events: { 'test-session-1': [] },
      transcripts: { 'test-session-1': [] },
      showTerminal: true,
      terminalWrapperId: 'test-session-1',
    })
  })

  it('renders terminal overlay when showTerminal + terminalWrapperId', () => {
    render(<ConversationDetail />)
    expect(screen.getByTestId('terminal-overlay')).toBeDefined()
  })
})

describe('ConversationDetail - terminal overlay hidden', () => {
  beforeEach(() => {
    const session = makeSession({ status: 'idle' })
    setStoreState({
      selectedConversationId: 'test-session-1',
      sessionsById: { 'test-session-1': session },
      events: { 'test-session-1': [] },
      transcripts: { 'test-session-1': [] },
      showTerminal: false,
      terminalWrapperId: null,
    })
  })

  it('does not render terminal overlay when hidden', () => {
    render(<ConversationDetail />)
    expect(screen.queryByTestId('terminal-overlay')).toBeNull()
  })
})
