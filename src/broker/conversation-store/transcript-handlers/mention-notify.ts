import { extractProjectLabel } from '../../../shared/project-uri'
import type { Conversation, TranscriptAssistantEntry } from '../../../shared/protocol'
import { getUser } from '../../auth'
import { getProjectSettings } from '../../project-settings'
import { sendPushToUser } from '../../push'
import type { ConversationStoreContext } from '../event-context'

/**
 * Mention pattern -- matches `@username` where username is a sane handle.
 * Negative lookbehind on `[\w.@]` skips email-like fragments (`foo@bar.com`)
 * and double-@ artifacts so we only fire on standalone mentions.
 */
const MENTION_RE = /(?<![\w.@])@([a-zA-Z][a-zA-Z0-9_-]{0,30})\b/g

/** Cap on the dedup set. Older entries get dropped (Set FIFO insertion order). */
const MENTION_DEDUP_CAP = 5000

/**
 * Scan an assistant entry's text content for `@username` mentions and
 * fire a single push notification per (entry, user) pair to the matched
 * user, subject to their `notifications` permission for the project.
 *
 * Skipped entirely on initial replay (`isInitial=true`) so reconnecting
 * clients don't re-trigger historical mentions. Per-mention dedup uses
 * `${conversationId}:${uuid}:${userName}` so the same entry re-arriving
 * via a different path (live stream + JSONL re-read) only notifies once.
 *
 * Backend-agnostic: works for any agent whose assistant text flows through
 * the transcript pipeline (PTY, headless, chat-api, hermes, ...).
 */
export function handleMentionNotifications(
  ctx: ConversationStoreContext,
  conv: Conversation,
  entry: TranscriptAssistantEntry,
  isInitial: boolean,
): void {
  if (isInitial) return
  if (entry.message?.model === '<synthetic>') return
  const blocks = entry.message?.content
  if (!Array.isArray(blocks)) return

  const text = blocks
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
  if (!text) return

  const seen = new Set<string>() // dedup within this entry: only one notification per user per entry
  for (const match of text.matchAll(MENTION_RE)) {
    const handle = match[1]
    if (!handle) continue
    const matchIndex = match.index ?? 0
    const user = getUser(handle)
    if (!user || user.revoked) continue
    if (seen.has(user.name)) continue
    seen.add(user.name)

    const dedupKey = `${conv.id}:${entry.uuid || 'no-uuid'}:${user.name}`
    if (ctx.notifiedMentions.has(dedupKey)) continue
    rememberMention(ctx, dedupKey)

    const body = extractMentionBody(text, matchIndex, handle)
    const projectLabel = getProjectSettings(conv.project)?.label || extractProjectLabel(conv.project)
    const sessionLabel = conv.title || projectLabel || conv.id.slice(0, 8)
    const title = `Notification from ${sessionLabel}`

    sendPushToUser(user.name, {
      title,
      body,
      conversationId: conv.id,
      project: conv.project,
      tag: `mention-${conv.id}-${user.name}`,
    }).catch(err => {
      console.error('[mention-notify] push failed:', err instanceof Error ? err.message : err)
    })
  }
}

function rememberMention(ctx: ConversationStoreContext, key: string): void {
  ctx.notifiedMentions.add(key)
  if (ctx.notifiedMentions.size > MENTION_DEDUP_CAP) {
    // Set iteration is insertion order, so the first key is the oldest.
    const oldest = ctx.notifiedMentions.values().next().value
    if (oldest !== undefined) ctx.notifiedMentions.delete(oldest)
  }
}

/**
 * Pull the line containing the mention, strip the `@username` token, and
 * trim. Falls back to the whole text when the line is empty after stripping
 * (e.g. mention on its own line).
 */
function extractMentionBody(text: string, mentionIndex: number, handle: string): string {
  const lineStart = text.lastIndexOf('\n', mentionIndex - 1) + 1
  let lineEnd = text.indexOf('\n', mentionIndex)
  if (lineEnd === -1) lineEnd = text.length
  const line = text.slice(lineStart, lineEnd)
  const stripped = line
    .replace(new RegExp(`@${handle}\\b`), '')
    .replace(/^[\s>:,-]+/, '')
    .trim()
  if (stripped) return stripped.length > 200 ? `${stripped.slice(0, 197)}...` : stripped
  const fallback = text.replace(new RegExp(`@${handle}\\b`), '').trim()
  return fallback.length > 200 ? `${fallback.slice(0, 197)}...` : fallback || 'Mentioned you'
}
