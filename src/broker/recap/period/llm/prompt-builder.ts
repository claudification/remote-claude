import type { RecapAudience } from '../../../../shared/protocol'
import type {
  CommitDigest,
  ConversationDigest,
  CostDigest,
  ErrorDigest,
  OpenQuestionDigest,
  TaskDigest,
  ToolUseDigest,
  TranscriptDigest,
} from '../gather/types'

export interface PromptInputs {
  projectLabel: string
  periodHuman: string
  periodIsoRange: string
  conversations: ConversationDigest[]
  transcripts: TranscriptDigest[]
  cost: CostDigest
  tasks: TaskDigest
  tools: ToolUseDigest
  errors: ErrorDigest
  openQuestions: OpenQuestionDigest
  commits: CommitDigest
}

export interface BuiltPrompt {
  system: string
  user: string
  inputChars: number
}

export function buildPrompt(inputs: PromptInputs, audience: RecapAudience = 'human'): BuiltPrompt {
  const system = audience === 'agent' ? agentSystemPrompt(inputs) : humanSystemPrompt(inputs)
  const user = userPayload(inputs)
  return { system, user, inputChars: system.length + user.length }
}

/**
 * YAML frontmatter contract -- IDENTICAL for both audiences. The frontmatter
 * is the search index (parse-recap.ts, recaps_fts); audience swaps only the
 * markdown body shape, never the frontmatter.
 */
const FRONTMATTER_SPEC = `REQUIRED YAML FRONTMATTER (extract from the input, do not invent):

  subtitle: <single-line theme, 4-12 words>
  keywords: [<5-12 technical terms: feature names, file names, components, libraries, model names, table names>]
  hashtags: [<3-8 broader themes prefixed with #, e.g. "#sqlite-migration", "#ship-week", "#bug-cleanup", "#refactor", "#incident">]
  goals: [<1-5 things being attempted this period>]
  discoveries: [<0-10 notable findings, bugs identified, learnings, architectural insights, surprises>]
  side_effects: [<0-5 unintended consequences, scope creep, broken stuff, technical debt incurred>]
  features: [<each shipped feature as {title, conversations?, commits?}>]
  bugs:     [<each bug fixed as {title, conversations?, commits?}>]
  fixes:    [<refactors/cleanups as {title, conversations?, commits?}>]
  incidents: [<production/dev incidents as {title, conversations?, severity}>]
  open_questions: [<unresolved questions the assistant left for the user; PRIORITISE the OPEN_QUESTIONS section in the input>]
  stakeholders: [<0-5 people involved or mentioned by name>]

OMIT fields where there's nothing to put. NEVER invent items to fill quotas.
For features/bugs/fixes/incidents: cite conversation ids (short form, 8 chars)
and commit hashes (short form, 7 chars) where the input mentions them.`

function humanSystemPrompt(inputs: PromptInputs): string {
  return `You are writing a comprehensive development recap for project ${inputs.projectLabel}
covering ${inputs.periodHuman} (${inputs.periodIsoRange}).

Output format: a YAML frontmatter block (between --- lines) followed by markdown body.
The frontmatter is parsed and indexed -- be specific so future searches find this recap.

${FRONTMATTER_SPEC}

MARKDOWN BODY (after the closing --- of frontmatter):

  ## TL;DR
  3-5 bullets, the most important things from the period

  ## Features shipped
  Bulleted, link conversations via [text](/sessions/conv_xxx...)

  ## Bug fixes
  Bulleted, with commit hashes (short form)

  ## Refactors / cleanup

  ## Incidents / errors
  (omit section if none)

  ## Open questions / unresolved
  CRITICAL SECTION. List every conversation in the input's OPEN_QUESTIONS
  block with the unanswered question(s) the assistant left for the user.
  Group by conversation. Surface anything that was waiting on a user
  decision and never got one. Do not invent open questions; only use
  ones present in the input.

  ## Tasks completed
  Project board items closed in the period

  ## Notable conversations
  Top 3-5 by length/intensity, with links

DO NOT regenerate the cost/token table -- it's inserted programmatically.
DO NOT include greetings, sign-offs, or the H1 title (templated).
Be concrete. Use the project's actual terms verbatim.`
}

/**
 * The agent recap: a terse orientation brief for a fresh Claude Code session
 * with zero context. High signal, low noise -- every line must change what
 * the reader does next. Carries what git cannot: dead ends, in-flight state,
 * decisions + rationale. See .claude/docs/plan-recap-audience.md section 4.
 */
