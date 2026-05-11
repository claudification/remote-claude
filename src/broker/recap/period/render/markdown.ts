import type { CostDigest } from '../gather/types'

export interface FinalDocumentInputs {
  title: string
  subtitle?: string
  projectLabel: string
  projectUri: string
  periodHuman: string
  periodIsoRange: string
  generatedAt: number
  model: string
  recapId: string
  cost: CostDigest
  body: string
}

export function renderFinalMarkdown(inputs: FinalDocumentInputs): string {
  const header = renderHeader(inputs)
  const subtitleLine = inputs.subtitle ? `_${inputs.subtitle}_\n\n` : ''
  const costTable = renderCostTable(inputs.cost)
  return [header, `# ${inputs.title}`, '', subtitleLine, costTable, '', inputs.body].join('\n').trimEnd() + '\n'
}

function renderHeader(inputs: FinalDocumentInputs): string {
  return [
    '---',
    `project: ${inputs.projectLabel} (${inputs.projectUri})`,
    `period: ${inputs.periodHuman} (${inputs.periodIsoRange})`,
    `generated: ${new Date(inputs.generatedAt).toISOString()}`,
    `model: ${inputs.model}`,
    `recap-id: ${inputs.recapId}`,
    '---',
    '',
  ].join('\n')
}

// fallow-ignore-next-line complexity
function renderCostTable(cost: CostDigest): string {
  if (cost.totalTurns === 0) return ''
  const lines: string[] = ['## Cost & Tokens', '']
  lines.push('| Day        | Cost   | Input    | Output  | Cache Rd | Turns |')
  lines.push('|------------|--------|----------|---------|----------|-------|')
  for (const d of cost.perDay) {
    lines.push(
      `| ${d.day} | $${d.costUsd.toFixed(2)} | ${formatTokens(d.inputTokens)} | ${formatTokens(d.outputTokens)} | ${formatTokens(d.cacheReadTokens)} | ${d.turns} |`,
    )
  }
  lines.push(
    `| **Total** | **$${cost.totalCostUsd.toFixed(2)}** | **${formatTokens(cost.totalInputTokens)}** | **${formatTokens(cost.totalOutputTokens)}** | **${formatTokens(cost.totalCacheReadTokens)}** | **${cost.totalTurns}** |`,
  )
  if (cost.perModel.length > 0) {
    lines.push('', '**By model:**', '', '| Model | Cost | Tokens | Turns |', '|-------|------|--------|-------|')
    for (const m of cost.perModel) {
      lines.push(
        `| ${m.model} | $${m.costUsd.toFixed(2)} | ${formatTokens(m.inputTokens + m.outputTokens)} | ${m.turns} |`,
      )
    }
  }
  return lines.join('\n')
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
