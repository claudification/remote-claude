/**
 * ACP dialect -> CLAUDEWERK canonical vocabulary.
 *
 * The ACP wire format is mostly camelCase + lowercase tool names. Each ACP
 * agent (opencode, codex, gemini, ...) has its own quirks; we route through
 * a per-agent sub-dialect. The `from-acp-opencode` mapper handles opencode;
 * codex/gemini fall through to a generic mapper that does best-effort
 * canonicalization based on the camelCase tool name.
 *
 * Mutates blocks in place. Idempotent.
 */

import type { TranscriptContentBlock } from '../../shared/protocol'
import type { ToolBackend } from '../../shared/tool-vocab'
import {
  type AcpToolResultContext,
  translateGenericAcpToolResult,
  translateGenericAcpToolUse,
} from './from-acp-generic'
import { translateOpencodeToolResult, translateOpencodeToolUse } from './from-acp-opencode'

export interface AcpDialectContext {
  /** ACP agent name as configured in the recipe (e.g. 'opencode', 'codex',
   *  'gemini-acp'). Used to dispatch to a per-agent sub-dialect. */
  acpAgent: string
}

/** Build the wire `backend` identifier for an ACP-hosted agent. */
export function acpBackendId(acpAgent: string): ToolBackend {
  // Normalize variants: 'gemini-acp' / 'gemini_acp' / 'gemini' all become
  // 'acp:gemini'.
  const normalized = acpAgent.toLowerCase().replace(/-acp$|_acp$/, '')
  return `acp:${normalized}` as ToolBackend
}

export function translateAcpToolUse(block: TranscriptContentBlock, ctx: AcpDialectContext): void {
  if (block.type !== 'tool_use') return
  if (block.kind) return
  const agent = ctx.acpAgent.toLowerCase()
  if (agent === 'opencode' || agent.startsWith('opencode')) {
    translateOpencodeToolUse(block, acpBackendId(ctx.acpAgent))
    return
  }
  translateGenericAcpToolUse(block, acpBackendId(ctx.acpAgent))
}

export function translateAcpToolResult(
  block: TranscriptContentBlock,
  result: AcpToolResultContext,
  ctx: AcpDialectContext,
): void {
  if (block.type !== 'tool_result') return
  if (block.result) return
  const agent = ctx.acpAgent.toLowerCase()
  if (agent === 'opencode' || agent.startsWith('opencode')) {
    translateOpencodeToolResult(block, result, acpBackendId(ctx.acpAgent))
    return
  }
  translateGenericAcpToolResult(block, result, acpBackendId(ctx.acpAgent))
}

export type { AcpToolResultContext } from './from-acp-generic'
