import type { ClaudeEfficiencyUpdate, ClaudeHealthUpdate } from '../shared/protocol'

const HEALTH_POLL_MS = 60_000
const EFFICIENCY_POLL_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 10_000

let healthTimer: ReturnType<typeof setInterval> | null = null
let efficiencyTimer: ReturnType<typeof setInterval> | null = null

interface PollCallbacks {
  onHealth: (health: ClaudeHealthUpdate) => void
  onEfficiency: (efficiency: ClaudeEfficiencyUpdate) => void
}

export function startExternalStatusPolling(callbacks: PollCallbacks): void {
  pollClaudeHealth(callbacks.onHealth)
  healthTimer = setInterval(() => pollClaudeHealth(callbacks.onHealth), HEALTH_POLL_MS)

  pollClaudeEfficiency(callbacks.onEfficiency)
  efficiencyTimer = setInterval(() => pollClaudeEfficiency(callbacks.onEfficiency), EFFICIENCY_POLL_MS)
}

export function stopExternalStatusPolling(): void {
  if (healthTimer) {
    clearInterval(healthTimer)
    healthTimer = null
  }
  if (efficiencyTimer) {
    clearInterval(efficiencyTimer)
    efficiencyTimer = null
  }
}

async function pollClaudeHealth(onHealth: PollCallbacks['onHealth']): Promise<void> {
  try {
    const [dashRes, patternsRes] = await Promise.all([
      fetch('https://clanker.watch/api/dashboard', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      fetch('https://clanker.watch/api/patterns', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
    ])
    if (!dashRes.ok || !patternsRes.ok) return

    const dashboard = (await dashRes.json()) as {
      services: Array<{
        id: string
        is_up: boolean
        status: string
        uptime_24h: number
        last_incident_title: string | null
      }>
    }
    const patterns = (await patternsRes.json()) as {
      predictions: Record<
        string,
        {
          risk: number | null
          trend: string
          incidents_7d: number
          hourly_risk: Array<{ start_utc: number; risk: number }>
        }
      >
    }

    const claude = dashboard.services.find(s => s.id === 'claude')
    if (!claude) return

    const prediction = patterns.predictions.claude
    const nowUtcHour = new Date().getUTCHours()
    const currentBlock = prediction?.hourly_risk?.find(b => {
      const nextBlock = b.start_utc + 3
      return nowUtcHour >= b.start_utc && nowUtcHour < nextBlock
    })

    const health: ClaudeHealthUpdate = {
      type: 'claude_health_update',
      isUp: claude.is_up,
      status: normalizeStatus(claude.status),
      uptime24h: claude.uptime_24h,
      riskScore: currentBlock ? Math.round(currentBlock.risk * 100) : 0,
      riskTrend: normalizeRiskTrend(prediction?.trend),
      incidents7d: prediction?.incidents_7d ?? 0,
      lastIncidentTitle: claude.last_incident_title,
      polledAt: Date.now(),
    }

    onHealth(health)
  } catch {
    // Silent failure -- keep stale data
  }
}

async function pollClaudeEfficiency(onEfficiency: PollCallbacks['onEfficiency']): Promise<void> {
  try {
    const [burnRes, forecastRes] = await Promise.all([
      fetch('https://usage.report/api/burn-rate', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      fetch('https://usage.report/api/forecast', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
    ])
    if (!burnRes.ok || !forecastRes.ok) return

    const burn = (await burnRes.json()) as {
      current: {
        pp: number
        baseline_pp: number
        efficiency: number
        level: string
      }
    }
    const forecast = (await forecastRes.json()) as {
      hourly: Array<{
        hour_utc: number
        efficiency: number
        level: string
      }>
    }

    const efficiency: ClaudeEfficiencyUpdate = {
      type: 'claude_efficiency_update',
      efficiency: burn.current.efficiency,
      level: normalizeLevel(burn.current.level),
      currentDrainPp: burn.current.pp,
      baselineDrainPp: burn.current.baseline_pp,
      forecast: (forecast.hourly ?? []).map(h => ({
        hourUtc: h.hour_utc,
        efficiency: h.efficiency,
        level: h.level,
      })),
      polledAt: Date.now(),
    }

    onEfficiency(efficiency)
  } catch {
    // Silent failure -- keep stale data
  }
}

function normalizeStatus(
  raw: string,
): 'operational' | 'investigating' | 'identified' | 'monitoring' | 'resolved' | 'unknown' {
  const valid = ['operational', 'investigating', 'identified', 'monitoring', 'resolved'] as const
  return (valid as readonly string[]).includes(raw) ? (raw as (typeof valid)[number]) : 'unknown'
}

function normalizeRiskTrend(raw: string | undefined): 'worsening' | 'improving' | 'stable' {
  if (raw === 'worsening') return 'worsening'
  if (raw === 'improving') return 'improving'
  return 'stable'
}

function normalizeLevel(raw: string): ClaudeEfficiencyUpdate['level'] {
  const valid = ['great', 'good', 'fair', 'tight', 'harsh', 'brutal'] as const
  return (valid as readonly string[]).includes(raw) ? (raw as (typeof valid)[number]) : 'fair'
}
