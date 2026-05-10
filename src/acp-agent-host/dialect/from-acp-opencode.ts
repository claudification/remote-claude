/**
 * opencode-via-ACP dialect mapper. opencode is the most common ACP backend
 * we host today, so the generic mapper already handles its quirks
 * (camelCase keys, `<path>/<type>/<content>` read wrapper, `include` for
 * grep glob, `workdir` for bash cwd, todowrite priority field). This file
 * exists as the named entry point per the plan; if opencode-specific
 * behavior diverges later (e.g. webfetch input shape, REPL tool), add it
 * here and bypass the generic fallback for known kinds.
 */

import type { TranscriptContentBlock } from '../../shared/protocol'
import type { ToolBackend } from '../../shared/tool-vocab'
import {
  type AcpToolResultContext,
  translateGenericAcpToolResult,
  translateGenericAcpToolUse,
} from './from-acp-generic'

export function translateOpencodeToolUse(block: TranscriptContentBlock, backend: ToolBackend): void {
  translateGenericAcpToolUse(block, backend)
}

export function translateOpencodeToolResult(
  block: TranscriptContentBlock,
  ctx: AcpToolResultContext,
  backend: ToolBackend,
): void {
  translateGenericAcpToolResult(block, ctx, backend)
}
