/**
 * Agent transcript views: renders subagent transcripts inline within the main transcript.
 * AgentTranscriptInline fetches + displays, AgentTranscriptEntries renders grouped entries.
 */

import { useMemo, useState } from 'react'
import { fetchSubagentTranscript, useConversationsStore } from '@/hooks/use-sessions'
import type { TranscriptContentBlock, TranscriptEntry } from '@/lib/types'
import { cn } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'
import { Markdown } from '../markdown'
import { buildResultMap, type DisplayGroup, groupEntries } from './grouping'
import { Collapsible } from './shared'
import { ToolLine } from './tool-line'

// Inline expandable agent transcript - live via store subscription + HTTP seed
export function AgentTranscriptInline({ agentId, toolId }: { agentId: string; toolId?: string }) {
  const sessionId = useConversationsStore(state => state.selectedSessionId)
  const storeKey = sessionId ? `${sessionId}:${agentId}` : ''
  const liveEntries = useConversationsStore(state => (storeKey ? state.subagentTranscripts[storeKey] : undefined))
  const [fetched, setFetched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const collapsibleId = toolId ? `agent-transcript-${toolId}` : `agent-transcript-${agentId}`

  function handleExpand() {
    if (fetched || loading || !sessionId) return
    setLoading(true)
    fetchSubagentTranscript(sessionId, agentId)
      .then(data => {
        setFetched(true)
        setLoading(false)
        if (data.length > 0) {
          const key = `${sessionId}:${agentId}`
          useConversationsStore.setState(state => ({
            subagentTranscripts: { ...state.subagentTranscripts, [key]: data },
          }))
        }
      })
      .catch(err => {
        setError(err.message || 'Failed to fetch')
        setLoading(false)
      })
  }

  const entries = liveEntries || null

  return (
    <Collapsible id={collapsibleId} label="agent transcript" onExpand={handleExpand}>
      {loading && <div className="text-[10px] text-muted-foreground animate-pulse">loading transcript...</div>}
      {error && <div className="text-[10px] text-red-400">Error: {error}</div>}
      {entries && entries.length === 0 && (
        <div className="text-[10px] text-muted-foreground">No transcript entries</div>
      )}
      {entries && entries.length > 0 && <AgentTranscriptEntries entries={entries} />}
    </Collapsible>
  )
}

// Render agent transcript entries in a compact format
function AgentTranscriptEntries({ entries }: { entries: TranscriptEntry[] }) {
  const resultMap = useMemo(() => buildResultMap(entries), [entries])
  const groups = useMemo(() => groupEntries(entries), [entries])

  return (
    <div className="space-y-2 border-l-2 border-pink-400/30 pl-3">
      {groups.map((group, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: transcript groups are ordered, no stable IDs
        <AgentGroupView key={i} group={group} resultMap={resultMap} />
      ))}
    </div>
  )
}

// Simplified group view for agent transcripts (no virtualizer needed)
function AgentGroupView({
  group,
  resultMap,
}: {
  group: DisplayGroup
  resultMap: Map<string, { result: string; extra?: Record<string, unknown> }>
}) {
  const expandAll = useConversationsStore(state => state.expandAll)
  const showThinking = useConversationsStore(state => state.controlPanelPrefs.showThinking)
  const globalSettings = useConversationsStore(state => state.globalSettings)

  if (group.type === 'system') return null

  const isUser = group.type === 'user'

  type AgentItem =
    | { kind: 'text'; text: string }
    | { kind: 'thinking'; text: string; encryptedBytes?: number; rawBlock?: TranscriptContentBlock }
    | { kind: 'tool'; tool: TranscriptContentBlock; result?: string; extra?: Record<string, unknown> }

  const content: AgentItem[] = []
  for (const entry of group.entries) {
    const c = (entry as { message?: { content?: string | TranscriptContentBlock[] } }).message?.content
    if (typeof c === 'string') {
      if (c.trim()) content.push({ kind: 'text', text: c })
    } else if (Array.isArray(c)) {
      for (const block of c) {
        if (block.type === 'text' && block.text?.trim()) {
          content.push({ kind: 'text', text: block.text })
        } else if (block.type === 'thinking') {
          const raw = block.thinking || block.text
          const text = typeof raw === 'string' ? raw : ''
          if (text.trim()) {
            content.push({ kind: 'thinking', text })
          } else if (block.signature) {
            content.push({
              kind: 'thinking',
              text: '',
              encryptedBytes: block.signature.length,
              rawBlock: block,
            })
          }
        } else if (block.type === 'tool_use') {
          const res = block.id ? resultMap.get(block.id) : undefined
          content.push({ kind: 'tool', tool: block, result: res?.result, extra: res?.extra })
        }
      }
    }
  }

  if (content.length === 0) return null
  const userTag = (globalSettings.userLabel as string)?.trim() || 'USER'
  const agentTag = (globalSettings.agentLabel as string)?.trim() || 'AGENT'
  const label = isUser ? userTag : agentTag
  const customColor = isUser
    ? (globalSettings.userColor as string)?.trim()
    : (globalSettings.agentColor as string)?.trim()
  const labelColor = customColor || (isUser ? 'text-event-prompt' : 'text-pink-400')
  const sizeKey = (isUser ? (globalSettings.userSize as string) : (globalSettings.agentSize as string)) || ''
  const sizeClass =
    { xs: 'text-[7px]', sm: 'text-[8px]', '': 'text-[9px]', lg: 'text-[11px]', xl: 'text-[13px]' }[sizeKey] ||
    'text-[9px]'

  return (
    <div className={cn('text-xs', group.queued && 'opacity-50')}>
      <span
        className={cn(sizeClass, 'font-bold uppercase', !customColor && labelColor)}
        style={customColor ? { color: customColor } : undefined}
      >
        {label}
      </span>
      {group.queued && <span className="ml-2 text-[9px] font-mono text-amber-400/70 animate-pulse">queued</span>}
      <div className="pl-2 space-y-1">
        {content.map((item, i) => {
          if (item.kind === 'thinking') {
            if (!showThinking && !expandAll) return null
            const isEncrypted = !item.text && typeof item.encryptedBytes === 'number'
            const estBytes = isEncrypted ? Math.round((item.encryptedBytes as number) * 0.75) : 0
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
              <div key={i} className="border-l-2 border-purple-400/40 pl-2 py-1">
                <div className="text-[10px] text-purple-400/70 uppercase font-bold tracking-wider mb-1 flex items-center gap-1.5">
                  <span>thinking</span>
                  {isEncrypted && (
                    <>
                      <span className="text-purple-400/40 normal-case font-normal tracking-normal">
                        encrypted, ~{estBytes}b
                      </span>
                      {item.rawBlock && (
                        <JsonInspector
                          title="encrypted thinking block"
                          data={item.rawBlock as unknown as Record<string, unknown>}
                        />
                      )}
                    </>
                  )}
                </div>
                {isEncrypted ? (
                  <div className="text-[10px] text-muted-foreground/50 italic font-mono">
                    Claude 4.7 ships thinking encrypted. Plaintext unavailable to client.
                  </div>
                ) : (
                  <div className="text-[11px] opacity-75">
                    <Markdown>{item.text}</Markdown>
                  </div>
                )}
              </div>
            )
          }
          if (item.kind === 'text') {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
              <div key={i} className="text-[11px]">
                <Markdown>{item.text}</Markdown>
              </div>
            )
          }
          if (item.kind === 'tool') {
            // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
            return <ToolLine key={i} tool={item.tool} result={item.result} toolUseResult={item.extra} />
          }
          return null
        })}
      </div>
    </div>
  )
}
