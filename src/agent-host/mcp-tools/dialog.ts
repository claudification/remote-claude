import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import type { DialogLayout } from '../../shared/dialog-schema'
import { dialogToolInputSchema, validateDialogLayout } from '../../shared/dialog-schema'
import { isPathWithinCwd } from '../../shared/path-guard'
import { debug } from '../debug'
import type { McpToolContext, ToolDef } from './types'

function isUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://')
}

async function resolveDialogFiles(
  components: Array<Record<string, unknown>>,
  uploadFile: (path: string) => Promise<string | null>,
  cwd: string,
  elog: (msg: string) => void,
): Promise<string | null> {
  for (const comp of components) {
    try {
      const type = comp.type as string

      if (type === 'Markdown' && typeof comp.file === 'string' && !comp.content) {
        const filePath = comp.file as string
        const absPath = resolvePath(cwd, filePath)
        if (!isPathWithinCwd(absPath, cwd)) {
          return `Markdown file outside project directory: ${filePath}. Move it into ${cwd} first.`
        }
        try {
          const file = Bun.file(absPath)
          if (!(await file.exists())) {
            return `Markdown file not found: ${filePath} (resolved to ${absPath})`
          }
          comp.content = await file.text()
          delete comp.file
          elog(`inlined file: ${filePath} (${(comp.content as string).length} chars)`)
        } catch (err) {
          return `Markdown file not readable: ${filePath} (${err instanceof Error ? err.message : 'unknown'})`
        }
      }

      if (type === 'Image' && typeof comp.url === 'string' && !isUrl(comp.url)) {
        const absPath = resolvePath(cwd, comp.url)
        if (!isPathWithinCwd(absPath, cwd)) {
          return `Image file outside project directory: ${comp.url}. Move it into ${cwd} first.`
        }
        try {
          const file = Bun.file(absPath)
          if (!(await file.exists())) {
            return `Image file not found: ${comp.url} (resolved to ${absPath})`
          }
        } catch {
          return `Image file not accessible: ${comp.url} (resolved to ${absPath})`
        }
        const url = await uploadFile(absPath)
        if (!url) return `Failed to upload image: ${comp.url}`
        comp.url = url
      }

      if (type === 'ImagePicker' && Array.isArray(comp.images)) {
        for (const img of comp.images as Array<Record<string, unknown>>) {
          if (typeof img.url === 'string' && !isUrl(img.url)) {
            const absPath = resolvePath(cwd, img.url)
            if (!isPathWithinCwd(absPath, cwd)) {
              return `ImagePicker file outside project directory: ${img.url}. Move it into ${cwd} first.`
            }
            try {
              const file = Bun.file(absPath)
              if (!(await file.exists())) {
                return `ImagePicker file not found: ${img.url} (resolved to ${absPath})`
              }
            } catch {
              return `ImagePicker file not accessible: ${img.url} (resolved to ${absPath})`
            }
            const url = await uploadFile(absPath)
            if (!url) return `Failed to upload image: ${img.url}`
            img.url = url
          }
        }
      }

      if (Array.isArray(comp.children)) {
        const err = await resolveDialogFiles(
          comp.children as Array<Record<string, unknown>>,
          uploadFile,
          cwd,
          elog,
        )
        if (err) return err
      }
    } catch (err) {
      elog(`resolveDialogFiles error: ${err instanceof Error ? err.message : err}`)
      return `File resolution error: ${err instanceof Error ? err.message : 'unknown'}`
    }
  }
  return null
}

