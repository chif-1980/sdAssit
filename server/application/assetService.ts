import { createHash } from 'node:crypto'

import type { PlatformRepository } from './ports.js'
import { DeterministicAi, parseTextSections, summarizeSections } from '../adapters/deterministicAi.js'
import { LocalRetrieval, normalizeKnowledgeText } from '../adapters/localRetrieval.js'
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

function now() {
  return new Date().toISOString()
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function unsupportedBinary() {
  return new Error('UNSUPPORTED_BINARY_FORMAT')
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
      if (!draft.users.some((user) => user.id === input.ownerId)) throw new Error('OWNER_NOT_FOUND')

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
    return snapshot.assets.map((asset) => {
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
    return detailFromSnapshot(snapshot, id)
  }

  async process(id: string): Promise<AssetDetail> {
    const before = await this.repository.read()
    if (!before.assets.some((asset) => asset.id === id)) throw new Error('ASSET_NOT_FOUND')

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
        const extracted = this.extractor.extract(sections)
        retireStaleDerivatives(draft, asset.id, evidenceKeys(sections), timestamp)
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

          const match = this.retrieval.findMatch(extractedCandidate.content, draft.knowledge)
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
            createdAt: candidateTimestamp,
            ...(autoRejected ? { reviewedAt: candidateTimestamp } : {}),
          }
          draft.candidates.push(candidate)

          if (!autoRejected) {
            const reviewType = reviewTypeFor(match.relation)
            const existing = match.existingKnowledgeId
              ? draft.knowledge.find((knowledge) => knowledge.id === match.existingKnowledgeId)
              : undefined
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

    return this.detail(id)
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
