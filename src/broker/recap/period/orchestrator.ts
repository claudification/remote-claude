import { createHash } from 'node:crypto'
import type { RecapAudience, RecapCreateMessage, RecapPeriodLabel, RecapSignal } from '../../../shared/protocol'
import type { StoreDriver } from '../../store/types'
import { chat } from '../shared/openrouter-client'
import {
  gatherCommitsStub,
  gatherConversations,
  gatherCost,
  gatherErrors,
  gatherOpenQuestions,
  gatherTasks,
  gatherToolUse,
  gatherTranscripts,
  type PeriodScope,
} from './gather'
import { pickModel } from './llm/escalate'
import { buildPrompt, type PromptInputs } from './llm/prompt-builder'
import { createProgressEmitter, type ProgressBroadcaster } from './progress'
import { renderFinalMarkdown } from './render/markdown'
import { buildFtsFields, denormalizeTags } from './render/metadata'
import { parseRecapOutput, type RecapMetadata, RecapParseError } from './render/parse-recap'
import { type ResolvedPeriod, resolvePeriod } from './resolve-period'
import type { PeriodRecapStore } from './store'

const DEFAULT_SIGNALS: RecapSignal[] = [
  'user_prompts',
  'assistant_final_turn',
  'commits',
  'task_results',
  'tool_summaries',
  'errors_hooks',
  'cost',
  'open_questions',
]
const CACHE_WINDOW_MS = 5 * 60 * 1000

export interface OrchestratorDeps {
  store: PeriodRecapStore
  brokerStore: StoreDriver
  broadcaster: ProgressBroadcaster
  /** Resolves the project URI -> rolled-up child URIs (worktrees etc). */
  expandProjectScope?: (projectUri: string) => string[]
  /** Override now() for tests. */
  now?: () => number
  /** OpenRouter API key override (otherwise reads OPENROUTER_API_KEY env). */
  apiKey?: string
  /** Project label rendering (e.g. last path segment). */
  projectLabel?: (projectUri: string) => string
  /** Deliver a recap-completed system channel message into a conversation.
   *  Provided by the broker (inform_on_complete). No-op if absent. */
  informConversation?: (conversationId: string, msg: { recapId: string; text: string }) => void
}

export interface StartArgs extends RecapCreateMessage {
  createdBy?: string
  /** Conversation to notify on completion. Resolved broker-side from the
   *  caller's WS connection when inform_on_complete is set. */
  informConversationId?: string
}

export interface StartResult {
  recapId: string
  cached: boolean
}

// fallow-ignore-next-line complexity
export async function startRecap(deps: OrchestratorDeps, args: StartArgs): Promise<StartResult> {
  const period = resolvePeriod(args.period, args.timeZone, deps.now?.())
  const audience: RecapAudience = args.audience ?? 'human'
  const signals = resolveSignals(args, audience)
  // audience is folded into the cache key: a human and an agent recap for
  // the same project+period+signals are different documents.
  const signalsHash = sha256([args.projectUri, period.start, period.end, audience, signals.join(',')].join('|'))

  if (!args.force) {
    const hit = deps.store.findCacheHit({
      projectUri: args.projectUri,
      periodStart: period.start,
      periodEnd: period.end,
      signalsHash,
      freshSinceMs: CACHE_WINDOW_MS,
    })
    if (hit) return { recapId: hit.id, cached: true }
  }

  const recapId = `recap_${nanoid(12)}`
  deps.store.insert({
    id: recapId,
    projectUri: args.projectUri,
    periodLabel: args.period.label,
    periodStart: period.start,
    periodEnd: period.end,
    timeZone: args.timeZone,
    audience,
    informConversationId: args.informConversationId,
    signalsJson: JSON.stringify(signals),
    signalsHash,
    createdAt: Date.now(),
    createdBy: args.createdBy,
  })

  scheduleRun(deps, recapId, args, period, args.timeZone)
  return { recapId, cached: false }
}

function scheduleRun(
  deps: OrchestratorDeps,
  recapId: string,
  args: StartArgs,
  period: ResolvedPeriod,
  timeZone: string,
): void {
  setImmediate(() => {
    runRecap(deps, recapId, args, period, timeZone).catch(err => {
      console.error(`[recap] run failed for ${recapId}:`, err)
      deps.store.update(recapId, { status: 'failed', error: describe(err) })
      deps.broadcaster.broadcast({
        type: 'recap_progress',
        recapId,
        status: 'failed',
        progress: 100,
        phase: 'failed',
        log: { level: 'error', message: describe(err), ts: Date.now() },
      })
      // inform_on_complete: a caller waiting on a push must not be left
      // hanging when the run fails -- tell it the outcome either way.
      if (args.informConversationId && deps.informConversation) {
        deps.informConversation(args.informConversationId, {
          recapId,
          text: `Recap ${recapId} failed: ${describe(err)}`,
        })
      }
    })
  })
}

