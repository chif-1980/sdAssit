import { createHash } from 'node:crypto'

import type { PlatformRepository } from './ports.js'
import { DeterministicAi, parseTextSections, summarizeSections } from '../adapters/deterministicAi.js'
import { LocalRetrieval, normalizeKnowledgeText } from '../adapters/localRetrieval.js'
import { compareCandidateAcrossDocuments, deriveApplicability } from './crossDocumentService.js'
import { createBusinessId } from '../../shared/domain/ids.js'
import type {
  Asset,
  AssetSection,
  Candidate,
  PlatformSnapshot,
  Review,
} from '../../shared/domain/models.js'
import type { AssetType, BusinessType, Relation, ReviewType } from '../../shared/domain/enums.js'

export interface CreateAssetInput {
  title: string
  assetType: AssetType
  businessType: BusinessType
  ownerId: string
  content: string
  mimeType: string
  isSessionAsset: boolean
}

export interface AssetDetail {
  asset: Asset
  candidates: Candidate[]
  reviews: Review[]
}

export interface PromoteAssetInput {
  businessType: Exclude<BusinessType, 'SESSION_UPLOAD'>
  ownerId: string
}

function now() {
  return new Date().toISOString()
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function unsupportedBinary() {
  return new Error('UNSUPPORTED_BINARY_FORMAT')
}

function assertAssetActor(snapshot: PlatformSnapshot, asset: Asset) {
  if (snapshot.session.role === 'ADMIN') return
  if (asset.ownerId !== snapshot.session.userId) throw new Error('FORBIDDEN')
  if (snapshot.session.role === 'EMPLOYEE' && !asset.isSessionAsset) throw new Error('FORBIDDEN')
}

function parseInput(content: string, mimeType: string, title: string) {
  // JSON has already decoded the request to a JS string. A NUL or replacement
  // character is still a reliable signal that the source was binary/invalid.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|\uFFFD/u.test(content)) throw unsupportedBinary()

  const mime = mimeType.split(';', 1)[0].trim().toLocaleLowerCase()
  const extensionLooksText = /\.(?:md|markdown|txt)$/iu.test(title)
  const genericMime = ['application/octet-stream', 'binary/octet-stream', 'application/unknown', 'unknown/unknown']
  const supportedMime = ['text/plain', 'text/markdown'].includes(mime)
  if (!supportedMime && !(extensionLooksText && genericMime.includes(mime))) throw unsupportedBinary()
  return content
}

export class AssetService {
  private readonly extractor: DeterministicAi
  private readonly retrieval: LocalRetrieval

  constructor(
    private readonly repository: PlatformRepository,
    extractor = new DeterministicAi(),
    retrieval = new LocalRetrieval(),
  ) {
    this.extractor = extractor
    this.retrieval = retrieval
  }

  async create(input: CreateAssetInput) {
    return this.repository.transact((draft) => {
      const owner = draft.users.find((user) => user.id === input.ownerId)
      if (!owner) throw new Error('OWNER_NOT_FOUND')
      if (input.isSessionAsset) {
        if (input.ownerId !== draft.session.userId) throw new Error('FORBIDDEN')
      } else {
        if (draft.session.role === 'EMPLOYEE') throw new Error('FORBIDDEN')
        if (draft.session.role === 'OWNER' && input.ownerId !== draft.session.userId) throw new Error('FORBIDDEN')
        if (owner.role === 'EMPLOYEE') throw new Error('INVALID_REQUEST')
      }

      const timestamp = now()
      const id = createBusinessId('asset')
      const sessionAsset = input.isSessionAsset
      const asset: Asset = {
        id,
        title: input.title,
        assetType: input.assetType,
        businessType: sessionAsset ? 'SESSION_UPLOAD' : input.businessType,
        provider: 'LOCAL',
        externalId: `local-asset:${id}`,
        ownerId: input.ownerId,
        authority: sessionAsset ? 'L0' : 'L1',
        processStatus: 'NEW',
        createdAt: timestamp,
        updatedAt: timestamp,
        isSessionAsset: sessionAsset,
        ...(sessionAsset ? { expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() } : {}),
        sections: [],
      }
      draft.assets.push(asset)
      draft.assetInputs[id] = { content: input.content, mimeType: input.mimeType }
      return structuredClone(asset)
    })
  }

  async list() {
    const snapshot = await this.repository.read()
    const visibleAssets = snapshot.session.role === 'ADMIN'
      ? snapshot.assets
      : snapshot.assets.filter((asset) => asset.ownerId === snapshot.session.userId
        && (snapshot.session.role !== 'EMPLOYEE' || asset.isSessionAsset))
    return visibleAssets.map((asset) => {
      const currentCandidates = visibleCandidatesForAsset(snapshot, asset)
      const currentCandidateIds = new Set(currentCandidates.map((candidate) => candidate.id))
      const {
        contentHash: _contentHash,
        sections: _sections,
        summary: _summary,
        ...safeAsset
      } = asset
      return {
        ...safeAsset,
        candidateCount: currentCandidates.length,
        reviewCount: snapshot.reviews.filter((review) => review.candidateId !== undefined
          && currentCandidateIds.has(review.candidateId)).length,
      }
    })
  }

  async detail(id: string): Promise<AssetDetail> {
    const snapshot = await this.repository.read()
    const asset = snapshot.assets.find((item) => item.id === id)
    if (!asset) throw new Error('ASSET_NOT_FOUND')
    assertAssetActor(snapshot, asset)
    return detailFromSnapshot(snapshot, id)
  }

  async process(id: string): Promise<AssetDetail> {
    return this.processAsset(id, false)
  }

  private async processAsset(id: string, bypassAccess: boolean): Promise<AssetDetail> {
    const before = await this.repository.read()
    const beforeAsset = before.assets.find((asset) => asset.id === id)
    if (!beforeAsset) throw new Error('ASSET_NOT_FOUND')
    if (!bypassAccess) assertAssetActor(before, beforeAsset)

    try {
      await this.repository.transact((draft) => {
        const asset = draft.assets.find((item) => item.id === id)
        if (!asset) throw new Error('ASSET_NOT_FOUND')
        const input = draft.assetInputs[id]
        if (!input) throw new Error('ASSET_INPUT_NOT_FOUND')

        const timestamp = now()
        const previousStatus = asset.processStatus
        const previousUpdatedAt = asset.updatedAt
        const previousContentHash = asset.contentHash
        asset.processStatus = 'PROCESSING'
        asset.updatedAt = timestamp

        const contentHash = sha256(input.content)
        if (previousStatus === 'PROCESSED' && previousContentHash === contentHash) {
          asset.processStatus = previousStatus
          asset.updatedAt = previousUpdatedAt
          return
        }

        const content = parseInput(input.content, input.mimeType, asset.title)
        const sections = parseTextSections(content)
        const extracted = asset.isSessionAsset ? [] : this.extractor.extract(sections)
        if (!draft.crossDocumentRelations) draft.crossDocumentRelations = []
        retireStaleDerivatives(draft, asset.id, asset.isSessionAsset ? new Set() : evidenceKeys(sections), timestamp)
        asset.sections = sections
        asset.summary = summarizeSections(sections)
        asset.contentHash = contentHash
        asset.errorMessage = undefined

        for (const extractedCandidate of extracted) {
          // Include the source id so the same fact from two independent assets
          // remains traceable to both sources; reprocessing one source stays
          // idempotent because its hash is stable.
          const candidateHash = sha256(`${asset.id}:${normalizeKnowledgeText(extractedCandidate.content)}`)
          // Candidate hashes are the idempotency key. This also prevents a
          // reprocess from creating a second Review for the same evidence.
          if (draft.candidates.some((candidate) => candidate.sourceAssetId === asset.id
            && candidate.candidateHash === candidateHash
            && candidate.sourceLocator === extractedCandidate.sourceLocator
            && candidate.sourceExcerpt === extractedCandidate.sourceExcerpt
            && !hasCancelledReview(draft, candidate.id))) continue

          const applicability = deriveApplicability(extractedCandidate.content, asset.title)
          const match = this.retrieval.findMatch(extractedCandidate.content, draft.knowledge, applicability)
          const candidateId = createBusinessId('candidate')
          const candidateTimestamp = now()
          const autoRejected = match.relation === 'DUPLICATE' && match.confidence >= 0.9
          const candidate: Candidate = {
            id: candidateId,
            title: extractedCandidate.title,
            content: extractedCandidate.content,
            knowledgeType: extractedCandidate.knowledgeType,
            sourceAssetId: asset.id,
            sourceLocator: extractedCandidate.sourceLocator,
            sourceExcerpt: extractedCandidate.sourceExcerpt,
            authority: asset.authority,
            confidence: match.confidence,
            relation: match.relation,
            ...(match.existingKnowledgeId ? { existingKnowledgeId: match.existingKnowledgeId } : {}),
            aiReason: match.aiReason,
            status: autoRejected ? 'REJECTED' : 'PENDING',
            reviewRequired: !autoRejected,
            candidateHash,
            applicability,
            createdAt: candidateTimestamp,
            ...(autoRejected ? { reviewedAt: candidateTimestamp } : {}),
          }
          draft.candidates.push(candidate)

          const comparisons = compareCandidateAcrossDocuments(draft, {
            asset,
            candidate,
            candidateScope: applicability,
          })
          for (const relation of comparisons) {
            if (!draft.crossDocumentRelations.some((item) => item.relationKey === relation.relationKey)) {
              draft.crossDocumentRelations.push(relation)
            }
          }
          candidate.comparisonRelationIds = comparisons.map((relation) => relation.id)

          if (autoRejected && match.existingKnowledgeId) {
            const existingKnowledge = draft.knowledge.find((knowledge) => knowledge.id === match.existingKnowledgeId)
            if (existingKnowledge) {
              existingKnowledge.aliasAssetIds = [...new Set([...(existingKnowledge.aliasAssetIds ?? []), asset.id])]
            }
          }

          if (!autoRejected) {
            const comparisonTypes = new Set(comparisons.map((relation) => relation.relationType))
            const reviewType = comparisonTypes.has('CONFLICT') ? 'CONFLICT' : reviewTypeFor(match.relation)
            const existing = match.existingKnowledgeId
              ? draft.knowledge.find((knowledge) => knowledge.id === match.existingKnowledgeId)
              : undefined
            const problemTags = [
              ...(match.relation === 'DUPLICATE' ? ['DUPLICATE' as const] : []),
              ...(comparisonTypes.has('OVERLAP') ? ['OVERLAP' as const] : []),
              ...(comparisonTypes.has('CONFLICT') ? ['CONFLICT' as const] : []),
              ...(comparisonTypes.has('INSUFFICIENT') ? ['INSUFFICIENT_EVIDENCE' as const] : []),
              ...(Object.keys(applicability).length <= 1 ? ['MISSING_SCOPE' as const] : []),
            ]
            draft.reviews.push({
              id: createBusinessId('review'),
              title: candidate.title,
              triggerType: 'CANDIDATE',
              reviewType,
              candidateId,
              ...(existing ? {
                targetKnowledgeId: existing.id,
                currentSnapshot: existing.content,
              } : {}),
              risk: reviewType === 'CONFLICT' ? 'HIGH' : reviewType === 'UPDATE' ? 'MEDIUM' : 'LOW',
              proposedContent: candidate.content,
              aiSuggestion: candidate.aiReason,
              ...(problemTags.length ? { problemTags } : {}),
              applicability,
              ...(comparisons.length ? { comparisonRelationIds: comparisons.map((relation) => relation.id) } : {}),
              reviewerId: asset.ownerId,
              status: 'PENDING',
              createdAt: candidateTimestamp,
            })
          }
        }

        asset.processStatus = 'PROCESSED'
        asset.processedAt = timestamp
        asset.updatedAt = now()
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'INTERNAL_ERROR'
      await this.repository.transact((draft) => {
        const asset = draft.assets.find((item) => item.id === id)
        if (!asset) return
        const input = draft.assetInputs[id]
        const failedContentHash = input ? sha256(input.content) : undefined
        const timestamp = now()
        if (failedContentHash !== undefined && failedContentHash !== asset.contentHash) {
          retireStaleDerivatives(draft, asset.id, new Set(), timestamp)
          asset.contentHash = failedContentHash
          asset.sections = []
          asset.summary = undefined
          asset.processedAt = undefined
        }
        asset.processStatus = 'FAILED'
        asset.errorMessage = errorMessage
        asset.updatedAt = timestamp
      })
    }

    if (!bypassAccess) return this.detail(id)
    return detailFromSnapshot(await this.repository.read(), id)
  }

  async promote(id: string, input: PromoteAssetInput): Promise<AssetDetail> {
    await this.repository.transact((draft) => {
      const asset = draft.assets.find((item) => item.id === id)
      if (!asset) throw new Error('ASSET_NOT_FOUND')
      if (asset.ownerId !== draft.session.userId && draft.session.role !== 'ADMIN') throw new Error('FORBIDDEN')
      if (!asset.isSessionAsset) throw new Error('ASSET_ALREADY_PROMOTED')
      if (asset.processStatus !== 'PROCESSED') throw new Error('ASSET_NOT_PROCESSED')
      const owner = draft.users.find((user) => user.id === input.ownerId)
      if (!owner) throw new Error('OWNER_NOT_FOUND')
      if (owner.role === 'EMPLOYEE') throw new Error('INVALID_REQUEST')

      asset.isSessionAsset = false
      asset.businessType = input.businessType
      asset.ownerId = input.ownerId
      asset.authority = 'L1'
      asset.expiresAt = undefined
      asset.processStatus = 'NEW'
      asset.processedAt = undefined
      asset.contentHash = undefined
      asset.errorMessage = undefined
      asset.updatedAt = now()
      for (const conversation of draft.conversations) {
        conversation.sessionAssetIds = conversation.sessionAssetIds.filter((assetId) => assetId !== asset.id)
      }
    })

    return this.processAsset(id, true)
  }
}

function reviewTypeFor(relation: Relation): ReviewType {
  // A low-confidence DUPLICATE is routed to CONFLICT: it may be the same fact,
  // but uncertainty means a reviewer must decide whether to keep or replace it.
  if (relation === 'DUPLICATE') return 'CONFLICT'
  if (relation === 'UPDATE') return 'UPDATE'
  if (relation === 'CONFLICT') return 'CONFLICT'
  return 'NEW'
}

function detailFromSnapshot(snapshot: PlatformSnapshot, id: string): AssetDetail {
  const asset = snapshot.assets.find((item) => item.id === id)
  if (!asset) throw new Error('ASSET_NOT_FOUND')
  const candidates = visibleCandidatesForAsset(snapshot, asset)
  const candidateIds = new Set(candidates.map((candidate) => candidate.id))
  const reviews = snapshot.reviews.filter((review) => review.candidateId !== undefined && candidateIds.has(review.candidateId))
  return { asset, candidates, reviews }
}

function visibleCandidatesForAsset(snapshot: PlatformSnapshot, asset: Asset) {
  const currentEvidence = evidenceKeys(asset.sections)
  return snapshot.candidates.filter((candidate) => candidate.sourceAssetId === asset.id
    && currentEvidence.has(evidenceKey(candidate.sourceLocator, candidate.sourceExcerpt))
    && !hasCancelledReview(snapshot, candidate.id))
}

function hasCancelledReview(snapshot: PlatformSnapshot, candidateId: string) {
  return snapshot.reviews.some((review) => review.candidateId === candidateId && review.status === 'CANCELLED')
}

function evidenceKey(locator: string, excerpt: string) {
  return `${locator}\u0000${excerpt}`
}

function evidenceKeys(sections: AssetSection[]) {
  return new Set(sections.map((section) => evidenceKey(section.locator, section.excerpt)))
}

function retireStaleDerivatives(
  draft: PlatformSnapshot,
  assetId: string,
  currentEvidence: Set<string>,
  timestamp: string,
) {
  const staleCandidateIds = new Set<string>()
  for (const candidate of draft.candidates) {
    if (candidate.sourceAssetId !== assetId) continue
    if (currentEvidence.has(evidenceKey(candidate.sourceLocator, candidate.sourceExcerpt))) continue

    staleCandidateIds.add(candidate.id)
    if (candidate.status === 'PENDING') {
      candidate.status = 'REJECTED'
      candidate.reviewRequired = false
      candidate.reviewedAt = timestamp
    }
  }

  for (const review of draft.reviews) {
    if (review.candidateId && staleCandidateIds.has(review.candidateId) && review.status === 'PENDING') {
      review.status = 'CANCELLED'
    }
  }
}
