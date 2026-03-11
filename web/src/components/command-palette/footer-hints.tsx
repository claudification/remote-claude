import type { PaletteMode } from './types'

function Kbd({ children }: { children: string }) {
  return <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">{children}</kbd>
}

export function FooterHints({ mode, agentConnected }: { mode: PaletteMode; agentConnected: boolean }) {
  return (
    <div className="px-3 py-1.5 border-t border-[#33467c]/50 flex items-center gap-3 text-[10px] text-[#565f89]">
      <span>
        <Kbd>↑↓</Kbd> navigate
      </span>
      {mode === 'spawn' ? (
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
          <span>
            <Kbd>F:</Kbd> files
          </span>
          {agentConnected && (
            <span>
              <Kbd>S:</Kbd> spawn
            </span>
          )}
          <span>
            <Kbd>esc</Kbd> close
          </span>
        </>
      )}
    </div>
  )
}
