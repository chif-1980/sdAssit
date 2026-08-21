import { createBusinessId } from '../../shared/domain/ids.js'
import type { Candidate, Knowledge, KnowledgeVersion, PlatformSnapshot, Review } from '../../shared/domain/models.js'
import type {
  Authority,
  KnowledgeStatus,
  KnowledgeType,
  ProblemTag,
  ReviewDecision,
  ResolutionAction,
  ReviewStatus,
  ReviewType,
  Risk,
} from '../../shared/domain/enums.js'
import { comparisonForReview } from './crossDocumentService.js'
import { allowedReviewActions, assertApplicabilityScope, assertReviewAction, validateKnowledgeAuthority } from '../../shared/domain/rules.js'
import type { KnowledgeIndexer, PlatformRepository } from './ports.js'

export interface ResolveReviewInput {
  action: ResolutionAction
  finalContent?: string
  decisionComment: string
  decision?: ReviewDecision
  problemTags?: ProblemTag[]
  applicability?: Candidate['applicability']
  assigneeId?: string
}

export interface ReviewListQuery {
  q?: string
  status?: ReviewStatus | 'OPEN'
  reviewType?: ReviewType
  risk?: Risk
  problemTag?: ProblemTag
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
  return review.status === 'PENDING' || review.status === 'CHANGES_REQUESTED'
    ? allowedReviewActions(review.reviewType).filter((action) => !['MARK_DUPLICATE', 'SPLIT_BY_SCOPE', 'MARK_INSUFFICIENT'].includes(action)) : []
}

function problemActionsFor(review: Review) {
  return review.status === 'PENDING' || review.status === 'CHANGES_REQUESTED'
    ? allowedReviewActions(review.reviewType).filter((action) => ['MARK_DUPLICATE', 'SPLIT_BY_SCOPE', 'MARK_INSUFFICIENT'].includes(action)) : []
}

function settleCandidate(candidate: Candidate | undefined, approved: boolean, reviewerId: string, timestamp: string) {
  if (!candidate) return
  candidate.status = approved ? 'APPROVED' : 'REJECTED'
  candidate.reviewRequired = false
  candidate.reviewerId = reviewerId
  candidate.reviewedAt = timestamp
}

function inferDecision(action: ResolutionAction): ReviewDecision | undefined {
  if (action === 'CREATE_KNOWLEDGE' || action === 'UPDATE_KNOWLEDGE' || action === 'CONFIRM_VALID'
    || action === 'MARK_DUPLICATE' || action === 'SPLIT_BY_SCOPE') return 'PUBLISH'
  if (action === 'REJECT_CANDIDATE') return 'REJECT'
  return undefined
}

function defaultActionForDecision(review: Review, decision: ReviewDecision) {
  if (decision === 'REJECT') return 'REJECT_CANDIDATE' as const
  if (decision === 'REQUEST_CHANGES') return 'MARK_INSUFFICIENT' as const
  if (decision === 'PUBLISH') {
    if (review.reviewType === 'NEW') return 'CREATE_KNOWLEDGE' as const
    if (review.reviewType === 'STALE') return 'CONFIRM_VALID' as const
    return 'UPDATE_KNOWLEDGE' as const
  }
  return undefined
}

