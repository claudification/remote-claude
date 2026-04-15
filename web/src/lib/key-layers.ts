import { useEffect, useRef } from 'react'

// ── Types ──────────────────────────────────────────────────────────────────

type KeyHandler = (e: KeyboardEvent) => void

type KeyBindings = Record<string, KeyHandler>

interface KeyLayerOptions {
  base?: boolean
  captureTerminal?: boolean
  id?: string
  enabled?: boolean
}

interface Layer {
  id: string
  bindings: KeyBindings
  options: KeyLayerOptions
}

interface DoubleTapState {
  key: string
  time: number
}

// ── Chord mode ──────────────────────────────────────────────────────────────

const CHORD_TIMEOUT = 1500

interface ChordState {
  prefix: string
  timeoutId: ReturnType<typeof setTimeout>
}

let activeChord: ChordState | null = null
type ChordListener = (prefix: string | null) => void
const chordListeners = new Set<ChordListener>()

export function subscribeChordMode(fn: ChordListener): () => void {
  chordListeners.add(fn)
  return () => chordListeners.delete(fn)
}

function notifyChordListeners(prefix: string | null) {
  for (const fn of chordListeners) fn(prefix)
}

function exitChordMode() {
  if (!activeChord) return
  clearTimeout(activeChord.timeoutId)
  activeChord = null
  notifyChordListeners(null)
}

function enterChordMode(prefix: string) {
  if (activeChord) clearTimeout(activeChord.timeoutId)
  const timeoutId = setTimeout(() => {
    activeChord = null
    notifyChordListeners(null)
  }, CHORD_TIMEOUT)
  activeChord = { prefix, timeoutId }
  notifyChordListeners(prefix)
}

// ── Platform detection ─────────────────────────────────────────────────────

const isMac =
  typeof navigator !== 'undefined' &&
  (/Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent))

// ── Layer stack (module singleton) ─────────────────────────────────────────

const layers: Layer[] = []
let listenerInstalled = false
let doubleTap: DoubleTapState = { key: '', time: 0 }

const DOUBLE_TAP_THRESHOLD = 700

// Elements that consume non-modifier keystrokes
function isTextInput(el: Element | null): boolean {
  if (!el) return false
  const tag = (el as HTMLElement).tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if ((el as HTMLElement).isContentEditable) return true
  return false
}

function isTerminal(el: Element | null): boolean {
  if (!el) return false
  return !!(el as HTMLElement).closest?.('.xterm')
}

// ── Key normalization ──────────────────────────────────────────────────────

function normalizeEvent(e: KeyboardEvent): string {
  const parts: string[] = []

  // mod = primary shortcut modifier (Cmd on Mac, Ctrl elsewhere)
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod')
  // ctrl = physical Control key (only distinct from mod on Mac)
  if (isMac && e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')

  // Don't include modifier keys themselves as the key part
  const ignoreKeys = new Set(['Control', 'Meta', 'Alt', 'Shift'])
  if (!ignoreKeys.has(e.key)) {
    // Normalize single letter keys to lowercase so bindings are case-insensitive
    // (Shift+D produces e.key='D', but we want 'shift+d' to match)
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    parts.push(key)
  }

  return parts.join('+')
}

function hasModifier(binding: string): boolean {
  // Only ctrl/cmd/alt count as "pass-through" modifiers that should work in text inputs.
  // shift alone is just typing (shift+? is a character, not a shortcut).
  const passThroughMods = new Set(['mod', 'ctrl', 'alt', 'meta'])
  const parts = binding.split('+')
  return parts.some(p => passThroughMods.has(p))
}

function isDoubleTapBinding(binding: string): boolean {
  return binding.includes(' ')
}

// On non-Mac, physical Ctrl produces 'mod'. But bindings registered as 'ctrl+shift+x'
// (meaning physical Ctrl on all platforms) should also match. Try both.
function findBinding(bindings: KeyBindings, normalized: string): KeyHandler | undefined {
  const handler = bindings[normalized]
  if (handler) return handler
  // Cross-match: ctrl and mod bindings should match each other's events.
  // On Mac: Ctrl+K (ctrl+k) should also match 'mod+k' bindings (old code accepted both)
  // On non-Mac: Ctrl+K (mod+k) should also match 'ctrl+k' bindings (physical Ctrl)
  if (normalized.includes('mod')) return bindings[normalized.replace('mod', 'ctrl')]
  if (normalized.includes('ctrl')) return bindings[normalized.replace('ctrl', 'mod')]
  return undefined
}

// A chord binding has a space between TWO DIFFERENT keys: 'mod+g t'
// A double-tap has the same key twice: 'Escape Escape'
function isChordBinding(binding: string): boolean {
  if (!binding.includes(' ')) return false
  const [a, b] = binding.split(' ', 2)
  return a !== b
}

// Check if normalized key is a chord prefix (any registered binding is a chord starting with it)
function isChordPrefix(normalized: string): boolean {
  // Also check the mod/ctrl equivalent
  const alts = [normalized]
  if (normalized.includes('mod')) alts.push(normalized.replace('mod', 'ctrl'))
  else if (normalized.includes('ctrl')) alts.push(normalized.replace('ctrl', 'mod'))

  for (const layer of layers) {
    if (layer.options.enabled === false) continue
    for (const key of Object.keys(layer.bindings)) {
      if (!isChordBinding(key)) continue
      for (const alt of alts) {
        if (key.startsWith(`${alt} `)) return true
      }
    }
  }
  return false
}

// ── Dispatch ───────────────────────────────────────────────────────────────

function dispatch(e: KeyboardEvent) {
  // Ignore bare modifier presses
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return

  const normalized = normalizeEvent(e)
  const inTextInput = isTextInput(e.target as Element)
  const inTerminal = isTerminal(e.target as Element)

  // ── Chord mode: consume second key ────────────────────────────────────────
  if (activeChord) {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()

    const prefix = activeChord.prefix
    exitChordMode()

    if (normalized === 'Escape') return // ESC = dismiss, no action

    const chordPattern = `${prefix} ${normalized}`
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]
      if (layer.options.enabled === false) continue
      const handler = findBinding(layer.bindings, chordPattern)
      if (handler) {
        handler(e)
        return
      }
    }
    return // No chord match: just dismiss
  }

  // ── Double-tap detection (same key) ───────────────────────────────────────
  const now = Date.now()
  let doubleTapFired = false

  if (doubleTap.key === normalized && now - doubleTap.time < DOUBLE_TAP_THRESHOLD) {
    const doubleTapPattern = `${normalized} ${normalized}`
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]
      if (layer.options.enabled === false) continue
      if (inTerminal && !layer.options.captureTerminal) continue

      const handler = findBinding(layer.bindings, doubleTapPattern)
      if (handler) {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        doubleTap = { key: '', time: 0 }
        handler(e)
        doubleTapFired = true
        break
      }
    }
  }

  if (!doubleTapFired) {
    doubleTap = { key: normalized, time: now }
  }

  if (doubleTapFired) return

  // ── Chord prefix detection ─────────────────────────────────────────────────
  // Chord prefixes work with modifier combos only, and not inside terminals
  const isModified = hasModifier(normalized)
  const isNonPrintable = e.key.length > 1

  if (isModified && !inTerminal && isChordPrefix(normalized)) {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    enterChordMode(normalized)
    return
  }

  // ── Single-key dispatch ────────────────────────────────────────────────────
  if (inTextInput && !isModified && !isNonPrintable) return

  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]
    if (layer.options.enabled === false) continue
    if (inTerminal && !layer.options.captureTerminal) continue

    // Skip double-tap bindings in single-key dispatch
    const handler = !isDoubleTapBinding(normalized) ? findBinding(layer.bindings, normalized) : undefined
    if (handler) {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      handler(e)
      return
    }

    // For non-modifier keys, top non-base layer blocks further propagation
    // (even if it doesn't have a handler for this specific key)
    // Modifier shortcuts pass through all layers
    if (!isModified && !layer.options.base) return
  }
}

