import type { TranscriptContentBlock } from '@/lib/types'
import type { RenderableTranscriptEntry, RenderItem, ResultLookup } from './group-view-types'

const PROJECT_TASK_RE = /^<project-task\s+([^>]*)>([\s\S]*?)<\/project-task>$/

function parseProjectTask(text: string): RenderItem | null {
  const m = text.trim().match(PROJECT_TASK_RE)
  if (!m) return null
  const attrs = m[1]
  const body = m[2].trim()
  const attr = (name: string) => {
    const a = attrs.match(new RegExp(`${name}="([^"]*?)"`))
    return a?.[1]
  }
  const id = attr('id') || ''
  const title = attr('title')?.replace(/&quot;/g, '"') || id
  const priority = attr('priority')
  const taskStatus = attr('status')
  const tagsStr = attr('tags')
  const tags = tagsStr ? tagsStr.split(',').filter(Boolean) : undefined
  const cleanBody = body.replace(/\n\nSet status to .*$/s, '').trim()
  return { kind: 'project-task', id, title, body: cleanBody, priority, taskStatus, tags }
}

function parseStringContent(content: string, items: RenderItem[]): void {
  if (!content.trim()) return

  const hasBashTags = /<bash-(input|stdout|stderr)>/.test(content)
  const channelMatch = content.match(/^<channel\s+([^>]*)>\n?([\s\S]*?)\n?<\/channel>$/)

  if (channelMatch) {
    parseChannelContent(channelMatch, items)
  } else if (hasBashTags) {
    const prev = items[items.length - 1]
    if (prev?.kind === 'bash') {
      prev.text += content
    } else {
      items.push({ kind: 'bash', text: content })
    }
  } else {
    const pt = parseProjectTask(content)
    items.push(pt || { kind: 'text', text: content })
  }
}

function parseChannelContent(channelMatch: RegExpMatchArray, items: RenderItem[]): void {
  const attrs = channelMatch[1]
  const msg = channelMatch[2].trim()
  const getAttr = (name: string) => {
    const m = attrs.match(new RegExp(`${name}="([^"]*)"`))
    return m?.[1]
  }
  const source = getAttr('source') || 'unknown'
  const sender = getAttr('sender')
  const fromProject = getAttr('from_project')
  const intent = getAttr('intent')

  // Inter-conversation messages: broker now sends sender="conversation" + from_conversation
  // (post-naming-covenant rename); accept legacy sender="session" + from_session as a fallback.
  if ((sender === 'conversation' || sender === 'session') && fromProject) {
    const fromConversationId = getAttr('from_conversation') || getAttr('from_session')
    items.push({
      kind: 'channel',
      text: msg,
      source: fromProject,
      conversationId: fromConversationId,
      intent: intent || undefined,
      isInterConversation: true,
    })
  } else if (sender === 'dialog') {
    const status = getAttr('status') || 'submitted'
    const action = getAttr('action')
    items.push({
      kind: 'channel',
      text: msg,
      source: 'dialog',
      isDialog: true,
      dialogStatus: status,
      dialogAction: action || undefined,
    })
  } else if (source === 'rclaude' && sender === 'system') {
    const systemKind = getAttr('spawn_result') || getAttr('event') || getAttr('kind') || undefined
    items.push({ kind: 'channel', text: msg, source: 'system', isSystem: true, systemKind })
  } else if (source === 'rclaude') {
    const pt = parseProjectTask(msg)
    items.push(pt || { kind: 'text', text: msg })
  } else {
    items.push({ kind: 'channel', text: msg, source })
  }
}

function parseArrayContent(content: TranscriptContentBlock[], items: RenderItem[], getResult: ResultLookup): void {
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      const text = typeof block.text === 'string' ? block.text : JSON.stringify(block.text)
      if (text.trim()) {
        const hasBashTags = /<bash-(input|stdout|stderr)>/.test(text)
        items.push(hasBashTags ? { kind: 'bash', text } : { kind: 'text', text })
      }
    } else if (block.type === 'thinking') {
      const raw = block.thinking || block.text
      const text = typeof raw === 'string' ? raw : typeof raw === 'undefined' ? '' : JSON.stringify(raw)
      if (text.trim()) {
        items.push({ kind: 'thinking', text })
      } else if (block.signature) {
        items.push({ kind: 'thinking', text: '', encryptedBytes: block.signature.length, rawBlock: block })
      }
    } else if (block.type === 'tool_use') {
      const id = block.id
      const res = id ? getResult(id) : undefined
      items.push({ kind: 'tool', tool: block, result: res?.result, extra: res?.extra, isError: res?.isError })
    }
  }
}

export function parseGroupEntries(entries: unknown[], getResult: ResultLookup): RenderItem[] {
  const items: RenderItem[] = []

  for (const rawEntry of entries) {
    const entry = rawEntry as RenderableTranscriptEntry & {
      type?: string
      subtype?: string
      timestamp?: string
    }
    // System entries can be inlined into an assistant group by the grouper
    // (process-entry.ts handleSystem). They carry top-level subtype + content
    // fields rather than a message envelope, so we surface them here as a
    // dedicated RenderItem and let GroupItem dispatch to the inline renderer.
    if (entry.type === 'system' && entry.subtype) {
      items.push({
        kind: 'system',
        entry: entry as unknown as Record<string, unknown>,
        subtype: entry.subtype,
        timestamp: entry.timestamp,
      })
      continue
    }
    if (entry.images?.length) {
      items.push({ kind: 'images', images: entry.images })
    }

    const content = entry.message?.content
    if (typeof content === 'string') {
      parseStringContent(content, items)
    } else if (Array.isArray(content)) {
      parseArrayContent(content, items, getResult)
    }
  }

  return items
}
