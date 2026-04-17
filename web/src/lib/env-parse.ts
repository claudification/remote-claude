/**
 * parseEnvText - Parse a KEY=value-per-line env block into a record.
 * Returns [env, errors]. env is null when there are errors, OR when the
 * trimmed input is empty (so callers can treat "no env set" the same as
 * "no env parsed"). Errors are 1-indexed by line.
 *
 * Shared between SpawnDialog (used at submit time) and LaunchConfigFields
 * (used inline, every keystroke, for live error display).
 */
export function parseEnvText(text: string): [Record<string, string> | null, string[]] {
  if (!text.trim()) return [null, []]
  const env: Record<string, string> = {}
  const errors: string[] = []
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) {
      errors.push(`Line ${i + 1}: missing KEY=value`)
      continue
    }
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`Line ${i + 1}: invalid key "${key}"`)
      continue
    }
    if (/["']/.test(value)) {
      errors.push(`Line ${i + 1}: no quotes needed, use raw value`)
      continue
    }
    env[key] = value
  }
  return [errors.length ? null : Object.keys(env).length ? env : null, errors]
}
