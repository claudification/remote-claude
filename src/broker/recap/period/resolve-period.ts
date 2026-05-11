import type { RecapPeriodLabel } from '../../../shared/protocol'

export interface ResolvedPeriod {
  label: RecapPeriodLabel
  start: number
  end: number
  human: string
  isoRange: string
}

export interface PeriodSpec {
  label: RecapPeriodLabel
  start?: number
  end?: number
}

// fallow-ignore-next-line complexity
export function resolvePeriod(spec: PeriodSpec, timeZone: string, now = Date.now()): ResolvedPeriod {
  if (spec.label === 'custom') return resolveCustom(spec, timeZone)
  const dayBoundary = atStartOfDay(now, timeZone)
  switch (spec.label) {
    case 'today':
      return finalize(spec.label, dayBoundary, dayBoundary + DAY_MS, timeZone)
    case 'yesterday':
      return finalize(spec.label, dayBoundary - DAY_MS, dayBoundary, timeZone)
    case 'last_7':
      return finalize(spec.label, dayBoundary - 7 * DAY_MS, dayBoundary + DAY_MS, timeZone)
    case 'last_30':
      return finalize(spec.label, dayBoundary - 30 * DAY_MS, dayBoundary + DAY_MS, timeZone)
    case 'this_week': {
      const weekStart = startOfWeek(dayBoundary, timeZone)
      return finalize(spec.label, weekStart, weekStart + 7 * DAY_MS, timeZone)
    }
    case 'this_month': {
      const monthStart = startOfMonth(now, timeZone)
      return finalize(spec.label, monthStart, dayBoundary + DAY_MS, timeZone)
    }
    default:
      throw new Error(`unknown period label: ${spec.label}`)
  }
}

const DAY_MS = 86_400_000

function resolveCustom(spec: PeriodSpec, timeZone: string): ResolvedPeriod {
  if (spec.start == null || spec.end == null) {
    throw new Error('custom period requires start + end')
  }
  return finalize('custom', spec.start, spec.end, timeZone)
}

function finalize(label: RecapPeriodLabel, start: number, end: number, timeZone: string): ResolvedPeriod {
  return {
    label,
    start,
    end,
    human: humanize(label),
    isoRange: `${isoDay(start, timeZone)} - ${isoDay(end - 1, timeZone)}`,
  }
}

function humanize(label: RecapPeriodLabel): string {
  switch (label) {
    case 'today':
      return 'Today'
    case 'yesterday':
      return 'Yesterday'
    case 'last_7':
      return 'Last 7 days'
    case 'last_30':
      return 'Last 30 days'
    case 'this_week':
      return 'This week'
    case 'this_month':
      return 'This month'
    case 'custom':
      return 'Custom range'
  }
}

function isoDay(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts))
}

function atStartOfDay(ts: number, timeZone: string): number {
  const day = isoDay(ts, timeZone)
  // Use the literal ISO day + 'T00:00:00' interpreted in the target tz via Intl-derived offset.
  // SQLite turns are stored in UTC ms, so we need ms-of-midnight-in-tz.
  return parseTzMidnight(day, timeZone)
}

function parseTzMidnight(isoDate: string, timeZone: string): number {
  const naive = new Date(`${isoDate}T00:00:00Z`).getTime()
  const offsetName = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  })
    .formatToParts(new Date(`${isoDate}T12:00:00Z`))
    .find(p => p.type === 'timeZoneName')?.value
  const match = offsetName?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/)
  if (!match) return naive
  const sign = match[1] === '-' ? -1 : 1
  const hours = Number(match[2])
  const minutes = Number(match[3] ?? '0')
  return naive - sign * (hours * 3600_000 + minutes * 60_000)
}

function startOfWeek(dayMs: number, _timeZone: string): number {
  const day = new Date(dayMs).getUTCDay()
  const offset = day === 0 ? 6 : day - 1
  return dayMs - offset * DAY_MS
}

function startOfMonth(now: number, timeZone: string): number {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(now))
  const [year, month] = iso.split('-')
  return parseTzMidnight(`${year}-${month}-01`, timeZone)
}
