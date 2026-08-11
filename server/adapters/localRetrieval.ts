import type { Knowledge } from '../../shared/domain/models.js'
import type { Relation } from '../../shared/domain/enums.js'

export interface RetrievalMatch {
  relation: Relation
  existingKnowledgeId?: string
  confidence: number
  aiReason: string
}

/** Normalization shared by candidate hashing and local duplicate matching. */
export function normalizeKnowledgeText(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/≥/gu, '>=')
    .replace(/≤/gu, '<=')
    .replace(/\s+/gu, '')
    .replace(/[。！？!?；;.]+$/gu, '')
}

function tokenSet(value: string) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const tokens = new Set<string>()
  for (const match of normalized.matchAll(/[\p{Script=Han}]|[a-z0-9]+/giu)) tokens.add(match[0])
  return tokens
}

export class LocalRetrieval {
  findMatch(content: string, knowledge: Knowledge[]): RetrievalMatch {
    const active = knowledge.filter((item) => item.status === 'ACTIVE')
    const normalizedContent = normalizeKnowledgeText(content)
    const exact = active.find((item) => normalizeKnowledgeText(item.content) === normalizedContent)
    if (exact) {
      const lowConfidence = content.includes('可能重复')
      return {
        relation: 'DUPLICATE',
        existingKnowledgeId: exact.id,
        confidence: lowConfidence ? 0.85 : 0.98,
        aiReason: lowConfidence ? 'LOCAL_EXACT_MATCH_BUT_LOW_CONFIDENCE_FIXTURE' : 'LOCAL_EXACT_MATCH',
      }
    }

    const markerMatch = active
      .map((item) => ({ item, score: this.overlapScore(content, `${item.title}${item.content}`) }))
      .sort((left, right) => right.score - left.score)[0]
    const markerKnowledge = markerMatch && markerMatch.score > 0 ? markerMatch.item : undefined
    if (content.includes('更新标记') && markerKnowledge) {
      return {
        relation: 'UPDATE',
        existingKnowledgeId: markerKnowledge.id,
        confidence: 0.82,
        aiReason: 'LOCAL_UPDATE_MARKER',
      }
    }
    if (content.includes('冲突标记') && markerKnowledge) {
      return {
        relation: 'CONFLICT',
        existingKnowledgeId: markerKnowledge.id,
        confidence: 0.72,
        aiReason: 'LOCAL_CONFLICT_MARKER',
      }
    }

    return {
      relation: 'NEW',
      confidence: 0.94,
      aiReason: 'LOCAL_NO_ACTIVE_MATCH',
    }
  }

  private overlapScore(left: string, right: string) {
    const leftTokens = tokenSet(left)
    const rightTokens = tokenSet(right)
    let score = 0
    for (const token of leftTokens) if (rightTokens.has(token)) score += 1
    return score
  }
}
