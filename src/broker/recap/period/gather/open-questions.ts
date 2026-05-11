import type { StoreDriver } from '../../../store/types'
import { extractUserPromptsAndFinals } from '../../shared/transcript-extract'
import type { ConversationDigest, OpenQuestionDigest, PeriodScope } from './types'

/**
 * Detect conversations whose final assistant turn ends on one or more
 * questions back to the user that the user never answered. Heuristic:
 *  - The final turn (in the period window) has an assistant text whose
 *    last sentence ends with '?'.
 *  - There is no later user prompt in the same window.
 *
 * Surfaces these as "open question" incidents in the period recap so the
 * user sees what was left unresolved (per Jonas request).
 */
export function gatherOpenQuestions(
  store: StoreDriver,
  conversations: ConversationDigest[],
  scope: PeriodScope,
): OpenQuestionDigest {
  const conversationsWithOpenQuestions: OpenQuestionDigest['conversationsWithOpenQuestions'] = []
  for (const conv of conversations) {
    const open = detectOpenQuestion(store, conv, scope)
    if (open) conversationsWithOpenQuestions.push(open)
  }
  return { conversationsWithOpenQuestions }
}

function detectOpenQuestion(
  store: StoreDriver,
  conv: ConversationDigest,
  scope: PeriodScope,
): OpenQuestionDigest['conversationsWithOpenQuestions'][number] | null {
  const entries = store.transcripts.find(conv.id, {
    after: scope.periodStart,
    before: scope.periodEnd,
    limit: 1_000,
  })
  const turns = extractUserPromptsAndFinals(
    entries.map(
      rec =>
        ({
          type: rec.type,
          uuid: rec.uuid,
          timestamp: rec.timestamp,
          ...rec.content,
        }) as never,
    ),
  )
  if (turns.length === 0) return null
  const last = turns[turns.length - 1]
  const questions = extractTrailingQuestions(last.assistantFinal)
  if (questions.length === 0) return null
  return {
    conversationId: conv.id,
    conversationTitle: conv.title,
    lastUserPrompt: last.userPrompt,
    finalAssistantText: last.assistantFinal,
    openQuestions: questions,
    timestamp: last.timestamp,
  }
}

/** Pull any sentence in the trailing third of the assistant text that ends with `?`. */
function extractTrailingQuestions(text: string): string[] {
  if (!text) return []
  const sentences = splitSentences(text)
  if (sentences.length === 0) return []
  const tail = sentences.slice(Math.max(0, Math.floor(sentences.length * 0.66)))
  return tail
    .map(s => s.trim())
    .filter(s => s.endsWith('?'))
    .slice(0, 5)
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.?!])\s+/).filter(Boolean)
}