// fallow-ignore-next-line complexity
async function runRecap(
  deps: OrchestratorDeps,
  recapId: string,
  args: StartArgs,
  period: ResolvedPeriod,
  timeZone: string,
): Promise<void> {
  const emit = createProgressEmitter({ recapId, store: deps.store, broadcaster: deps.broadcaster })
  emit.setStatus('gathering')
  emit.setProgress(2, 'gather/begin')
  deps.store.update(recapId, { startedAt: Date.now() })

  const projectUris = (deps.expandProjectScope ?? defaultExpand)(args.projectUri)
  const scope: PeriodScope = { projectUris, periodStart: period.start, periodEnd: period.end, timeZone }

  const audience: RecapAudience = args.audience ?? 'human'
  const includeInternals = resolveSignals(args, audience).includes('turn_internals')
  const { promptInputs, inputChars } = collectSignals(
    deps,
    scope,
    period,
    args.projectUri,
    deps.projectLabel,
    includeInternals,
  )
  emit.emit(
    'info',
    'gather/done',
    `gathered ${promptInputs.conversations.length} conversations, ${inputChars} chars input (audience=${audience})`,
  )
  emit.setProgress(35, 'gather/done')

  const built = buildPrompt(promptInputs, audience)
  const choice = pickModel(built.inputChars, audience)
  deps.store.update(recapId, { model: choice.model, inputChars: built.inputChars })
  emit.emit('info', 'render/prompt', `model=${choice.model} (${choice.reason}), prompt=${built.inputChars} chars`)

  emit.setStatus('rendering')
  emit.setProgress(45, 'render/llm')
  const llmResult = await callLlm(built, choice.model, deps.apiKey)
  emit.setProgress(85, 'render/llm-done')

  const parsed = await parseOrRetry(llmResult.content, built, choice.model, deps.apiKey)
  const titleTemplate = `${promptInputs.projectLabel} - ${period.human}`
  const finalMarkdown = renderFinalMarkdown({
    title: titleTemplate,
    subtitle: parsed.metadata.subtitle,
    projectLabel: promptInputs.projectLabel,
    projectUri: args.projectUri,
    periodHuman: period.human,
    periodIsoRange: period.isoRange,
    generatedAt: Date.now(),
    model: choice.model,
    recapId,
    audience,
    cost: promptInputs.cost,
    body: parsed.body,
  })

  finalize(deps, recapId, {
    title: titleTemplate,
    subtitle: parsed.metadata.subtitle,
    markdown: finalMarkdown,
    metadata: parsed.metadata,
    body: parsed.body,
    projectUri: args.projectUri,
    inputTokens: llmResult.inputTokens,
    outputTokens: llmResult.outputTokens,
    costUsd: llmResult.costUsd,
  })
  emit.setProgress(100, 'persist')
  emit.setStatus('done')
  emit.emit('info', 'persist', `recap stored as ${recapId}`)
  deps.broadcaster.broadcast({
    type: 'recap_complete',
    recapId,
    title: titleTemplate,
    markdown: finalMarkdown,
    meta: rowToMeta(deps, recapId),
  })

  // inform_on_complete: push a recap-completed channel message into the
  // requesting conversation instead of making it poll recap_get.
  if (args.informConversationId && deps.informConversation) {
    deps.informConversation(args.informConversationId, {
      recapId,
      text: buildInformText({
        recapId,
        audience,
        projectLabel: promptInputs.projectLabel,
        periodHuman: period.human,
        conversationCount: promptInputs.conversations.length,
        body: parsed.body,
      }),
    })
  }
}

function collectSignals(
  deps: OrchestratorDeps,
  scope: PeriodScope,
  period: ResolvedPeriod,
  projectUri: string,
  projectLabelFn: ((uri: string) => string) | undefined,
  includeInternals: boolean,
): { promptInputs: PromptInputs; inputChars: number } {
  const conversations = gatherConversations(deps.brokerStore, scope)
  const transcripts = gatherTranscripts(deps.brokerStore, conversations, scope, includeInternals)
  const cost = gatherCost(deps.brokerStore, scope)
  const tasks = gatherTasks(deps.brokerStore, conversations, scope)
  const tools = gatherToolUse(deps.brokerStore, conversations, scope)
  const errors = gatherErrors(deps.brokerStore, conversations, scope)
  const openQuestions = gatherOpenQuestions(deps.brokerStore, conversations, scope)
  const commits = gatherCommitsStub(scope)
  const promptInputs: PromptInputs = {
    projectLabel: (projectLabelFn ?? defaultLabel)(projectUri),
    periodHuman: period.human,
    periodIsoRange: period.isoRange,
    conversations,
    transcripts,
    cost,
    tasks,
    tools,
    errors,
    openQuestions,
    commits,
  }
  const inputChars = transcripts.reduce(
    (sum, t) => sum + t.turns.reduce((s, tr) => s + tr.userPrompt.length + tr.assistantFinal.length, 0),
    0,
  )
  return { promptInputs, inputChars }
}

