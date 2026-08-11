import { describe, expect, it } from 'vitest'

import {
  allowedReviewActions,
  assertReviewAction,
  canAnswerWithKnowledge,
  validateKnowledgeAuthority,
} from './rules.js'

describe('knowledge rules', () => {
  it('only allows active indexed knowledge with AI enabled into answers', () => {
    expect(canAnswerWithKnowledge({ status: 'ACTIVE', aiEnabled: true, indexStatus: 'INDEXED' })).toBe(true)
    expect(canAnswerWithKnowledge({ status: 'ACTIVE', aiEnabled: true, indexStatus: 'PENDING' })).toBe(false)
    expect(canAnswerWithKnowledge({ status: 'STALE', aiEnabled: true, indexStatus: 'INDEXED' })).toBe(false)
    expect(canAnswerWithKnowledge({ status: 'ACTIVE', aiEnabled: false, indexStatus: 'INDEXED' })).toBe(false)
  })

  it('prevents knowledge authority from exceeding its primary source', () => {
    expect(() => validateKnowledgeAuthority('L3', 'L1')).toThrow('KNOWLEDGE_AUTHORITY_EXCEEDS_SOURCE')
    expect(() => validateKnowledgeAuthority('L2', 'L2')).not.toThrow()
    expect(() => validateKnowledgeAuthority('L1', 'L3')).not.toThrow()
  })

  it('allows conflict review to create a separate knowledge item', () => {
    expect(allowedReviewActions('CONFLICT')).toContain('CREATE_KNOWLEDGE')
    expect(allowedReviewActions('NEW')).not.toContain('ARCHIVE_KNOWLEDGE')
  })

  it('rejects resolution actions outside the review matrix', () => {
    expect(() => assertReviewAction('NEW', 'ARCHIVE_KNOWLEDGE')).toThrow('REVIEW_ACTION_NOT_ALLOWED')
    expect(() => assertReviewAction('STALE', 'CONFIRM_VALID')).not.toThrow()
  })
})
