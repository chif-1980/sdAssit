import { createBusinessId } from '../../shared/domain/ids.js'
import type { Candidate, Knowledge, PlatformSnapshot, Review } from '../../shared/domain/models.js'
import type {
  Authority,
  KnowledgeStatus,
  KnowledgeType,
  ResolutionAction,
  ReviewStatus,
  ReviewType,
  Risk,
} from '../../shared/domain/enums.js'
import { allowedReviewActions, assertReviewAction, validateKnowledgeAuthority } from '../../shared/domain/rules.js'
import type { KnowledgeIndexer, PlatformRepository } from './ports.js'

export interface ResolveReviewInput {
  action: ResolutionAction
  finalContent?: string
  decisionComment: string
}

export interface ReviewListQuery {
  q?: string
  status?: ReviewStatus
  reviewType?: ReviewType
  risk?: Risk
}

export interface KnowledgeListQuery {
  q?: string
  category?: KnowledgeType
  status?: KnowledgeStatus
  authority?: Authority
  ownerId?: string
  updatedFrom?: string
  updatedTo?: string
}

const riskRank: Record<Risk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 }

function now() {
  return new Date().toISOString()
}

function assertFactoryActor(snapshot: PlatformSnapshot, ownerId?: string) {
  if (snapshot.session.role === 'ADMIN') return
  if (snapshot.session.role === 'OWNER' && (!ownerId || snapshot.session.userId === ownerId)) return
  throw new Error('FORBIDDEN')
}

function requireFinalContent(input: ResolveReviewInput) {
  const value = input.finalContent?.trim()
  if (!value) throw new Error('FINAL_CONTENT_REQUIRED')
  return value
}

function candidateFor(snapshot: PlatformSnapshot, review: Review) {
  if (!review.candidateId) return undefined
  const candidate = snapshot.candidates.find((item) => item.id === review.candidateId)
  if (!candidate) throw new Error('CANDIDATE_NOT_FOUND')
  return candidate
}

function targetFor(snapshot: PlatformSnapshot, review: Review) {
  if (!review.targetKnowledgeId) return undefined
  const target = snapshot.knowledge.find((item) => item.id === review.targetKnowledgeId)
  if (!target) throw new Error('KNOWLEDGE_NOT_FOUND')
  return target
}

function sourceAssetFor(snapshot: PlatformSnapshot, candidate: Candidate) {
  const asset = snapshot.assets.find((item) => item.id === candidate.sourceAssetId)
  if (!asset) throw new Error('ASSET_NOT_FOUND')
  validateKnowledgeAuthority(candidate.authority, asset.authority)
  return asset
}

function sourceAssetDetail(snapshot: PlatformSnapshot, candidate: Candidate | undefined) {
  if (!candidate) return undefined
  const asset = snapshot.assets.find((item) => item.id === candidate.sourceAssetId)
  if (!asset) throw new Error('ASSET_NOT_FOUND')
  return asset
}

function compareReviews(left: Review, right: Review) {
  const riskDifference = riskRank[right.risk] - riskRank[left.risk]
  if (riskDifference !== 0) return riskDifference

  const leftDueAt = left.dueAt ?? '9999-12-31T23:59:59.999Z'
  const rightDueAt = right.dueAt ?? '9999-12-31T23:59:59.999Z'
  const dueDateDifference = leftDueAt.localeCompare(rightDueAt)
  if (dueDateDifference !== 0) return dueDateDifference

  const createdDateDifference = right.createdAt.localeCompare(left.createdAt)
  return createdDateDifference !== 0 ? createdDateDifference : left.id.localeCompare(right.id)
}

function includesText(values: Array<string | undefined>, query: string) {
  return values.some((value) => value?.toLocaleLowerCase().includes(query))
}

function actionsFor(review: Review) {
  return review.status === 'PENDING' ? allowedReviewActions(review.reviewType) : []
}