interface LlmResult {
  content: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

async function callLlm(prompt: { system: string; user: string }, model: string, apiKey?: string): Promise<LlmResult> {
  const res = await chat({
    model,
    system: prompt.system,
    user: prompt.user,
    maxTokens: 8_000,
    temperature: 0.2,
    retries: 2,
    apiKey,
  })
  return {
    content: res.content,
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    costUsd: res.usage.costUsd,
  }
}

async function parseOrRetry(content: string, built: { system: string; user: string }, model: string, apiKey?: string) {
  try {
    return parseRecapOutput(content)
  } catch (err) {
    if (!(err instanceof RecapParseError)) throw err
    const retry = await chat({
      model,
      apiKey,
      retries: 1,
      maxTokens: 8_000,
      temperature: 0.1,
      messages: [
        { role: 'system', content: built.system },
        { role: 'user', content: built.user },
        {
          role: 'assistant',
          content,
        },
        {
          role: 'user',
          content:
            'Your previous response was malformed (missing or invalid YAML frontmatter). Re-emit ONLY the YAML frontmatter block (between --- lines) followed by the markdown body, in the exact format specified. No prose before the opening --- and no prose after the closing body.',
        },
      ],
    })
    return parseRecapOutput(retry.content)
  }
}

interface FinalizeArgs {
  title: string
  subtitle?: string
  markdown: string
  metadata: RecapMetadata
  body: string
  projectUri: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

function finalize(deps: OrchestratorDeps, recapId: string, args: FinalizeArgs): void {
  deps.store.update(recapId, {
    status: 'done',
    progress: 100,
    completedAt: Date.now(),
    title: args.title,
    subtitle: args.subtitle ?? null,
    markdown: args.markdown,
    metadataJson: JSON.stringify(args.metadata),
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    llmCostUsd: args.costUsd,
  })
  const tags = denormalizeTags(recapId, args.metadata)
  deps.store.setTags(recapId, tags)
  deps.store.upsertFts(recapId, buildFtsFields(args.metadata, args.body, args.projectUri, args.title))
}

function rowToMeta(deps: OrchestratorDeps, recapId: string) {
  const row = deps.store.get(recapId)
  if (!row) throw new Error(`recap ${recapId} missing after finalize`)
  return {
    recapId: row.id,
    projectUri: row.projectUri,
    periodLabel: row.periodLabel as RecapPeriodLabel,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    timeZone: row.timeZone,
    audience: row.audience,
    status: row.status,
    progress: row.progress,
    phase: row.phase ?? undefined,
    model: row.model ?? undefined,
    inputChars: row.inputChars,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    llmCostUsd: row.llmCostUsd,
    title: row.title ?? undefined,
    subtitle: row.subtitle ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  }
}

function defaultExpand(projectUri: string): string[] {
  return [projectUri]
}

function defaultLabel(projectUri: string): string {
  if (projectUri === '*') return 'all projects'
  const match = projectUri.match(/[^/]+$/)
  return match ? match[0] : projectUri
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

function nanoid(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Resolve the effective signal set. Explicit `args.signals` win verbatim.
 * Otherwise default per audience: the agent brief opts `turn_internals` in
 * (it backs the "Dead ends" section); the human recap does not.
 */
function resolveSignals(args: StartArgs, audience: RecapAudience): RecapSignal[] {
  if (args.signals) return args.signals.slice().sort()
  const base = DEFAULT_SIGNALS.slice()
  if (audience === 'agent') base.push('turn_internals')
  return base.sort()
}

/** Build the recap-completed channel message text pushed to the caller. */
function buildInformText(args: {
  recapId: string
  audience: RecapAudience
  projectLabel: string
  periodHuman: string
  conversationCount: number
  body: string
}): string {
  const head = `Recap ${args.recapId} ready -- ${args.projectLabel}, ${args.periodHuman}, ${args.conversationCount} conversation(s).`
  // The agent brief is short by design -- inline it, saving a recap_get
  // round-trip. The human recap is long; send only the pointer.
  if (args.audience === 'agent') return `${head}\n\n${args.body}`
  return `${head} Read it with recap_get({ recapId: "${args.recapId}" }).`
}