export function registerDialogTool(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    dialog: {
      description:
        'PREFERRED way to interact with users. Use this PROACTIVELY whenever you need user input, decisions, confirmations, or want to present structured information. Do NOT ask questions in plain text -- use dialog instead for a rich UI experience. Shows an interactive dialog modal in the dashboard and waits for the user to respond. Supports: choices (single/multi select), text inputs, toggles, sliders, image display and selection, markdown content, code blocks, mermaid diagrams, alerts, collapsible groups, grids, and multi-page wizards. The user interacts on their device (phone/desktop) and the result comes back as structured JSON. BLOCKING call -- waits for submit/cancel/timeout (default 5 min, auto-extends on user interaction). Use "body" for single-page or "pages" for multi-step flows.',
      inputSchema: dialogToolInputSchema(),
      async handle(_params, toolCtx) {
        try {
          ctx.elog(' ENTER')
          const layout = toolCtx.rawArgs as unknown as DialogLayout
          ctx.elog(` validating layout title="${layout?.title}"`)
          const validationErrors = validateDialogLayout(layout)
          if (validationErrors.length > 0) {
            ctx.elog(` validation failed: ${validationErrors.join('; ')}`)
            return {
              content: [{ type: 'text', text: `Invalid dialog layout:\n${validationErrors.join('\n')}` }],
              isError: true,
            }
          }

          ctx.elog(' resolving file paths...')
          const allComponents: Array<Record<string, unknown>> = []
          if (layout.body) allComponents.push(...(layout.body as unknown as Array<Record<string, unknown>>))
          if (layout.pages) {
            for (const page of layout.pages as unknown as Array<{ body: Array<Record<string, unknown>> }>) {
              allComponents.push(...page.body)
            }
          }
          ctx.elog(` ${allComponents.length} top-level components`)
          const uploader = ctx.callbacks.onShareFile
          if (uploader) {
            debug('[channel] dialog: uploading files (CWD-jailed)')
            const dialogCwd = ctx.getDialogCwd()
            const uploadErr = await resolveDialogFiles(allComponents, uploader, dialogCwd, ctx.elog)
            if (uploadErr) {
              ctx.elog(` upload error: ${uploadErr}`)
              return { content: [{ type: 'text', text: `Dialog file error: ${uploadErr}` }], isError: true }
            }
            ctx.elog(' file upload complete')
          }

          const timeout = (layout.timeout ?? 300) * 1000
          const dialogId = randomUUID()

          ctx.elog(` "${layout.title}" (${dialogId.slice(0, 8)}, timeout=${timeout / 1000}s)`)

          ctx.callbacks.onDialogShow?.(dialogId, layout)
          ctx.elog(' forwarded to broker, waiting for result...')

          const timer = setTimeout(() => {
            const pending = ctx.pendingDialogs.get(dialogId)
            if (pending) {
              ctx.pendingDialogs.delete(dialogId)
              ctx.elog(` timeout: ${dialogId.slice(0, 8)}`)
              ctx.callbacks.onDeliverMessage?.('Dialog timed out - user did not respond.', {
                sender: 'dialog',
                dialog_id: dialogId,
                status: 'timeout',
              })
              ctx.callbacks.onDialogDismiss?.(dialogId)
            }
          }, timeout)

          ctx.pendingDialogs.set(dialogId, {
            resolve: () => {},
            timer,
            timeoutMs: timeout,
            deadline: Date.now() + timeout,
          })

          ctx.elog(' returned immediately (result via channel)')
          return {
            content: [
              {
                type: 'text',
                text: `Dialog "${layout.title}" shown to user. The response will arrive as a channel message when the user submits. Dialog ID: ${dialogId}`,
              },
            ],
          }
        } catch (exploreErr) {
          const msg = exploreErr instanceof Error ? exploreErr.stack || exploreErr.message : String(exploreErr)
          ctx.elog(` CRASH: ${msg}`)
          try {
            const crashFile = `/tmp/rclaude-dialog-crash-${Date.now()}.log`
            await Bun.write(crashFile, `${new Date().toISOString()}\n${msg}\n`)
            ctx.elog(` crash log: ${crashFile}`)
          } catch {
            /* ignore write failure */
          }
          return { content: [{ type: 'text', text: `Dialog internal error: ${msg}` }], isError: true }
        }
      },
    },
  }
}
