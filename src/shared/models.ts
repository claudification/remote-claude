/**
 * Single source of truth for the models rclaude surfaces to the user.
 *
 * Consumers:
 * - Spawn/Run dropdown (`MODEL_OPTIONS`) in `src/shared/spawn-schema.ts`.
 * - `/model <id>` autocomplete (`KNOWN_MODEL_IDS`) in
 *   `web/src/components/input-editor/autocomplete-shared.ts`.
 * - Spawn request validation (`modelEnum`) in `src/shared/spawn-schema.ts`.
 * - Early model validation (`validateModel`) in `src/shared/spawn-defaults.ts`.
 *
 * Model data extracted from CC v2.1.116 binary (2026-04-23). When a new CC
 * version ships, re-extract with:
 *   strings $(readlink -f $(which claude)) | grep -oE \
 *     'key:value' patterns (see extraction notes in docs/ops.md)
 * and update the catalog + CC_MODELS below.
 */

export type ContextWindow = 200_000 | 1_000_000

export interface ModelEntry {
  /** Value passed verbatim to CC as `--model <id>` or `/model <id>`. */
  id: string
  /** Human-facing label shown in the spawn/run dropdown. */
  label: string
  /** One-line hint shown as the dropdown subtitle. */
  info: string
  /** Resolved context window in tokens. Matches `resolveContextWindow(id)`. */
  window: ContextWindow
  /** Whether the option appears in the spawn/run model dropdown. */
  showInDropdown: boolean
  /** Whether the id autocompletes for `/model <id>` inside a conversation. */
  showInCompleter: boolean
}

// ─── CC model registry (extracted from binary) ────────────────────
//
// CC normalizes every input slug to a "family ID" (e.g. claude-opus-4-7).
// The family ID determines capabilities and token limits.
//
// Source: CC v2.1.116 function `Ba()` (output token limits) and
// provider-id maps (firstParty/bedrock/vertex/foundry/anthropicAws).

export interface CCModelFamily {
  /** Normalized family ID that CC resolves to internally. */
  familyId: string
  /** Human-facing display name (from CC's switch/case). */
  displayName: string
  /** Default output token limit. */
  defaultOutputTokens: number
  /** Maximum output token limit (upper bound). */
  maxOutputTokens: number
  /** Whether this model supports 1M context (via [1m] suffix or by default). */
  supports1M: boolean
  /** Whether 1M is the default (no suffix needed). Only opus-4-7+ today. */
  default1M: boolean
  /** All input slugs CC accepts that resolve to this family. */
  acceptedSlugs: string[]
}

/**
 * Every model family CC v2.1.116 recognizes, with token limits extracted
 * from the binary. Ordered newest-first within each tier.
 */
