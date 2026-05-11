import { describe, expect, it } from 'bun:test'
import { findFirstJsonObject, parseRecapContent } from './json-parse'

describe('findFirstJsonObject', () => {
  it('returns the JSON when raw is just an object', () => {
    expect(findFirstJsonObject('{"a":1}')).toBe('{"a":1}')
  })

  it('strips a leading json code fence', () => {
    expect(findFirstJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('strips a leading bare code fence', () => {
    expect(findFirstJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('grabs the JSON when prose precedes it', () => {
    expect(findFirstJsonObject('Sure: {"a":1} (hope that helps)')).toBe('{"a":1}')
  })

  it('returns null when there is no object', () => {
    expect(findFirstJsonObject('no json here')).toBeNull()
  })
})

describe('parseRecapContent', () => {
  it('returns title + recap from a clean JSON object', () => {
    const out = parseRecapContent('{"title":"T","recap":"R"}')
    expect(out.title).toBe('T')
    expect(out.recap).toBe('R')
  })

  it('returns null title and the raw text on plain prose', () => {
    const out = parseRecapContent('Just a sentence.')
    expect(out.title).toBeNull()
    expect(out.recap).toBe('Just a sentence.')
  })

  it('treats empty title field as null', () => {
    const out = parseRecapContent('{"title":"  ","recap":"R"}')
    expect(out.title).toBeNull()
    expect(out.recap).toBe('R')
  })

  it('keeps the original raw text when JSON parses but recap is missing', () => {
    const out = parseRecapContent('{"title":"T"}')
    expect(out.title).toBe('T')
    expect(out.recap).toBe('{"title":"T"}')
  })

  it('survives a fenced JSON wrapper', () => {
    const out = parseRecapContent('```json\n{"title":"X","recap":"Y"}\n```')
    expect(out.title).toBe('X')
    expect(out.recap).toBe('Y')
  })
})