function settleCandidate(candidate: Candidate | undefined, approved: boolean, reviewerId: string, timestamp: string) {
  if (!candidate) return
  candidate.status = approved ? 'APPROVED' : 'REJECTED'
  candidate.reviewRequired = false
  candidate.reviewerId = reviewerId
  candidate.reviewedAt = timestamp
}

export class ReviewService {
  constructor(
    private readonly repository: PlatformRepository,
    private readonly indexer: KnowledgeIndexer,
  ) {}

  async listReviews(query: ReviewListQuery = {}) {
    const snapshot = await this.repository.read()
    assertFactoryActor(snapshot)
    const visibleReviews = snapshot.session.role === 'ADMIN'
      ? snapshot.reviews
      : snapshot.reviews.filter((review) => review.reviewerId === snapshot.session.userId)
    const normalizedQuery = query.q?.trim().toLocaleLowerCase()
    const status = query.status ?? 'PENDING'

    return visibleReviews
      .filter((review) => review.status === status)
      .filter((review) => query.reviewType === undefined || review.reviewType === query.reviewType)
      .filter((review) => query.risk === undefined || review.risk === query.risk)
      .filter((review) => !normalizedQuery || includesText([
        review.title,
        review.currentSnapshot,
        review.proposedContent,
        review.aiSuggestion,
      ], normalizedQuery))
      .sort(compareReviews)
      .map((review) => ({ ...review, allowedActions: actionsFor(review) }))
  }

  async reviewDetail(id: string) {
    const snapshot = await this.repository.read()
    const review = snapshot.reviews.find((item) => item.id === id)
    if (!review) throw new Error('REVIEW_NOT_FOUND')
    assertFactoryActor(snapshot, review.reviewerId)
    const candidate = candidateFor(snapshot, review)
    return {
      review,
      candidate,
      knowledge: targetFor(snapshot, review),
      sourceAsset: sourceAssetDetail(snapshot, candidate),
      allowedActions: actionsFor(review),
    }
  }

