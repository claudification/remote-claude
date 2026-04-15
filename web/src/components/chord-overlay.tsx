/**
 * ChordOverlay - Shows available chord completions after a chord prefix is pressed (e.g. ⌘G)
 */

import { useEffect, useState } from 'react'
import { formatShortcut, getCommands } from '@/lib/commands'
import { subscribeChordMode } from '@/lib/key-layers'

interface ChordItem {
  key: string
  label: string
}

export function ChordOverlay() {
  const [prefix, setPrefix] = useState<string | null>(null)

  useEffect(() => {
    return subscribeChordMode(setPrefix)
  }, [])

  if (!prefix) return null

  // Build list of available chord actions from command registry
  const prefixPlusSpace = `${prefix} `
  const chords: ChordItem[] = getCommands()
    .filter(cmd => cmd.shortcut?.startsWith(prefixPlusSpace))
    .map(cmd => {
      const secondKey = cmd.shortcut!.slice(prefixPlusSpace.length)
      return { key: formatShortcut(secondKey), label: cmd.label }
    })
    .sort((a, b) => a.key.localeCompare(b.key))

  const formattedPrefix = formatShortcut(prefix)

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center pointer-events-none">
      <div
        className="pointer-events-auto font-mono text-sm bg-zinc-950 border border-zinc-700 shadow-2xl animate-in fade-in zoom-in-95 duration-100"
        style={{ minWidth: 280 }}
      >
        {/* Prefix indicator */}
        <div className="px-4 py-3 border-b border-zinc-700 flex items-center gap-3">
          <span className="text-2xl font-bold text-cyan-400 tracking-tight">{formattedPrefix}</span>
          <span className="text-zinc-500 text-xs">─ chord mode</span>
        </div>

        {/* Chord list */}
        <div className="py-1">
          {chords.length === 0 ? (
            <div className="px-4 py-2 text-zinc-500 text-xs">no chords registered</div>
          ) : (
            chords.map(item => (
              <div key={item.key} className="flex items-center gap-3 px-4 py-1.5 hover:bg-zinc-800/50">
                <span className="w-8 text-right text-yellow-400 font-bold text-sm shrink-0">{item.key}</span>
                <span className="text-zinc-300 text-xs">{item.label}</span>
              </div>
            ))
          )}
        </div>

        {/* ESC hint */}
        <div className="px-4 py-2 border-t border-zinc-800 text-zinc-600 text-[10px] flex items-center gap-2">
          <span className="text-zinc-500">ESC</span>
          <span>cancel</span>
        </div>
      </div>
    </div>
  )
}