function agentSystemPrompt(inputs: PromptInputs): string {
  return `You are writing an ORIENTATION BRIEF for project ${inputs.projectLabel},
covering ${inputs.periodHuman} (${inputs.periodIsoRange}).

THE READER IS NOT A HUMAN. It is a fresh Claude Code agent session with zero
prior context, about to do real work in this project. It reads this brief
once, then acts. Every line costs the reader context budget and may change
what it does next. Write for that reader and no other.

THE BAR -- apply to every single bullet:
  "Would a fresh agent do something DIFFERENT because of this line?"
  If no -- DELETE the line. A short brief that is all signal beats a
  complete one padded with noise. Target: body under ~400 words.

GROUND RULES:
  - FACT vs INFERENCE. A claim backed by a commit hash or a closed task is
    a FACT -- state it plainly. A claim concluded from transcript text is
    an INFERENCE -- prefix it literally with "[inferred]". NEVER present
    inference as fact. The reader will act on this; a confident wrong claim
    is the worst output you can produce.
  - CITE EVERYTHING. Every claim names its source: commit hash (7 char),
    conversation id (8 char), or task name. A claim with no citation and no
    [inferred] tag does not belong here -- drop it.
  - NO NARRATIVE. Do not tell the story of the period. State what is TRUE
    NOW and what to DO NEXT.
  - The reader already has 'git log'. Do NOT reproduce a commit changelog.
    Mention a commit ONLY when the WHY behind it is not visible in its diff.
  - OMIT empty sections entirely. Never write a section just to say "none".

Output format: a YAML frontmatter block (between --- lines) followed by the
markdown body. The frontmatter is parsed and indexed for search.

${FRONTMATTER_SPEC}

MARKDOWN BODY (after the closing --- of frontmatter):

  ## TL;DR
  One or two lines. The single most important thing a fresh agent must know
  before it touches this project.

  ## State
  What is TRUE RIGHT NOW. Prioritise: work in flight that is NOT yet
  committed (a fresh agent may collide with another agent mid-edit),
  half-finished refactors, which branch is hot, what just shipped that the
  reader should build ON rather than redo. Facts from commits and closed
  tasks stated plainly; transcript-derived state tagged [inferred].

  ## Decisions
  Non-obvious decisions made this period and WHY -- the reasoning a diff
  cannot show. This is what stops the reader relitigating or contradicting
  a settled choice. Cite the conversation where it was decided.

  ## Dead ends -- do NOT retry
  Approaches that were tried and ABANDONED, each with the reason it failed.
  git keeps no record of abandoned work -- this section is the brief's
  highest-value content and exists nowhere else. Omit the section only if
  the input genuinely shows no abandoned approach.

  ## Open questions
  Unresolved questions the assistant left for the user that never got an
  answer. Use the OPEN_QUESTIONS input block VERBATIM -- do not invent.
  Group by conversation.

  ## Gotchas
  Constraints or landmines discovered this period: a tool that misbehaves,
  an environment quirk, a non-obvious dependency, a surprising failure
  mode. Only include something that would actually bite the reader.

  ## Pick up here
  The obvious next actions, most important first. If there is genuinely
  nothing pending, say so in a single line.

DO NOT include greetings, sign-offs, an H1 title, or a cost table.
DO NOT pad. Use the project's actual terms verbatim.`
}

function userPayload(inputs: PromptInputs): string {
  const parts: string[] = []
  parts.push(renderConversationsSection(inputs.conversations))
  parts.push(renderTranscriptsSection(inputs.transcripts))
  parts.push(renderTasksSection(inputs.tasks))
  parts.push(renderToolsSection(inputs.tools))
  parts.push(renderErrorsSection(inputs.errors))
  parts.push(renderOpenQuestionsSection(inputs.openQuestions))
  parts.push(renderCommitsSection(inputs.commits))
  parts.push(renderCostSummary(inputs.cost))
  parts.push('\nWrite the recap now.')
  return parts.filter(Boolean).join('\n\n')
}

function renderConversationsSection(convs: ConversationDigest[]): string {
  if (convs.length === 0) return 'CONVERSATIONS: (none in period)'
  const lines = convs.map(c => `- ${shortId(c.id)} "${c.title}" (${c.turnCount} turns, ${c.status})`)
  return `CONVERSATIONS (${convs.length}):\n${lines.join('\n')}`
}