  async resolve(id: string, input: ResolveReviewInput) {
    const transition = await this.repository.transact((draft) => {
      const review = draft.reviews.find((item) => item.id === id)
      if (!review) throw new Error('REVIEW_NOT_FOUND')
      assertFactoryActor(draft, review.reviewerId)
      if (review.status !== 'PENDING') throw new Error('REVIEW_ALREADY_RESOLVED')
      assertReviewAction(review.reviewType, input.action)

      const candidate = candidateFor(draft, review)
      const target = targetFor(draft, review)
      const timestamp = now()
      const submittedFinalContent = input.finalContent?.trim() || undefined
      let changedKnowledge: Knowledge | undefined

      switch (input.action) {
        case 'CREATE_KNOWLEDGE': {
          if (!candidate) throw new Error('CANDIDATE_NOT_FOUND')
          const sourceAsset = sourceAssetFor(draft, candidate)
          const content = requireFinalContent(input)
          changedKnowledge = {
            id: createBusinessId('knowledge'),
            title: candidate.title,
            content,
            category: candidate.knowledgeType,
            tags: [],
            authority: candidate.authority,
            ownerId: sourceAsset.ownerId,
            primaryAssetId: sourceAsset.id,
            supportingAssetIds: [],
            sourceLocator: candidate.sourceLocator,
            status: 'ACTIVE',
            version: 1,
            lastVerifiedAt: timestamp,
            aiEnabled: true,
            indexStatus: 'PENDING',
            createdAt: timestamp,
            updatedAt: timestamp,
          }
          draft.knowledge.push(changedKnowledge)
          review.targetKnowledgeId = changedKnowledge.id
          settleCandidate(candidate, true, draft.session.userId, timestamp)
          break
        }
        case 'UPDATE_KNOWLEDGE': {
          if (!target) throw new Error('KNOWLEDGE_NOT_FOUND')
          const primaryAsset = draft.assets.find((asset) => asset.id === target.primaryAssetId)
          if (!primaryAsset) throw new Error('ASSET_NOT_FOUND')
          validateKnowledgeAuthority(target.authority, primaryAsset.authority)
          if (candidate) {
            const sourceAsset = sourceAssetFor(draft, candidate)
            if (sourceAsset.id !== target.primaryAssetId && !target.supportingAssetIds.includes(sourceAsset.id)) {
              target.supportingAssetIds.push(sourceAsset.id)
            }
          }
          target.content = requireFinalContent(input)
          target.version += 1
          target.status = 'ACTIVE'
          target.aiEnabled = true
          target.indexStatus = 'PENDING'
          target.lastVerifiedAt = timestamp
          target.updatedAt = timestamp
          target.staleReason = undefined
          changedKnowledge = target
          settleCandidate(candidate, true, draft.session.userId, timestamp)
          break
        }
        case 'KEEP_CURRENT':
        case 'REJECT_CANDIDATE':
          settleCandidate(candidate, false, draft.session.userId, timestamp)
          break
        case 'ARCHIVE_KNOWLEDGE':
          if (!target) throw new Error('KNOWLEDGE_NOT_FOUND')
          target.status = 'ARCHIVED'
          target.aiEnabled = false
          target.staleReason = input.decisionComment
          target.updatedAt = timestamp
          changedKnowledge = target
          settleCandidate(candidate, false, draft.session.userId, timestamp)
          break
        case 'CONFIRM_VALID':
          if (!target) throw new Error('KNOWLEDGE_NOT_FOUND')
          target.status = 'ACTIVE'
          target.aiEnabled = true
          target.staleReason = undefined
          target.lastVerifiedAt = timestamp
          target.updatedAt = timestamp
          changedKnowledge = target
          settleCandidate(candidate, false, draft.session.userId, timestamp)
          break
      }

      review.status = 'RESOLVED'
      review.resolutionAction = input.action
      review.finalContent = submittedFinalContent
      review.decisionComment = input.decisionComment.trim()
      review.resolvedAt = timestamp
      return {
        candidateId: candidate?.id,
        knowledgeId: changedKnowledge?.id ?? target?.id,
        shouldIndex: input.action === 'CREATE_KNOWLEDGE' || input.action === 'UPDATE_KNOWLEDGE',
      }
    })

    if (transition.shouldIndex && transition.knowledgeId) await this.indexKnowledge(transition.knowledgeId)
    return this.resolutionResult(id, transition.candidateId, transition.knowledgeId)
  }

  async listKnowledge(query: KnowledgeListQuery = {}) {
    const snapshot = await this.repository.read()
    assertFactoryActor(snapshot)
    const visibleKnowledge = snapshot.session.role === 'ADMIN'
      ? snapshot.knowledge
      : snapshot.knowledge.filter((knowledge) => knowledge.ownerId === snapshot.session.userId)
    const normalizedQuery = query.q?.trim().toLocaleLowerCase()

    return visibleKnowledge
      .filter((knowledge) => query.category === undefined || knowledge.category === query.category)
      .filter((knowledge) => query.status === undefined || knowledge.status === query.status)
      .filter((knowledge) => query.authority === undefined || knowledge.authority === query.authority)
      .filter((knowledge) => query.ownerId === undefined || knowledge.ownerId === query.ownerId)
      .filter((knowledge) => query.updatedFrom === undefined || knowledge.updatedAt >= query.updatedFrom)
      .filter((knowledge) => query.updatedTo === undefined || knowledge.updatedAt <= query.updatedTo)
      .filter((knowledge) => !normalizedQuery || includesText([
        knowledge.title,
        knowledge.content,
        ...knowledge.tags,
      ], normalizedQuery))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
  }

