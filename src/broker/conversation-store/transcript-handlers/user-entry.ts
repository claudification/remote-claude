import type { Conversation, TranscriptUserEntry } from '../../../shared/protocol'
import { appendSharedFile } from '../../routes'
import type { ConversationStoreContext } from '../event-context'
import { detectClipboardMime, isReadableText } from '../parsers'
import { applyContextMode } from './system-entry'

/**
 * Per-user-entry processing:
 *   - Count it as a real user turn (skip tool-result-only messages)
 *   - Detect context mode from `<local-command-stdout>` content
 *   - Detect OSC 52 clipboard sequences in tool_result blocks (live only)
 *   - Count lines added/removed from Edit/MultiEdit structuredPatch (live only)
 *
 * Returns true when session metadata mutated (lines counts, context mode).
 * Turn counts are stats-only and don't drive a session update on their own.
 */
export function handleUserEntry(
  ctx: ConversationStoreContext,
  conversationId: string,
  session: Conversation,
  entry: TranscriptUserEntry,
  isInitial: boolean,
): boolean {
  let changed = false

  countUserTurn(session, entry)

  // Context mode lives in user entries when CC wraps stdout in the message body
  const stringContent = typeof entry.message?.content === 'string' ? entry.message.content : undefined
  if (stringContent?.includes('local-command-stdout')) {
    if (applyContextMode(conversationId, session, stringContent)) changed = true
  }

  if (!isInitial) {
    if (detectClipboardCaptures(ctx, conversationId, session, entry)) {
      // clipboard captures don't drive a session update directly
    }
    if (countStructuredPatchLines(session, entry)) changed = true
  }

  return changed
}

function countUserTurn(session: Conversation, entry: TranscriptUserEntry): void {
  const content = entry.message?.content
  if (typeof content !== 'string' && !Array.isArray(content)) return
  // Pure tool-result messages aren't real user turns
  if (Array.isArray(content)) {
    if (!content.some(c => c.type === 'text')) return
    if (content.some(c => c.type === 'tool_result')) return
  }
  session.stats.turnCount++
}

function detectClipboardCaptures(
  ctx: ConversationStoreContext,
  conversationId: string,
  session: Conversation,
  entry: TranscriptUserEntry,
): boolean {
  const content = entry.message?.content
  if (!Array.isArray(content)) return false

  let captured = false
  for (const block of content) {
    if (block.type !== 'tool_result' || typeof block.content !== 'string') continue
    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
    if (toolUseId && ctx.processedClipboardIds.has(toolUseId)) continue

    // Match OSC 52: direct (\x1b]52;c;BASE64\x07) or tmux-wrapped (Ptmux;\x1b]52;c;BASE64)
    const osc52Match =
      block.content.match(/(?:\x1bPtmux;\x1b)?(?:\x1b)?\]52;[a-z]*;([A-Za-z0-9+/=]+)/) ||
      block.content.match(/Ptmux;[^\]]*\]52;[a-z]*;([A-Za-z0-9+/=]+)/)
    if (!osc52Match?.[1] || osc52Match[1].length <= 8) continue

    const base64 = osc52Match[1]
    const mime = detectClipboardMime(base64)
    const decodedText = mime ? undefined : Buffer.from(base64, 'base64').toString('utf-8')
    // Skip garbled/binary content that isn't readable text
    if (!mime && (!decodedText || !isReadableText(decodedText))) {
      if (toolUseId) ctx.processedClipboardIds.add(toolUseId)
      continue
    }

    const capture = {
      type: 'clipboard_capture' as const,
      conversationId,
      contentType: mime ? ('image' as const) : ('text' as const),
      ...(mime ? { base64, mimeType: mime } : { text: decodedText }),
      timestamp: Date.now(),
    }
    ctx.broadcastConversationScoped(capture, session.project)
    if (toolUseId) ctx.processedClipboardIds.add(toolUseId)
    // Persist to shared files log (per-project, survives restarts)
    const clipHash = `clip_${Date.now().toString(36)}_${base64.slice(0, 8)}`
    appendSharedFile({
      type: 'clipboard',
      hash: clipHash,
      filename: mime ? `clipboard.${mime.split('/')[1]}` : 'clipboard.txt',
      mediaType: mime || 'text/plain',
      project: session.project,
      conversationId,
      size: base64.length,
      url: '',
      text: decodedText,
      createdAt: Date.now(),
    })
    console.log(`[clipboard] ${capture.contentType} from transcript (session ${conversationId.slice(0, 8)})`)
    captured = true
  }
  return captured
}

function countStructuredPatchLines(session: Conversation, entry: TranscriptUserEntry): boolean {
  const content = entry.message?.content
  if (!Array.isArray(content)) return false

  let changed = false
  for (const block of content) {
    if (block.type !== 'tool_result') continue
    const tur = (block as unknown as { toolUseResult?: { structuredPatch?: Array<{ lines?: string[] }> } })
      .toolUseResult
    const patches = tur?.structuredPatch
    if (!Array.isArray(patches)) continue
    for (const hunk of patches) {
      if (!Array.isArray(hunk.lines)) continue
      for (const line of hunk.lines) {
        if (line.startsWith('+')) session.stats.linesAdded++
        else if (line.startsWith('-')) session.stats.linesRemoved++
      }
    }
    changed = true
  }
  return changed
}
