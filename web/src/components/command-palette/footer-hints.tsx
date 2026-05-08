import { haptic } from '@/lib/utils'
import type { PaletteMode } from './types'

function Kbd({ children }: { children: string }) {
  return <kbd className="px-1 py-0.5 bg-primary/12 rounded">{children}</kbd>
}

/** Tappable prefix chip - visible only on touch devices, inserts prefix into input */
function PrefixChip({ prefix, label, onTap }: { prefix: string; label: string; onTap: (prefix: string) => void }) {
  function handleTap() {
    haptic('tap')
    onTap(prefix)
  }
  return (
    <span
      role="button"
      tabIndex={0}
      className="touch-chip cursor-pointer active:bg-primary/20 rounded px-1 -mx-0.5"
      onClick={handleTap}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') handleTap()
      }}
    >
      <Kbd>{prefix}</Kbd> {label}
    </span>
  )
}

interface FooterHintsProps {
  mode: PaletteMode
  sentinelConnected: boolean
  onPrefixTap?: (prefix: string) => void
}

export function FooterHints({ mode, sentinelConnected, onPrefixTap }: FooterHintsProps) {
  return (
    <div className="px-3 py-1.5 border-t border-primary/20 flex items-center gap-3 text-[10px] text-comment">
      <span>
        <Kbd>↑↓</Kbd> navigate
      </span>
      {mode === 'theme' ? (
        <>
          <span>
            <Kbd>↑↓</Kbd> preview
          </span>
          <span>
            <Kbd>⏎</Kbd> apply
          </span>
          <span>
            <Kbd>esc</Kbd> revert
          </span>
        </>
      ) : mode === 'spawn' ? (
        <>
          <span>
            <Kbd>tab</Kbd> complete
          </span>
          <span>
            <Kbd>⏎</Kbd> spawn
          </span>
          <span>
            <Kbd>esc</Kbd> back
          </span>
        </>
      ) : mode === 'file' ? (
        <>
          <span>
            <Kbd>⏎</Kbd> open file
          </span>
          <span>
            <Kbd>esc</Kbd> back
          </span>
        </>
      ) : mode === 'command' ? (
        <>
          <span>
            <Kbd>⏎</Kbd> run
          </span>
          <span>
            <Kbd>esc</Kbd> back
          </span>
        </>
      ) : (
        <>
          <span>
            <Kbd>⏎</Kbd> select
          </span>
          {onPrefixTap ? (
            <PrefixChip prefix=">" label="cmd" onTap={onPrefixTap} />
          ) : (
            <span>
              <Kbd>&gt;</Kbd> cmd
            </span>
          )}
          {onPrefixTap ? (
            <PrefixChip prefix="F:" label="files" onTap={onPrefixTap} />
          ) : (
            <span>
              <Kbd>F:</Kbd> files
            </span>
          )}
          {onPrefixTap ? (
            <PrefixChip prefix="@" label="tasks" onTap={onPrefixTap} />
          ) : (
            <span>
              <Kbd>@</Kbd> tasks
            </span>
          )}
          {sentinelConnected &&
            (onPrefixTap ? (
              <PrefixChip prefix="S:" label="spawn" onTap={onPrefixTap} />
            ) : (
              <span>
                <Kbd>S:</Kbd> spawn
              </span>
            ))}
          <span>
            <Kbd>esc</Kbd> close
          </span>
        </>
      )}
    </div>
  )
}
