/**
 * Single source of truth for the models rclaude surfaces to the user.
 *
 * Consumers:
 * - Spawn/Run dropdown (`MODEL_OPTIONS`) in `src/shared/spawn-schema.ts`.
 * - `/model <id>` autocomplete (`KNOWN_MODEL_IDS`) in
 *   `web/src/components/markdown-input.tsx`.
 * - Spawn request validation (`modelEnum`) in `src/shared/spawn-schema.ts`.
 *
 * Context-window semantics come from `src/shared/context-window.ts`:
 *   - `claude-opus-4-7*` defaults to 1M.
 *   - Every other 4.x model defaults to 200K and opts in via `[1m]` / `-1m`.
 *
 * When Anthropic ships a new pinned model or 1M variant, update this file and
 * both consumers pick it up automatically.
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
  /** Whether the id autocompletes for `/model <id>` inside a session. */
  showInCompleter: boolean
}

/**
 * Authoritative model catalog. Ordered the way they appear in the dropdown.
 *
 * The "latest" aliases at the top are pinned to the current 1M-capable build
 * on purpose — CC's bare `sonnet` alias still resolves to 200K today, and we
 * want picking "Sonnet (latest)" from our UI to unambiguously mean 1M.
 * Bump the pinned id when Anthropic releases a newer one.
 */
export const MODEL_CATALOG: readonly ModelEntry[] = [
  // --- "Latest" aliases: prominent, explicit 1M where supported ---
  {
    id: 'claude-opus-4-7[1m]',
    label: 'Opus (latest, 1M)',
    info: 'Opus 4.7 · 1M context',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-sonnet-4-6[1m]',
    label: 'Sonnet (latest, 1M)',
    info: 'Sonnet 4.6 · 1M context',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku (latest)',
    info: 'Haiku 4.5 · 200K context',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },

  // --- Explicit pinned versions ---
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    info: 'Pinned · 1M context (default)',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-opus-4-6[1m]',
    label: 'Opus 4.6 (1M)',
    info: 'Pinned · 1M context variant',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',
    info: 'Pinned · 200K context',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    info: 'Pinned · 200K context',
    window: 200_000,
    showInDropdown: false,
    showInCompleter: true,
  },

  // --- Bare CC aliases: kept so `/model opus` etc. still completes. ---
  // Not in the dropdown (the "(latest, 1M)" entries above supersede them).
  // Windows below reflect CC's current resolution, not a guarantee.
  {
    id: 'opus',
    label: 'opus',
    info: 'CC alias · resolves server-side',
    window: 1_000_000,
    showInDropdown: false,
    showInCompleter: true,
  },
  {
    id: 'sonnet',
    label: 'sonnet',
    info: 'CC alias · resolves server-side (200K)',
    window: 200_000,
    showInDropdown: false,
    showInCompleter: true,
  },
  {
    id: 'haiku',
    label: 'haiku',
    info: 'CC alias · resolves server-side',
    window: 200_000,
    showInDropdown: false,
    showInCompleter: true,
  },
] as const

/** Every id known to rclaude — drives `modelEnum` validation. */
export const KNOWN_MODEL_IDS: readonly string[] = MODEL_CATALOG.map(m => m.id)

/** Ids surfaced in the `/model` autocomplete list (preserves catalog order). */
export const COMPLETER_MODEL_IDS: readonly string[] = MODEL_CATALOG.filter(m => m.showInCompleter).map(m => m.id)

/** Dropdown rows for Spawn/Run — consumed by LaunchConfigFields. */
export const DROPDOWN_MODEL_ENTRIES: readonly Pick<ModelEntry, 'id' | 'label' | 'info'>[] = MODEL_CATALOG.filter(
  m => m.showInDropdown,
).map(m => ({ id: m.id, label: m.label, info: m.info }))
