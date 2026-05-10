/**
 * Curated OpenCode model lists for the spawn dialog dropdown.
 *
 * Sourced from OpenCode 1.14.46's `session/new` configOptions on
 * 2026-05-10 (see .claude/docs/spike-acp-opencode/session-new.json).
 *
 * "OpenCode Go" -- the provider's hosted models.
 * "OpenCode Zen" -- a mix; some are free, some are not.
 *
 * Power users can still pick "Custom..." to type any of the 200+ models
 * OpenCode supports across all providers (OpenRouter, Anthropic, OpenAI,
 * Google, ...). The OPENCODE_DEFAULT sentinel sends `undefined` to the
 * broker so OpenCode picks whatever its config has set.
 */

export const OPENCODE_DEFAULT_SENTINEL = '__opencode_default__'
export const OPENCODE_CUSTOM_SENTINEL = '__opencode_custom__'

export interface OpenCodeModelOption {
  value: string
  label: string
}

export const OPENCODE_GO_MODELS: OpenCodeModelOption[] = [
  { value: 'opencode-go/qwen3.6-plus', label: 'Qwen3.6 Plus' },
  { value: 'opencode-go/qwen3.5-plus', label: 'Qwen3.5 Plus' },
  { value: 'opencode-go/minimax-m2.7', label: 'MiniMax M2.7' },
  { value: 'opencode-go/minimax-m2.5', label: 'MiniMax M2.5' },
  { value: 'opencode-go/mimo-v2.5-pro', label: 'MiMo V2.5 Pro' },
  { value: 'opencode-go/mimo-v2.5', label: 'MiMo V2.5' },
  { value: 'opencode-go/kimi-k2.6', label: 'Kimi K2.6' },
  { value: 'opencode-go/kimi-k2.5', label: 'Kimi K2.5' },
  { value: 'opencode-go/glm-5.1', label: 'GLM-5.1' },
  { value: 'opencode-go/glm-5', label: 'GLM-5' },
  { value: 'opencode-go/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { value: 'opencode-go/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
]

export const OPENCODE_ZEN_MODELS: OpenCodeModelOption[] = [
  { value: 'opencode/big-pickle', label: 'Big Pickle' },
  { value: 'opencode/ring-2.6-1t-free', label: 'Ring 2.6 1T (free)' },
  { value: 'opencode/nemotron-3-super-free', label: 'Nemotron 3 Super (free)' },
  { value: 'opencode/minimax-m2.5-free', label: 'MiniMax M2.5 (free)' },
]

/** Flat list of all curated values -- used to detect when the saved
 *  string corresponds to a curated model vs. needs the "Custom..." mode. */
export const OPENCODE_CURATED_VALUES = new Set<string>([
  ...OPENCODE_GO_MODELS.map(m => m.value),
  ...OPENCODE_ZEN_MODELS.map(m => m.value),
])
