import type { Conversation, TranscriptEntry, TranscriptUserEntry } from '../../../shared/protocol'

/**
 * Detect bg task completions surfaced as `<task-notification>` blocks in
 * user transcript entries. Runs once per batch (not per entry) because
 * the regex is the bottleneck.
 *
 * Returns true when at least one bgTask state was updated.
 */
export function detectBgTaskNotifications(session: Conversation, entries: TranscriptEntry[]): boolean {
  if (!session.bgTasks.some(t => t.status === 'running')) return false

  let changed = false
  for (const entry of entries) {
    if (entry.type !== 'user') continue
    const text = extractUserText(entry as TranscriptUserEntry)
    if (!text.includes('<task-notification>')) continue

    const re = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g
    let match: RegExpExecArray | null = re.exec(text)
    while (match !== null) {
      const taskId = match[1]
      const status = match[2]
      const bgTask = session.bgTasks.find(t => t.taskId === taskId && t.status === 'running')
      if (bgTask) {
        bgTask.status = status === 'completed' ? 'completed' : 'killed'
        bgTask.completedAt = Date.now()
        changed = true
      }
      match = re.exec(text)
    }
  }
  return changed
}

function extractUserText(entry: TranscriptUserEntry): string {
  const content = entry.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(c => c.type === 'text')
    .map(c => (c as { text?: string }).text ?? '')
    .join('')
}