export const CC_MODELS: readonly CCModelFamily[] = [
  // ── Current models ──────────────────────────────────────────────
  {
    familyId: 'claude-opus-4-7',
    displayName: 'Opus 4.7',
    defaultOutputTokens: 64_000,
    maxOutputTokens: 128_000,
    supports1M: true,
    default1M: true,
    acceptedSlugs: ['claude-opus-4-7', 'claude-opus-4-7[1m]', 'opus'],
  },
  {
    familyId: 'claude-opus-4-6',
    displayName: 'Opus 4.6',
    defaultOutputTokens: 64_000,
    maxOutputTokens: 128_000,
    supports1M: true,
    default1M: false,
    acceptedSlugs: ['claude-opus-4-6', 'claude-opus-4-6[1m]', 'claude-opus-4-6-20251101', 'claude-opus-4-6-fast'],
  },
  {
    familyId: 'claude-sonnet-4-6',
    displayName: 'Sonnet 4.6',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 128_000,
    supports1M: true,
    default1M: false,
    acceptedSlugs: ['claude-sonnet-4-6', 'claude-sonnet-4-6[1m]', 'sonnet'],
  },
  {
    familyId: 'claude-haiku-4-5',
    displayName: 'Haiku 4.5',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 64_000,
    supports1M: false,
    default1M: false,
    acceptedSlugs: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'haiku'],
  },

  // ── Previous generation (still accepted by CC) ──────────────────
  {
    familyId: 'claude-opus-4-5',
    displayName: 'Opus 4.5',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 64_000,
    supports1M: false,
    default1M: false,
    acceptedSlugs: ['claude-opus-4-5', 'claude-opus-4-5-20251101'],
  },
  {
    familyId: 'claude-sonnet-4-5',
    displayName: 'Sonnet 4.5',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 64_000,
    supports1M: true,
    default1M: false,
    acceptedSlugs: ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-20250929[1m]'],
  },
  {
    familyId: 'claude-sonnet-4-0',
    displayName: 'Sonnet 4',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 64_000,
    supports1M: false,
    default1M: false,
    acceptedSlugs: ['claude-sonnet-4-0', 'claude-sonnet-4-20250514'],
  },
  {
    familyId: 'claude-opus-4-1',
    displayName: 'Opus 4.1',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 32_000,
    supports1M: false,
    default1M: false,
    acceptedSlugs: ['claude-opus-4-1', 'claude-opus-4-1-20250805'],
  },
  {
    familyId: 'claude-opus-4-0',
    displayName: 'Opus 4',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 32_000,
    supports1M: false,
    default1M: false,
    acceptedSlugs: ['claude-opus-4-0', 'claude-opus-4-20250514'],
  },

  // ── Legacy (3.x family) ─────────────────────────────────────────
  {
    familyId: 'claude-3-7-sonnet',
    displayName: 'Sonnet 3.7',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 64_000,
    supports1M: false,
    default1M: false,
    acceptedSlugs: ['claude-3-7-sonnet', 'claude-3-7-sonnet-20250219'],
  },
  {
    familyId: 'claude-3-5-sonnet',
    displayName: 'Sonnet 3.5',
    defaultOutputTokens: 8_192,
    maxOutputTokens: 8_192,
    supports1M: false,
    default1M: false,
    acceptedSlugs: ['claude-3-5-sonnet', 'claude-3-5-sonnet-20241022'],
  },
  {
    familyId: 'claude-3-5-haiku',
    displayName: 'Haiku 3.5',
    defaultOutputTokens: 8_192,
    maxOutputTokens: 8_192,
    supports1M: false,
    default1M: false,
    acceptedSlugs: ['claude-3-5-haiku', 'claude-3-5-haiku-20241022'],
  },
] as const

/** Every slug CC accepts as a flat array -- drives zod schema validation. */
export const ALL_CC_SLUGS: readonly string[] = CC_MODELS.flatMap(m => m.acceptedSlugs)

/** Set of every slug CC accepts -- for fast lookup. */
const ALL_ACCEPTED_SLUGS: ReadonlySet<string> = new Set(ALL_CC_SLUGS)

/** Find the model family for a given slug (case-insensitive, strips [1m]). */
export function resolveModelFamily(slug: string): CCModelFamily | undefined {
  const lower = slug.toLowerCase()
  return CC_MODELS.find(m => m.acceptedSlugs.some(s => s.toLowerCase() === lower))
}

export interface ModelValidationResult {
  valid: boolean
  family?: CCModelFamily
  warning?: string
}

/**
 * Validate a model slug against CC's known model registry.
 *
 * Returns { valid: true, family } for recognized slugs.
 * Returns { valid: false, warning } for unknown slugs with a list of valid models.
 */
export function validateModel(slug: string): ModelValidationResult {
  const lower = slug.toLowerCase()

  if (ALL_ACCEPTED_SLUGS.has(slug) || ALL_ACCEPTED_SLUGS.has(lower)) {
    const family = resolveModelFamily(slug)
    return { valid: true, family: family || undefined }
  }

  // Provider-specific IDs (Bedrock, Vertex, Foundry) -- we don't validate these
  if (/^us\.anthropic\./.test(lower) || /@\d{8}$/.test(lower) || /^anthropic\./.test(lower)) {
    return { valid: true }
  }

  return { valid: false, warning: formatModelError(slug) }
}

function formatModelError(slug: string): string {
  const lines = [`Unknown model "${slug}". Valid models (CC v2.1.116):`, '']
  const current = CC_MODELS.filter(m => !m.familyId.startsWith('claude-3-'))
  const legacy = CC_MODELS.filter(m => m.familyId.startsWith('claude-3-'))

  for (const m of current) {
    const ctx = m.default1M ? '1M default' : m.supports1M ? '200K (1M via [1m])' : '200K'
    const out = `${(m.maxOutputTokens / 1000).toFixed(0)}K output`
    const slugs = m.acceptedSlugs.join(', ')
    lines.push(`  ${m.displayName.padEnd(12)} ${ctx.padEnd(20)} ${out.padEnd(12)} [${slugs}]`)
  }

  if (legacy.length > 0) {
    lines.push('')
    lines.push(`  Legacy: ${legacy.map(m => m.familyId).join(', ')}`)
  }

  lines.push('')
  lines.push('  Aliases: opus, sonnet, haiku')
  return lines.join('\n')
}

