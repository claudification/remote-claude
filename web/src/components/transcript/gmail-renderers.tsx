/**
 * Gmail MCP tool renderers -- rich formatting for search results and thread views.
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { extractMcpText } from './shared'

interface GmailSearchThread {
  id: string
  subject: string
  from: string
  date: string
}

interface GmailAttachment {
  filename: string
  mimeType: string
  size: number
}

interface GmailThreadMessage {
  messageId: string
  threadId: string
  from: string
  to: string
  cc?: string
  bcc?: string
  subject: string
  date: string
  body: string
  labelIds: string[]
  attachments: GmailAttachment[]
}

interface GmailThread {
  threadId: string
  messageCount: number
  messages: GmailThreadMessage[]
}

function extractName(addr: string): string {
  const match = addr.match(/^(.+?)\s*</)
  return match ? match[1].trim() : addr
}

function formatDate(raw: string): string {
  try {
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) return raw
    const now = new Date()
    const sameYear = d.getFullYear() === now.getFullYear()
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    })
  } catch {
    return raw
  }
}

function formatDateTime(raw: string): string {
  try {
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) return raw
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return raw
  }
}

const LABEL_STYLES: Record<string, string> = {
  INBOX: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
  IMPORTANT: 'bg-amber-400/15 text-amber-400 border-amber-400/30',
  STARRED: 'bg-yellow-400/15 text-yellow-400 border-yellow-400/30',
  UNREAD: 'bg-sky-400/15 text-sky-400 border-sky-400/30',
  SENT: 'bg-green-400/15 text-green-400 border-green-400/30',
  DRAFT: 'bg-orange-400/15 text-orange-400 border-orange-400/30',
  TRASH: 'bg-red-400/15 text-red-400 border-red-400/30',
  SPAM: 'bg-red-400/15 text-red-400 border-red-400/30',
}

function LabelBadge({ label }: { label: string }) {
  const clean = label.replace(/^CATEGORY_/, '')
  const style = LABEL_STYLES[label] || 'bg-muted/50 text-muted-foreground border-border/30'
  return (
    <span className={cn('px-1 py-0.5 text-[8px] font-bold uppercase tracking-wider border rounded', style)}>
      {clean.toLowerCase()}
    </span>
  )
}

function parseSearchResults(text: string): GmailSearchThread[] | null {
  const threads: GmailSearchThread[] = []
  const blocks = text.split(/\n(?=ID: )/)
  for (const block of blocks) {
    const id = block.match(/^ID:\s*(.+)/m)?.[1]?.trim()
    const subject = block.match(/^Subject:\s*(.+)/m)?.[1]?.trim()
    const from = block.match(/^From:\s*(.+)/m)?.[1]?.trim()
    const date = block.match(/^Date:\s*(.+)/m)?.[1]?.trim()
    if (id && subject && from && date) {
      threads.push({ id, subject, from, date })
    }
  }
  return threads.length > 0 ? threads : null
}

function parseThread(text: string): GmailThread | null {
  try {
    const parsed = JSON.parse(text)
    if (parsed?.threadId && Array.isArray(parsed?.messages)) return parsed as GmailThread
  } catch {}
  return null
}

export function GmailSearchResults({ result, extra }: { result: string; extra?: unknown }): ReactNode {
  const text = extractMcpText(result, extra)
  if (!text) return null

  const threads = parseSearchResults(text)
  if (!threads) return null

  return (
    <div className="text-[10px] font-mono space-y-0.5">
      {threads.map(t => (
        <div key={t.id} className="flex items-baseline gap-2 px-2 py-1 rounded hover:bg-muted/30">
          <span className="text-muted-foreground/60 shrink-0 w-[52px] text-right">{formatDate(t.date)}</span>
          <span className="text-blue-400/80 shrink-0 w-[100px] truncate" title={t.from}>
            {extractName(t.from)}
          </span>
          <span className="text-foreground/80 truncate flex-1" title={t.subject}>
            {t.subject}
          </span>
          <span className="text-muted-foreground/30 shrink-0 font-mono text-[8px]">{t.id.slice(0, 8)}</span>
        </div>
      ))}
      <div className="text-muted-foreground/40 text-[9px] px-2 pt-1">
        {threads.length} thread{threads.length !== 1 ? 's' : ''}
      </div>
    </div>
  )
}

export function GmailThreadView({ result, extra }: { result: string; extra?: unknown }): ReactNode {
  const text = extractMcpText(result, extra)
  if (!text) return null

  const thread = parseThread(text)
  if (!thread) return null

  const { messages } = thread

  return (
    <div className="text-[10px] font-mono space-y-1.5">
      <div className="flex items-center gap-2 px-2 text-muted-foreground/60">
        <span className="font-bold text-foreground/70 truncate flex-1">{messages[0]?.subject}</span>
        <span>
          {thread.messageCount} msg{thread.messageCount !== 1 ? 's' : ''}
        </span>
      </div>
      {messages.map(msg => (
        <div key={msg.messageId} className="px-2 py-1.5 rounded bg-muted/20 border border-border/20 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-blue-400/80 font-bold truncate" title={msg.from}>
              {extractName(msg.from)}
            </span>
            <span className="text-muted-foreground/40">-{'>'}</span>
            <span className="text-foreground/60 truncate" title={msg.to}>
              {extractName(msg.to)}
            </span>
            <span className="text-muted-foreground/50 ml-auto shrink-0">{formatDateTime(msg.date)}</span>
          </div>
          {msg.cc && <div className="text-muted-foreground/40">cc: {msg.cc}</div>}
          {msg.labelIds.length > 0 && (
            <div className="flex gap-1 flex-wrap">
              {msg.labelIds.map(l => (
                <LabelBadge key={l} label={l} />
              ))}
            </div>
          )}
          {msg.body && (
            <div className="text-foreground/70 whitespace-pre-wrap break-words border-t border-border/20 pt-1 mt-1">
              {msg.body.length > 500 ? `${msg.body.slice(0, 500)}...` : msg.body}
            </div>
          )}
          {msg.attachments.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap text-muted-foreground/50">
              {msg.attachments.map(a => (
                <span key={a.filename} className="inline-flex items-center gap-0.5 bg-muted/30 rounded px-1 py-0.5">
                  <span className="text-cyan-400/60">{a.filename}</span>
                  {a.size > 0 && (
                    <span className="text-muted-foreground/30">
                      {a.size >= 1_000_000 ? `${(a.size / 1_000_000).toFixed(1)}MB` : `${Math.round(a.size / 1000)}KB`}
                    </span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export function GmailLabelResult({ result, extra }: { result: string; extra?: unknown }): ReactNode {
  const text = extractMcpText(result, extra)
  if (!text) return null
  return (
    <div className="text-[10px] font-mono text-green-400/80 bg-green-400/5 border border-green-400/20 rounded px-2.5 py-1.5">
      {text}
    </div>
  )
}

export function GmailDraftResult({ result, extra }: { result: string; extra?: unknown }): ReactNode {
  const text = extractMcpText(result, extra)
  if (!text) return null
  return (
    <div className="text-[10px] font-mono text-orange-400/80 bg-orange-400/5 border border-orange-400/20 rounded px-2.5 py-1.5">
      {text}
    </div>
  )
}

export function GmailSendResult({
  input,
  result,
  extra,
}: {
  input: Record<string, unknown>
  result: string
  extra?: unknown
}): ReactNode {
  const text = extractMcpText(result, extra)
  const to = Array.isArray(input.to) ? (input.to as string[]).join(', ') : (input.to as string) || ''
  const cc = Array.isArray(input.cc) ? (input.cc as string[]).join(', ') : (input.cc as string) || ''
  const subject = (input.subject as string) || '(no subject)'
  const body = (input.body as string) || ''
  const attachments = Array.isArray(input.attachments) ? (input.attachments as string[]) : []
  const threadId = (input.threadId as string) || ''

  return (
    <div className="text-[10px] font-mono space-y-1.5">
      <div className="px-2 py-1.5 rounded bg-muted/20 border border-border/20 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground/50">to:</span>
          <span className="text-blue-400/80 font-bold">{to}</span>
        </div>
        {cc && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground/50">cc:</span>
            <span className="text-foreground/60">{cc}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground/50">subj:</span>
          <span className="text-foreground/80">{subject}</span>
        </div>
        {threadId && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground/50">thread:</span>
            <span className="text-muted-foreground/60 font-mono">{threadId.slice(0, 12)}</span>
          </div>
        )}
        {body && (
          <div className="text-foreground/70 whitespace-pre-wrap break-words border-t border-border/20 pt-1 mt-1 max-h-48 overflow-y-auto">
            {body.length > 800 ? `${body.slice(0, 800)}...` : body}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex items-center gap-1.5 border-t border-border/20 pt-1 mt-1 text-muted-foreground/60">
            <span>
              {attachments.length} attachment{attachments.length !== 1 ? 's' : ''}:
            </span>
            {attachments.map(a => (
              <span key={a} className="text-cyan-400/60">
                {a.split('/').pop()}
              </span>
            ))}
          </div>
        )}
      </div>
      {text && (
        <div className="text-green-400/80 bg-green-400/5 border border-green-400/20 rounded px-2.5 py-1.5">{text}</div>
      )}
    </div>
  )
}
