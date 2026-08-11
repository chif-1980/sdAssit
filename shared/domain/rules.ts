import type {
  Authority,
  IndexStatus,
  KnowledgeStatus,
  ResolutionAction,
  ReviewType,
} from './enums.js'

const authorityRank: Record<Authority, number> = { L0: 0, L1: 1, L2: 2, L3: 3 }

const reviewActionMatrix: Record<ReviewType, readonly ResolutionAction[]> = {
  NEW: ['CREATE_KNOWLEDGE', 'REJECT_CANDIDATE'],
  UPDATE: ['UPDATE_KNOWLEDGE', 'KEEP_CURRENT', 'REJECT_CANDIDATE'],
  CONFLICT: ['CREATE_KNOWLEDGE', 'UPDATE_KNOWLEDGE', 'KEEP_CURRENT', 'REJECT_CANDIDATE'],
  STALE: ['UPDATE_KNOWLEDGE', 'CONFIRM_VALID', 'ARCHIVE_KNOWLEDGE'],
}

export function allowedReviewActions(type: ReviewType): ResolutionAction[] {
  return [...reviewActionMatrix[type]]
}

export function canAnswerWithKnowledge(value: {
  status: KnowledgeStatus
  aiEnabled: boolean
  indexStatus: IndexStatus
}) {
  return value.status === 'ACTIVE' && value.aiEnabled && value.indexStatus === 'INDEXED'
}

export function validateKnowledgeAuthority(knowledge: Authority, source: Authority) {
  if (authorityRank[knowledge] > authorityRank[source]) {
    throw new Error('KNOWLEDGE_AUTHORITY_EXCEEDS_SOURCE')
  }
}

export function assertReviewAction(type: ReviewType, action: ResolutionAction) {
  if (!reviewActionMatrix[type].includes(action)) {
    throw new Error('REVIEW_ACTION_NOT_ALLOWED')
  }
}