// ─── UI-facing exports (unchanged interface) ──────────────────────
//
// MODEL_CATALOG drives the spawn dropdown, /model autocomplete, and
// zod validation. It's a curated subset of CC_MODELS -- not every
// accepted slug needs a dropdown entry.

/**
 * Authoritative model catalog for UI. Ordered the way they appear in the dropdown.
 *
 * The "latest" aliases at the top are pinned to the current 1M-capable build
 * on purpose -- CC's bare `sonnet` alias still resolves to 200K today, and we
 * want picking "Sonnet (latest)" from our UI to unambiguously mean 1M.
 * Bump the pinned id when Anthropic releases a newer one.
 */
export const MODEL_CATALOG: readonly ModelEntry[] = [
  // --- "Latest" aliases: prominent, explicit 1M where supported ---
  {
    id: 'claude-opus-4-7[1m]',
    label: 'Opus (latest, 1M)',
    info: 'Opus 4.7 · 1M · 128K output',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-sonnet-4-6[1m]',
    label: 'Sonnet (latest, 1M)',
    info: 'Sonnet 4.6 · 1M · 128K output',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku (latest)',
    info: 'Haiku 4.5 · 200K · 64K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },

  // --- Explicit pinned versions ---
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    info: 'Pinned · 1M default · 128K output',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-opus-4-6[1m]',
    label: 'Opus 4.6 (1M)',
    info: 'Pinned · 1M · 128K output',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',
    info: 'Pinned · 200K · 128K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    info: 'Pinned · 200K · 128K output',
    window: 200_000,
    showInDropdown: false,
    showInCompleter: true,
  },

  // --- Previous generation ---
  {
    id: 'claude-opus-4-5',
    label: 'Opus 4.5',
    info: '200K · 64K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Sonnet 4.5',
    info: '200K (1M via [1m]) · 64K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-sonnet-4-5-20250929[1m]',
    label: 'Sonnet 4.5 (1M)',
    info: '1M context · 64K output',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-sonnet-4-0',
    label: 'Sonnet 4',
    info: '200K · 64K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-opus-4-1',
    label: 'Opus 4.1',
    info: '200K · 32K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-opus-4-0',
    label: 'Opus 4',
    info: '200K · 32K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },

  // --- Legacy (3.x) ---
  {
    id: 'claude-3-7-sonnet',
    label: 'Sonnet 3.7',
    info: '200K · 64K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-3-5-sonnet',
    label: 'Sonnet 3.5',
    info: '200K · 8K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-3-5-haiku',
    label: 'Haiku 3.5',
    info: '200K · 8K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },

  // --- Bare CC aliases ---
  {
    id: 'opus',
    label: 'opus',
    info: 'CC alias -> Opus 4.7 (1M default)',
    window: 1_000_000,
    showInDropdown: false,
    showInCompleter: true,
  },
  {
    id: 'sonnet',
    label: 'sonnet',
    info: 'CC alias -> Sonnet 4.6 (200K)',
    window: 200_000,
    showInDropdown: false,
    showInCompleter: true,
  },
  {
    id: 'haiku',
    label: 'haiku',
    info: 'CC alias -> Haiku 4.5 (200K)',
    window: 200_000,
    showInDropdown: false,
    showInCompleter: true,
  },
] as const

/** Every id known to rclaude -- drives `modelEnum` validation. */
export const KNOWN_MODEL_IDS: readonly string[] = MODEL_CATALOG.map(m => m.id)

/** Ids surfaced in the `/model` autocomplete list (preserves catalog order). */
export const COMPLETER_MODEL_IDS: readonly string[] = MODEL_CATALOG.filter(m => m.showInCompleter).map(m => m.id)

/** Dropdown rows for Spawn/Run -- consumed by LaunchConfigFields. */
export const DROPDOWN_MODEL_ENTRIES: readonly Pick<ModelEntry, 'id' | 'label' | 'info'>[] = MODEL_CATALOG.filter(
  m => m.showInDropdown,
).map(m => ({ id: m.id, label: m.label, info: m.info }))
