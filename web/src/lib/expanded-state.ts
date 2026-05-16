// Collapsible expanded state - module-level to survive virtualizer remounts
// Separate module to avoid circular deps (use-conversations <-> transcript-view)
export const expandedState = new Set<string>()
export const defaultOpenApplied = new Set<string>()

export function clearExpandedState() {
  expandedState.clear()
  defaultOpenApplied.clear()
}