  async knowledgeDetail(id: string) {
    const snapshot = await this.repository.read()
    const item = snapshot.knowledge.find((knowledge) => knowledge.id === id)
    if (!item) throw new Error('KNOWLEDGE_NOT_FOUND')
    assertFactoryActor(snapshot, item.ownerId)
    const primaryAsset = snapshot.assets.find((asset) => asset.id === item.primaryAssetId)
    if (!primaryAsset) throw new Error('ASSET_NOT_FOUND')
    const supportingAssets = item.supportingAssetIds.map((assetId) => {
      const asset = snapshot.assets.find((candidate) => candidate.id === assetId)
      if (!asset) throw new Error('ASSET_NOT_FOUND')
      return asset
    })
    const candidateById = new Map(snapshot.candidates.map((candidate) => [candidate.id, candidate]))
    const history = snapshot.reviews
      .filter((review) => review.targetKnowledgeId === id
        || (review.candidateId !== undefined
          && candidateById.get(review.candidateId)?.existingKnowledgeId === id))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    return { knowledge: item, primaryAsset, supportingAssets, history }
  }

  async requestUpdate(
    id: string,
    proposedContent: string | undefined,
    decisionComment: string,
    intent: 'UPDATE' | 'ARCHIVE' = 'UPDATE',
  ) {
    return this.repository.transact((draft) => {
      const target = draft.knowledge.find((item) => item.id === id)
      if (!target) throw new Error('KNOWLEDGE_NOT_FOUND')
      assertFactoryActor(draft, target.ownerId)
      const createdAt = now()
      const created: Review = {
        id: createBusinessId('review'),
        title: intent === 'ARCHIVE' ? `归档复核：${target.title}` : `更新：${target.title}`,
        triggerType: 'LIFECYCLE',
        reviewType: intent === 'ARCHIVE' ? 'STALE' : 'UPDATE',
        targetKnowledgeId: target.id,
        risk: 'MEDIUM',
        currentSnapshot: target.content,
        ...(proposedContent ? { proposedContent } : {}),
        aiSuggestion: decisionComment,
        reviewerId: target.ownerId,
        status: 'PENDING',
        createdAt,
      }
      draft.reviews.push(created)
      return structuredClone(created)
    })
  }

  async reindex(id: string) {
    await this.repository.transact((draft) => {
      const target = draft.knowledge.find((item) => item.id === id)
      if (!target) throw new Error('KNOWLEDGE_NOT_FOUND')
      assertFactoryActor(draft, target.ownerId)
      target.indexStatus = 'PENDING'
      target.updatedAt = now()
    })
    await this.indexKnowledge(id)
    return this.knowledgeDetail(id)
  }

  private async indexKnowledge(id: string) {
    const before = await this.repository.read()
    const knowledge = before.knowledge.find((item) => item.id === id)
    if (!knowledge) throw new Error('KNOWLEDGE_NOT_FOUND')
    try {
      await this.indexer.index(knowledge)
      await this.repository.transact((draft) => {
        const target = draft.knowledge.find((item) => item.id === id)
        if (target && target.version === knowledge.version && target.indexStatus === 'PENDING') {
          target.indexStatus = 'INDEXED'
          target.updatedAt = now()
        }
      })
    } catch {
      await this.repository.transact((draft) => {
        const target = draft.knowledge.find((item) => item.id === id)
        if (target && target.version === knowledge.version && target.indexStatus === 'PENDING') {
          target.indexStatus = 'FAILED'
          target.updatedAt = now()
        }
      })
    }
  }

  private async resolutionResult(reviewId: string, candidateId?: string, knowledgeId?: string) {
    const snapshot = await this.repository.read()
    return {
      review: snapshot.reviews.find((review) => review.id === reviewId),
      candidate: candidateId ? snapshot.candidates.find((candidate) => candidate.id === candidateId) : undefined,
      knowledge: knowledgeId ? snapshot.knowledge.find((knowledge) => knowledge.id === knowledgeId) : undefined,
    }
  }
}
