import type { RecapMetadata } from './parse-recap'

export interface DenormalizedTag {
  recapId: string
  tag: string
  kind: 'hashtag' | 'keyword' | 'goal' | 'stakeholder'
}

export function denormalizeTags(recapId: string, metadata: RecapMetadata): DenormalizedTag[] {
  const tags: DenormalizedTag[] = []
  for (const h of metadata.hashtags) tags.push({ recapId, tag: stripHash(h), kind: 'hashtag' })
  for (const k of metadata.keywords) tags.push({ recapId, tag: lower(k), kind: 'keyword' })
  for (const g of metadata.goals) tags.push({ recapId, tag: lower(g).slice(0, 80), kind: 'goal' })
  for (const s of metadata.stakeholders) tags.push({ recapId, tag: lower(s), kind: 'stakeholder' })
  return tags
}

export function buildFtsFields(metadata: RecapMetadata, body: string, projectUri: string, title: string) {
  return {
    projectUri,
    title,
    subtitle: metadata.subtitle ?? '',
    keywords: metadata.keywords.join(' '),
    goals: metadata.goals.join(' '),
    discoveries: metadata.discoveries.join(' '),
    sideEffects: metadata.side_effects.join(' '),
    body,
  }
}

function stripHash(s: string): string {
  return s.replace(/^#+/, '').toLowerCase()
}

function lower(s: string): string {
  return s.trim().toLowerCase()
}
