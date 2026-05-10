import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Read-only SQL query against a broker SQLite database. Intended for
 * operational inspection from the host or inside the running container.
 *
 * ```
 * broker-cli query "SELECT COUNT(*) FROM turns"
 * broker-cli query --db analytics "SELECT project_uri, COUNT(*) FROM turns GROUP BY 1"
 * broker-cli query --db projects "SELECT id, scope FROM projects" --json
 * ```
 *
 * Opens in readonly mode -- no mutations possible even if the SQL tries.
 */

type DbName = 'store' | 'analytics' | 'projects'

const DB_FILES: Record<DbName, string> = {
  store: 'store.db',
  analytics: 'analytics.db',
  projects: 'projects.db',
}

export interface QueryCliArgs {
  cacheDir: string
  dbName: DbName
  sql: string
  json: boolean
}

export function runQueryCli(args: QueryCliArgs): void {
  const { cacheDir, dbName, sql, json } = args
  const filename = DB_FILES[dbName]
  if (!filename) {
    console.error(`ERROR: unknown --db: ${dbName}. Use store | analytics | projects`)
    process.exit(1)
  }

  const dbPath = join(cacheDir, filename)
  if (!existsSync(dbPath)) {
    console.error(`ERROR: ${dbPath} does not exist`)
    process.exit(1)
  }

  let db: Database
  try {
    db = new Database(dbPath, { readonly: true })
  } catch (err) {
    console.error(`ERROR: cannot open ${dbPath}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  try {
    const rows = db.query(sql).all() as Array<Record<string, unknown>>
    if (rows.length === 0) {
      if (json) {
        console.log('[]')
      } else {
        console.error('(no rows)')
      }
      return
    }

    if (json) {
      console.log(JSON.stringify(rows, null, 2))
      return
    }

    // Tab-separated rows with a header -- pipe to `column -t -s $'\t'` for
    // aligned output, or to `jq` / `awk` for further processing.
    const headers = Object.keys(rows[0])
    console.log(headers.join('\t'))
    for (const row of rows) {
      console.log(headers.map(h => formatCell(row[h])).join('\t'))
    }
  } catch (err) {
    console.error(`ERROR: query failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  } finally {
    db.close()
  }
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

export interface ExecCliArgs {
  cacheDir: string
  dbName: DbName
  sql: string
  json: boolean
}

export function runExecCli(args: ExecCliArgs): void {
  const { cacheDir, dbName, sql, json } = args
  const filename = DB_FILES[dbName]
  if (!filename) {
    console.error(`ERROR: unknown --db: ${dbName}. Use store | analytics | projects`)
    process.exit(1)
  }

  const dbPath = join(cacheDir, filename)
  if (!existsSync(dbPath)) {
    console.error(`ERROR: ${dbPath} does not exist`)
    process.exit(1)
  }

  let db: Database
  try {
    db = new Database(dbPath)
  } catch (err) {
    console.error(`ERROR: cannot open ${dbPath}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  try {
    const isSelect = /^\s*(select|pragma|explain)\b/i.test(sql)
    if (isSelect) {
      const rows = db.query(sql).all() as Array<Record<string, unknown>>
      if (rows.length === 0) {
        if (json) console.log('[]')
        else console.error('(no rows)')
        return
      }
      if (json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }
      const headers = Object.keys(rows[0])
      console.log(headers.join('\t'))
      for (const row of rows) {
        console.log(headers.map(h => formatCell(row[h])).join('\t'))
      }
    } else {
      const result = db.run(sql)
      const info = { changes: result.changes }
      if (json) {
        console.log(JSON.stringify(info, null, 2))
      } else {
        console.log(`OK: ${info.changes} row(s) affected`)
      }
    }
  } catch (err) {
    console.error(`ERROR: exec failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  } finally {
    db.close()
  }
}

export function parseDbName(raw: string | undefined): DbName {
  if (!raw || raw === 'store') return 'store'
  if (raw === 'analytics' || raw === 'projects') return raw
  console.error(`ERROR: unknown --db: ${raw}. Use store | analytics | projects`)
  process.exit(1)
}