function recordKnowledgeVersion(
  draft: PlatformSnapshot,
  knowledge: Knowledge,
  review: Review,
  reviewerId: string,
  decisionComment: string,
  timestamp: string,
) {
  if (!draft.knowledgeVersions) draft.knowledgeVersions = []
  const version: KnowledgeVersion = {
    id: `${knowledge.id}:v${knowledge.version}`,
    knowledgeId: knowledge.id,
    version: knowledge.version,
    content: knowledge.content,
    applicability: knowledge.applicability,
    primaryAssetId: knowledge.primaryAssetId,
    supportingAssetIds: [...knowledge.supportingAssetIds],
    aliasAssetIds: [...(knowledge.aliasAssetIds ?? [])],
    sourceLinks: [...(knowledge.sourceLinks ?? [{ assetId: knowledge.primaryAssetId, locator: knowledge.sourceLocator, role: 'PRIMARY' as const }])],
    sourceLocator: knowledge.sourceLocator,
    reviewId: review.id,
    reviewerId,
    decisionComment,
    createdAt: timestamp,
  }
  if (!draft.knowledgeVersions.some((item) => item.id === version.id)) draft.knowledgeVersions.push(version)
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
    const status = query.status ?? 'OPEN'

    return visibleReviews
      .filter((review) => status === 'OPEN'
        ? review.status === 'PENDING' || review.status === 'CHANGES_REQUESTED'
        : review.status === status)
      .filter((review) => query.reviewType === undefined || review.reviewType === query.reviewType)
      .filter((review) => query.risk === undefined || review.risk === query.risk)
      .filter((review) => query.problemTag === undefined || review.problemTags?.includes(query.problemTag))
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
      problemActions: problemActionsFor(review),
      comparisons: comparisonForReview(snapshot, review),
      assignees: snapshot.users.filter((user) => user.role === 'OWNER' || user.role === 'ADMIN'),
    }
  }

  async resolve(id: string, input: ResolveReviewInput) {
    const transition = await this.repository.transact((draft) => {
      const review = draft.reviews.find((item) => item.id === id)
      if (!review) throw new Error('REVIEW_NOT_FOUND')
      assertFactoryActor(draft, review.reviewerId)
      if (review.status !== 'PENDING' && review.status !== 'CHANGES_REQUESTED') throw new Error('REVIEW_ALREADY_RESOLVED')
      const decision = input.decision
      const action = input.action ?? (decision ? defaultActionForDecision(review, decision) : undefined)
      if (!action) throw new Error('INVALID_REQUEST')
      assertReviewAction(review.reviewType, action)
      if (input.applicability) assertApplicabilityScope(input.applicability)

      const candidate = candidateFor(draft, review)
      const target = targetFor(draft, review)
      const timestamp = now()
      const submittedFinalContent = input.finalContent?.trim() || undefined
      let changedKnowledge: Knowledge | undefined

      if (decision === 'TRANSFER') {
        const assigneeId = input.assigneeId?.trim()
        const assignee = assigneeId ? draft.users.find((user) => user.id === assigneeId) : undefined
        if (!assignee || (assignee.role !== 'OWNER' && assignee.role !== 'ADMIN')) throw new Error('ASSIGNEE_NOT_FOUND')
        const from = review.reviewerId
        review.assigneeId = assignee.id
        review.reviewerId = assignee.id
        review.transferHistory = [
          ...(review.transferHistory ?? []),
          { from, to: assignee.id, at: timestamp, comment: input.decisionComment.trim() },
        ]
        review.decision = 'TRANSFER'
        review.decisionComment = input.decisionComment.trim()
        review.status = 'PENDING'
        review.problemTags = input.problemTags
        return { candidateId: candidate?.id, knowledgeId: target?.id, shouldIndex: false }
      }

      review.problemTags = input.problemTags
      if (input.applicability) {
        review.applicability = input.applicability
        if (candidate) candidate.applicability = input.applicability
      }

      if (decision === 'REQUEST_CHANGES') {
        if (!input.decisionComment.trim()) throw new Error('DECISION_COMMENT_REQUIRED')
        if (candidate) {
          candidate.status = 'NEEDS_CHANGES'
          candidate.reviewRequired = true
          candidate.reviewerId = draft.session.userId
        }
        review.status = 'CHANGES_REQUESTED'
        review.decision = 'REQUEST_CHANGES'
        review.resolutionAction = 'MARK_INSUFFICIENT'
        review.requestedChanges = input.decisionComment.trim()
        review.decisionComment = input.decisionComment.trim()
        review.finalContent = submittedFinalContent
        review.resolvedAt = undefined
        return { candidateId: candidate?.id, knowledgeId: target?.id, shouldIndex: false }
      }

      switch (action) {
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
            applicability: input.applicability ?? candidate.applicability,
            logicalFactKey: `${candidate.knowledgeType}:${candidate.title}`.toLocaleLowerCase(),
            sourceLinks: [{ assetId: sourceAsset.id, locator: candidate.sourceLocator, role: 'PRIMARY' }],
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
          if (input.applicability) target.applicability = input.applicability
          target.sourceLinks = [
            ...(target.sourceLinks ?? [{ assetId: target.primaryAssetId, locator: target.sourceLocator, role: 'PRIMARY' as const }]),
            ...(candidate ? [{ assetId: candidate.sourceAssetId, locator: candidate.sourceLocator, role: 'SUPPORTING' as const }] : []),
          ].filter((link, index, links) => links.findIndex((item) => item.assetId === link.assetId && item.role === link.role) === index)
          changedKnowledge = target
          settleCandidate(candidate, true, draft.session.userId, timestamp)
          break
        }
        case 'KEEP_CURRENT':
        case 'REJECT_CANDIDATE':
          settleCandidate(candidate, false, draft.session.userId, timestamp)
          break
        case 'MARK_DUPLICATE': {
          if (!candidate || !target) throw new Error('KNOWLEDGE_NOT_FOUND')
          const source = sourceAssetFor(draft, candidate)
          target.aliasAssetIds = [...new Set([...(target.aliasAssetIds ?? []), source.id])]
          target.sourceLinks = [
            ...(target.sourceLinks ?? [{ assetId: target.primaryAssetId, locator: target.sourceLocator, role: 'PRIMARY' as const }]),
            { assetId: source.id, locator: candidate.sourceLocator, role: 'ALIAS' as const },
          ].filter((link, index, links) => links.findIndex((item) => item.assetId === link.assetId && item.role === link.role) === index)
          candidate.status = 'REJECTED'
          candidate.reviewRequired = false
          candidate.reviewerId = draft.session.userId
          candidate.reviewedAt = timestamp
          changedKnowledge = target
          break
        }
        case 'SPLIT_BY_SCOPE': {
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
            applicability: input.applicability ?? candidate.applicability,
            logicalFactKey: target?.logicalFactKey ?? `${candidate.knowledgeType}:${candidate.title}`.toLocaleLowerCase(),
            sourceLinks: [{ assetId: sourceAsset.id, locator: candidate.sourceLocator, role: 'PRIMARY' }],
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
        case 'MARK_INSUFFICIENT':
          if (candidate) {
            candidate.status = 'REJECTED'
            candidate.reviewRequired = false
            candidate.reviewerId = draft.session.userId
            candidate.reviewedAt = timestamp
          }
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
      review.decision = decision ?? inferDecision(action)
      review.resolutionAction = action
      review.finalContent = submittedFinalContent
      review.decisionComment = input.decisionComment.trim()
      review.resolvedAt = timestamp
      if (changedKnowledge && (action === 'CREATE_KNOWLEDGE' || action === 'UPDATE_KNOWLEDGE' || action === 'SPLIT_BY_SCOPE')) {
        recordKnowledgeVersion(draft, changedKnowledge, review, draft.session.userId, review.decisionComment, timestamp)
      }
      for (const relation of draft.crossDocumentRelations ?? []) {
        if (!review.comparisonRelationIds?.includes(relation.id)) continue
        relation.status = 'RESOLVED'
        relation.reviewerId = draft.session.userId
        relation.resolutionAction = action
        relation.updatedAt = timestamp
      }
      return {
        candidateId: candidate?.id,
        knowledgeId: changedKnowledge?.id ?? target?.id,
        shouldIndex: action === 'CREATE_KNOWLEDGE' || action === 'UPDATE_KNOWLEDGE' || action === 'SPLIT_BY_SCOPE',
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
    const aliasAssets = (item.aliasAssetIds ?? []).flatMap((assetId) => {
      const asset = snapshot.assets.find((candidate) => candidate.id === assetId)
      return asset ? [asset] : []
    })
    const candidateById = new Map(snapshot.candidates.map((candidate) => [candidate.id, candidate]))
    const history = snapshot.reviews
      .filter((review) => review.targetKnowledgeId === id
        || (review.candidateId !== undefined
          && candidateById.get(review.candidateId)?.existingKnowledgeId === id))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const relations = (snapshot.crossDocumentRelations ?? []).filter((relation) =>
      relation.leftAssetId === item.primaryAssetId
      || relation.rightAssetId === item.primaryAssetId
      || item.supportingAssetIds.includes(relation.leftAssetId)
      || item.supportingAssetIds.includes(relation.rightAssetId)
      || item.aliasAssetIds?.includes(relation.leftAssetId)
      || item.aliasAssetIds?.includes(relation.rightAssetId))
    const versions = (snapshot.knowledgeVersions ?? []).filter((version) => version.knowledgeId === id)
    if (!versions.length) {
      versions.push({
        id: `${item.id}:v${item.version}`,
        knowledgeId: item.id,
        version: item.version,
        content: item.content,
        applicability: item.applicability,
        primaryAssetId: item.primaryAssetId,
        supportingAssetIds: [...item.supportingAssetIds],
        aliasAssetIds: [...(item.aliasAssetIds ?? [])],
        sourceLinks: [...(item.sourceLinks ?? [{ assetId: item.primaryAssetId, locator: item.sourceLocator, role: 'PRIMARY' as const }])],
        sourceLocator: item.sourceLocator,
        reviewId: history[0]?.id ?? 'LEGACY',
        reviewerId: history[0]?.reviewerId ?? item.ownerId,
        decisionComment: history[0]?.decisionComment ?? '历史正式版本',
        createdAt: item.updatedAt,
      })
    }
    return { knowledge: item, primaryAsset, supportingAssets, aliasAssets, relations, versions, history }
  }

  async knowledgeRelations(id: string) {
    const detail = await this.knowledgeDetail(id)
    return detail.relations
  }

  async knowledgeVersions(id: string) {
    const detail = await this.knowledgeDetail(id)
    return detail.versions
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
