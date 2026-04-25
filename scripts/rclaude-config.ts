#!/usr/bin/env bun
/**
 * rclaude-config -- interactive web editor for .rclaude/rclaude.json
 *
 * Usage: bun scripts/rclaude-config.ts [project-path]
 *
 * Serves a web UI on a random port and opens the browser.
 * Reads/writes .rclaude/rclaude.json in the target project directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const projectPath = resolve(process.argv[2] || process.cwd())
const configPath = join(projectPath, '.rclaude', 'rclaude.json')
const schemaUrl = 'https://raw.githubusercontent.com/claudification/claudewerk/main/schemas/rclaude.schema.json'

const htmlPath = join(dirname(new URL(import.meta.url).pathname), 'rclaude-config.html')

interface FileRule {
  allow?: string[]
}

interface RclaudeConfig {
  $schema?: string
  permissions?: {
    Write?: FileRule
    Edit?: FileRule
    Read?: FileRule
  }
  allowPlanMode?: boolean
}

function readConfig(): RclaudeConfig | null {
  if (!existsSync(configPath)) return null
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    return null
  }
}

function writeConfig(config: RclaudeConfig): void {
  const dir = join(projectPath, '.rclaude')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  config.$schema = schemaUrl
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/api/config') {
      if (req.method === 'GET') {
        return Response.json({
          config: readConfig(),
          path: configPath,
          project: projectPath,
          exists: existsSync(configPath),
        })
      }
      if (req.method === 'PUT') {
        return req
          .json()
          .then((body: { config: RclaudeConfig }) => {
            writeConfig(body.config)
            return Response.json({ ok: true })
          })
          .catch(err => Response.json({ error: String(err) }, { status: 400 }))
      }
    }

    if (!existsSync(htmlPath)) {
      return new Response('HTML file not found. Run from the scripts/ directory.', { status: 500 })
    }
    return new Response(readFileSync(htmlPath, 'utf-8'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  },
})

const url = `http://127.0.0.1:${server.port}`
console.log(`rclaude config editor: ${url}`)
console.log(`project: ${projectPath}`)
console.log(`config:  ${configPath}`)
console.log()
console.log('Press Ctrl+C to stop.')

Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' })
