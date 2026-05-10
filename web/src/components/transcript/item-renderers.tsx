import { cn } from '@/lib/utils'
import { CopyMenu } from '../copy-menu'
import { JsonInspector } from '../json-inspector'
import { Markdown } from '../markdown'
import { AgentTranscriptInline } from './agent-views'
import { makeEncryptedGlyphs } from './encrypted-thinking-glyphs'
import type { RenderItem, SubagentRef } from './group-view-types'
import { MemoizedToolLine } from './tool-line'
import { BashOutput } from './tool-renderers'

export { ChannelItem } from './channel-renderers'

export function ThinkingItem({ item }: { item: Extract<RenderItem, { kind: 'thinking' }> }) {
  const isEncrypted = !item.text && typeof item.encryptedBytes === 'number'
  const estBytes = isEncrypted ? Math.round((item.encryptedBytes as number) * 0.75) : 0
  const sigSeed =
    isEncrypted && item.rawBlock
      ? (item.rawBlock as { signature?: string }).signature || String(item.encryptedBytes)
      : ''
  const glyphs = isEncrypted ? makeEncryptedGlyphs(sigSeed, estBytes) : ''

  return (
    <div className="border-l-2 border-purple-400/40 pl-3 py-1">
      <div className="text-[10px] text-purple-400/70 uppercase font-bold tracking-wider mb-1 flex items-center gap-1.5">
        <span>thinking</span>
        {isEncrypted && (
          <>
            <span className="text-purple-400/40 normal-case font-normal tracking-normal">encrypted, ~{estBytes}b</span>
            {item.rawBlock && (
              <JsonInspector
                title="encrypted thinking block"
                data={item.rawBlock as unknown as Record<string, unknown>}
              />
            )}
          </>
        )}
      </div>
      {isEncrypted ? (
        <pre
          className="text-[10px] font-mono text-purple-400/35 leading-[1.15] whitespace-pre overflow-x-auto"
          title="Anthropic ships Claude 4.7 thinking as a signed/encrypted blob. Plaintext is not available to the client."
        >
          {glyphs}
        </pre>
      ) : (
        <div className="text-sm opacity-75">
          <Markdown>{item.text}</Markdown>
        </div>
      )}
    </div>
  )
}

export function ProjectTaskItem({ item }: { item: Extract<RenderItem, { kind: 'project-task' }> }) {
  const prioColors: Record<string, string> = {
    high: 'border-l-red-500',
    medium: 'border-l-amber-500',
    low: 'border-l-blue-500',
  }
  const prioColor = prioColors[item.priority || 'medium'] || prioColors.medium
  const statusColors: Record<string, string> = {
    inbox: 'bg-zinc-500/20 text-zinc-400',
    open: 'bg-blue-500/20 text-blue-400',
    'in-progress': 'bg-amber-500/20 text-amber-400',
    'in-review': 'bg-purple-500/20 text-purple-400',
    done: 'bg-emerald-500/20 text-emerald-400',
  }
  const sColor = statusColors[item.taskStatus || ''] || statusColors.inbox

  return (
    <div
      className={cn('rounded-lg border border-primary/15 bg-primary/[0.06] border-l-[3px] overflow-hidden', prioColor)}
    >
      <div className="px-3 py-2 flex items-center gap-2 border-b border-primary/12">
        <span className="text-xs font-mono text-muted-foreground/50">TASK</span>
        <span className="text-sm font-bold text-foreground/90 flex-1 truncate">{item.title}</span>
        {item.taskStatus && (
          <span className={cn('px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded', sColor)}>
            {item.taskStatus}
          </span>
        )}
        {item.priority && item.priority !== 'medium' && (
          <span className="text-[9px] font-mono text-muted-foreground/40 uppercase">{item.priority}</span>
        )}
      </div>
      {item.tags && item.tags.length > 0 && (
        <div className="px-3 pt-1.5 flex gap-1 flex-wrap">
          {item.tags.map(tag => (
            <span key={tag} className="px-1.5 py-0.5 text-[9px] font-mono bg-indigo-500/15 text-indigo-400/80 rounded">
              {tag}
            </span>
          ))}
        </div>
      )}
      {item.body && (
        <div className="px-3 py-2 text-sm text-foreground/70">
          <Markdown>{item.body}</Markdown>
        </div>
      )}
      <div className="px-3 pb-1.5">
        <span className="text-[9px] font-mono text-muted-foreground/30">{item.id}.md</span>
      </div>
    </div>
  )
}

export function TextItem({ item }: { item: Extract<RenderItem, { kind: 'text' }> }) {
  const isApiError = /^API Error:\s*\d+\s*\{/.test(item.text)

  if (isApiError) {
    return (
      <div className="text-sm px-3 py-2 bg-destructive/15 border border-destructive/40 rounded font-mono">
        <div className="text-destructive font-bold text-xs uppercase mb-1">API Error</div>
        <pre className="text-[11px] text-destructive/80 whitespace-pre-wrap break-all">{item.text}</pre>
      </div>
    )
  }

  return (
    <div className="text-sm group/text relative">
      <Markdown>{item.text}</Markdown>
      <CopyMenu
        text={item.text}
        copyAsImage
        className="absolute top-0 right-0 opacity-60 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/text:opacity-60 hover:!opacity-100 transition-opacity"
      />
    </div>
  )
}

export function ImagesItem({ item }: { item: Extract<RenderItem, { kind: 'images' }> }) {
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {item.images.map(img => (
        <a
          key={img.hash}
          href={img.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
          title={img.originalPath}
        >
          <img
            src={img.url}
            alt={img.originalPath.split('/').pop() || 'image'}
            className="max-w-xs max-h-48 rounded border border-border hover:border-primary transition-colors"
            loading="lazy"
          />
        </a>
      ))}
    </div>
  )
}

export function ToolItem({
  item,
  expandAll,
  subagents,
  planContext,
}: {
  item: Extract<RenderItem, { kind: 'tool' }>
  expandAll: boolean
  subagents?: SubagentRef
  planContext?: { content: string; path?: string }
}) {
  return (
    <MemoizedToolLine
      tool={item.tool}
      result={item.result}
      toolUseResult={item.extra}
      isError={item.isError}
      expandAll={expandAll}
      subagents={subagents}
      renderAgentInline={(agentId, toolId) => <AgentTranscriptInline agentId={agentId} toolId={toolId} />}
      {...(item.tool.name === 'ExitPlanMode' && planContext
        ? { planContent: planContext.content, planPath: planContext.path }
        : {})}
    />
  )
}

export function BashItem({ item }: { item: Extract<RenderItem, { kind: 'bash' }> }) {
  return (
    <div className="text-sm">
      <BashOutput result={item.text} />
    </div>
  )
}