function renderTranscriptsSection(digests: TranscriptDigest[]): string {
  if (digests.length === 0) return 'TRANSCRIPTS: (none)'
  const blocks = digests.map(d => {
    const turns = d.turns.map((t, i) => renderTurn(t, i)).join('\n')
    return `### ${shortId(d.conversationId)} "${d.conversationTitle}"\n${turns || '  (no turns)'}`
  })
  return `TRANSCRIPTS:\n\n${blocks.join('\n\n')}`
}

function renderTurn(t: TranscriptDigest['turns'][number], i: number): string {
  const lines = [`  T${i + 1} USER: ${t.userPrompt}`, `  T${i + 1} ASSISTANT: ${t.assistantFinal}`]
  if (t.internals) {
    const indented = t.internals
      .split('\n')
      .map(l => `    ${l}`)
      .join('\n')
    lines.push(`  T${i + 1} INTERNALS (tool calls + errors):\n${indented}`)
  }
  return lines.join('\n')
}

function renderTasksSection(tasks: TaskDigest): string {
  const parts: string[] = ['TASKS:']
  if (tasks.doneInPeriod.length) {
    parts.push(`  done (${tasks.doneInPeriod.length}):`)
    for (const t of tasks.doneInPeriod) parts.push(`    - [${shortId(t.conversationId)}] ${t.name}`)
  }
  if (tasks.createdInPeriod.length) {
    parts.push(`  created (${tasks.createdInPeriod.length}):`)
    for (const t of tasks.createdInPeriod) parts.push(`    - [${shortId(t.conversationId)}] ${t.name} (${t.status})`)
  }
  if (tasks.inProgress.length) {
    parts.push(`  in progress (${tasks.inProgress.length}):`)
    for (const t of tasks.inProgress) parts.push(`    - [${shortId(t.conversationId)}] ${t.name}`)
  }
  if (parts.length === 1) parts.push('  (none)')
  return parts.join('\n')
}

function renderToolsSection(tools: ToolUseDigest): string {
  if (tools.perConversation.length === 0) return 'TOOL USE: (none)'
  const lines = tools.perConversation.slice(0, 10).map(p => {
    const top = p.perTool
      .slice(0, 5)
      .map(t => `${t.tool}=${t.count}`)
      .join(', ')
    return `  ${shortId(p.conversationId)}: total=${p.total} (${top})`
  })
  return `TOOL USE (top 10 conversations):\n${lines.join('\n')}`
}

function renderErrorsSection(errors: ErrorDigest): string {
  if (errors.incidents.length === 0) return 'INCIDENTS: (none)'
  const lines = errors.incidents.map(e => `  - ${shortId(e.conversationId)} [${e.subtype}] ${e.summary}`)
  return `INCIDENTS:\n${lines.join('\n')}`
}

function renderOpenQuestionsSection(open: OpenQuestionDigest): string {
  if (open.conversationsWithOpenQuestions.length === 0) return 'OPEN_QUESTIONS: (none)'
  const blocks = open.conversationsWithOpenQuestions.map(o => {
    const qs = o.openQuestions.map(q => `    Q: ${q}`).join('\n')
    return `  ${shortId(o.conversationId)} "${o.conversationTitle}"\n    LAST USER: ${o.lastUserPrompt}\n${qs}`
  })
  return `OPEN_QUESTIONS (conversations ending on questions the user never answered):\n${blocks.join('\n\n')}`
}

function renderCommitsSection(commits: CommitDigest): string {
  const totalCommits = commits.perProject.reduce((sum, p) => sum + p.commits.length, 0)
  if (totalCommits === 0) return 'COMMITS: (no git data available for this recap)'
  const blocks = commits.perProject.map(p => {
    const lines = p.commits.map(c => `  ${c.sha.slice(0, 7)} ${c.subject}`).join('\n')
    return `  ${p.cwd}:\n${lines}`
  })
  return `COMMITS (${totalCommits}):\n${blocks.join('\n\n')}`
}

function renderCostSummary(cost: CostDigest): string {
  return `COST SUMMARY (rendered programmatically into the final document; for context only): total=$${cost.totalCostUsd.toFixed(4)} turns=${cost.totalTurns} input=${cost.totalInputTokens} output=${cost.totalOutputTokens}`
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id
}