function ensureListener() {
  if (listenerInstalled) return
  window.addEventListener('keydown', dispatch, { capture: true })
  listenerInstalled = true
}

function removeListenerIfEmpty() {
  if (layers.length > 0 || !listenerInstalled) return
  window.removeEventListener('keydown', dispatch, { capture: true })
  listenerInstalled = false
}

// ── Stack operations ───────────────────────────────────────────────────────

let layerCounter = 0

function pushLayer(bindings: KeyBindings, options: KeyLayerOptions): Layer {
  ensureListener()
  const layer: Layer = {
    id: options.id ?? `layer-${++layerCounter}`,
    bindings,
    options,
  }

  if (options.base) {
    // Base layers go at the bottom, below other base layers in insertion order
    const firstNonBase = layers.findIndex(l => !l.options.base)
    if (firstNonBase === -1) {
      layers.push(layer)
    } else {
      layers.splice(firstNonBase, 0, layer)
    }
  } else {
    layers.push(layer)
  }

  return layer
}

function popLayer(layer: Layer) {
  const idx = layers.indexOf(layer)
  if (idx !== -1) layers.splice(idx, 1)
  removeListenerIfEmpty()
}

// ── React hook ─────────────────────────────────────────────────────────────

export function useKeyLayer(bindings: KeyBindings, options: KeyLayerOptions = {}) {
  const bindingsRef = useRef(bindings)
  const optionsRef = useRef(options)
  const layerRef = useRef<Layer | null>(null)

  // Keep bindings up to date without re-registering
  bindingsRef.current = bindings
  optionsRef.current = options

  useEffect(() => {
    // Proxy bindings through refs so identity changes don't matter
    const proxyBindings: KeyBindings = {}
    for (const key of Object.keys(bindingsRef.current)) {
      proxyBindings[key] = (e: KeyboardEvent) => bindingsRef.current[key]?.(e)
    }

    const layer = pushLayer(proxyBindings, optionsRef.current)
    layerRef.current = layer

    return () => {
      popLayer(layer)
      layerRef.current = null
    }
  }, []) // mount/unmount only

  // Sync enabled state without re-registering
  useEffect(() => {
    if (layerRef.current) {
      layerRef.current.options.enabled = options.enabled
    }
  }, [options.enabled])

  // Sync bindings: rebuild proxy when keys change
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps tracked via serialized key - Object.keys(bindings).sort().join(',') detects key-set changes; bindings values proxied via ref
  useEffect(() => {
    if (!layerRef.current) return
    const proxyBindings: KeyBindings = {}
    for (const key of Object.keys(bindings)) {
      proxyBindings[key] = (e: KeyboardEvent) => bindingsRef.current[key]?.(e)
    }
    layerRef.current.bindings = proxyBindings
  }, [Object.keys(bindings).sort().join(',')])
}

// ── Debug hook ─────────────────────────────────────────────────────────────

export function useKeyLayerDebug(): readonly Layer[] {
  // Returns a snapshot -- not reactive (the debug console can poll on render)
  return layers
}

// ── Test helpers (tree-shaken in prod) ────────────────────────────────────

export const _test = {
  pushLayer,
  popLayer,
  dispatch,
  normalizeEvent,
  layers,
  resetDoubleTap: () => {
    doubleTap = { key: '', time: 0 }
  },
  exitChordMode,
  getActiveChord: () => activeChord,
}
