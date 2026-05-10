/**
 * Control Verb Dispatcher
 * Executes high-level control verbs (clear, quit, interrupt, set_model, etc.)
 * against the local CC process. Backend-specific: headless uses typed methods,
 * PTY writes raw slash commands into CC's CLI input layer.
 */

import type { AgentHostContext } from './agent-host-context'
import { beginLaunch, emitLaunchEvent } from './launch-events'

/**
 * Execute a control action against the local CC process.
 * Shared entry point for dashboard input, control buttons, and inter-session MCP.
 */
export function executeControl(
  ctx: AgentHostContext,
  action: 'clear' | 'quit' | 'interrupt' | 'set_model' | 'set_effort' | 'set_permission_mode',
  args: { model?: string; effort?: string; permissionMode?: string; source?: string } = {},
): boolean {
  const source = args.source || 'unknown'
  if (ctx.headless) {
    return executeHeadlessControl(ctx, action, args, source)
  }
  return executePtyControl(ctx, action, args, source)
}

function executeHeadlessControl(
  ctx: AgentHostContext,
  action: string,
  args: { model?: string; effort?: string; permissionMode?: string },
  source: string,
): boolean {
  if (!ctx.streamProc) return false
  switch (action) {
    case 'clear':
      ctx.diag('conversation', `Clear requested (${source}) - killing CC and respawning fresh`)
      beginLaunch(ctx, 'reboot')
      emitLaunchEvent(ctx, 'clear_requested', { detail: source })
      ctx.streamProc.kill()
      ctx.clearRequested = true
      return true
    case 'quit': {
      ctx.diag('conversation', `Quit requested (${source}) - closing stdin for graceful shutdown`)
      const closed = ctx.streamProc.closeStdin()
      if (closed) {
        const proc = ctx.streamProc
        setTimeout(() => {
          if (!proc.proc.killed) {
            ctx.diag('conversation', 'CC still alive 10s after stdin close - sending SIGTERM')
            proc.kill()
          }
        }, 10_000)
      } else {
        ctx.diag('conversation', 'Stdin close failed - falling back to SIGTERM')
        ctx.streamProc.kill()
      }
      return true
    }
    case 'interrupt':
      ctx.diag('conversation', `Interrupt requested (${source})`)
      ctx.streamProc.sendInterrupt()
      return true
    case 'set_model':
      if (!args.model) return false
      ctx.diag('conversation', `Set model requested (${source}): ${args.model}`)
      ctx.streamProc.sendSetModel(args.model)
      return true
    case 'set_effort':
      if (!args.effort) return false
      ctx.diag('conversation', `Set effort requested (${source}): ${args.effort}`)
      ctx.streamProc.sendSetEffort(args.effort)
      return true
    case 'set_permission_mode':
      if (!args.permissionMode) return false
      ctx.diag('conversation', `Set permission mode requested (${source}): ${args.permissionMode}`)
      ctx.streamProc.sendSetPermissionMode(args.permissionMode)
      return true
    default:
      return false
  }
}

function executePtyControl(
  ctx: AgentHostContext,
  action: string,
  args: { model?: string; effort?: string; permissionMode?: string },
  source: string,
): boolean {
  if (!ctx.ptyProcess) return false
  switch (action) {
    case 'clear':
      ctx.diag('conversation', `Clear requested (${source}) - injecting /clear via PTY`)
      beginLaunch(ctx, 'reboot')
      emitLaunchEvent(ctx, 'clear_requested', { detail: `${source} (pty)` })
      ctx.ptyProcess.write('/clear\r')
      return true
    case 'quit':
      ctx.diag('conversation', `Quit requested (${source}) - sending SIGTERM to PTY`)
      ctx.ptyProcess.kill('SIGTERM')
      return true
    case 'interrupt':
      ctx.diag('conversation', `Interrupt requested (${source}) - sending Ctrl+C to PTY`)
      ctx.ptyProcess.write('\x03')
      return true
    case 'set_model':
      if (!args.model) return false
      ctx.diag('conversation', `Set model requested (${source}): ${args.model}`)
      ctx.ptyProcess.write(`/model ${args.model}\r`)
      return true
    case 'set_effort':
      if (!args.effort) return false
      ctx.diag('conversation', `Set effort requested (${source}): ${args.effort}`)
      ctx.ptyProcess.write(`/effort ${args.effort}\r`)
      return true
    case 'set_permission_mode':
      if (!args.permissionMode) return false
      ctx.diag('conversation', `Set permission mode not supported in PTY mode (${source}): ${args.permissionMode}`)
      return false
    default:
      return false
  }
}
