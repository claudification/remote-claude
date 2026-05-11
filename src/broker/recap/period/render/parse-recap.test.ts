import { describe, expect, it } from 'bun:test'
import { parseRecapOutput, RecapParseError } from './parse-recap'

describe('parseRecapOutput', () => {
  it('parses a well-formed recap with frontmatter + body', () => {
    const raw = `---
subtitle: SQLite phase 4 ship
keywords: [sqlite, fts5, wal]
hashtags: [#ship-week, #sqlite-migration]
goals:
  - Ship Phase 4
  - Fix WAL incident
discoveries: [docker cp corrupts WAL]
side_effects: []
features:
  - title: Phase 4 SQLite migration
    conversations: [conv_abc123, conv_def456]
    commits: [abcd123, deadbee]
bugs: []
fixes: []
incidents:
  - title: WAL corruption
    severity: high
open_questions:
  - What is the long-term retention policy for recap_logs?
stakeholders: []
---

## TL;DR

- Shipped Phase 4
`
    const out = parseRecapOutput(raw)
    expect(out.metadata.subtitle).toBe('SQLite phase 4 ship')
    expect(out.metadata.keywords).toContain('sqlite')
    expect(out.metadata.hashtags).toContain('#ship-week')
    expect(out.metadata.goals.length).toBe(2)
    expect(out.metadata.discoveries[0]).toBe('docker cp corrupts WAL')
    expect(out.metadata.features.length).toBe(1)
    expect(out.metadata.features[0].title).toBe('Phase 4 SQLite migration')
    expect(out.metadata.features[0].conversations).toContain('conv_abc123')
    expect(out.metadata.open_questions.length).toBe(1)
    expect(out.body.startsWith('## TL;DR')).toBe(true)
  })

  it('throws RecapParseError when frontmatter is missing', () => {
    expect(() => parseRecapOutput('No frontmatter here, just body.')).toThrow(RecapParseError)
  })

  it('returns empty arrays for missing list fields', () => {
    const raw = `---
subtitle: minimal
---

body`
    const out = parseRecapOutput(raw)
    expect(out.metadata.keywords).toEqual([])
    expect(out.metadata.features).toEqual([])
  })
})
