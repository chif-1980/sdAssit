import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { Knowledge, PlatformSnapshot } from '../../shared/domain/models.js'
import { JsonRepository } from '../adapters/jsonRepository.js'
import { normalizeKnowledgeText } from '../adapters/localRetrieval.js'
import { buildApp } from '../app.js'
import { seedSnapshot } from '../seed.js'

const temporaryDirectories: string[] = []
const openApps: Awaited<ReturnType<typeof buildApp>>[] = []

async function fixture(seed = seedSnapshot()) {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-asset-flow-'))
  temporaryDirectories.push(directory)
  const factorySeed = structuredClone(seed)
  factorySeed.session = { userId: 'USR-OWNER', role: 'OWNER' }
  const repository = new JsonRepository(join(directory, 'snapshot.json'), factorySeed)
  const app = buildApp(repository)
  await app.ready()
  openApps.push(app)
  return { app, repository }
}

async function cleanup() {
  await Promise.all(openApps.splice(0).map((app) => app.close()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
}

afterEach(cleanup)

const validAsset = (content: string, overrides: Record<string, unknown> = {}) => ({
  title: '私有化部署说明',
  assetType: 'DOCUMENT',
  businessType: 'PRODUCT_DOCUMENT',
  ownerId: 'USR-OWNER',
  content,
  mimeType: 'text/plain',
  ...overrides,
})

function activeKnowledge(id: string, title: string, content: string): Knowledge {
  const timestamp = new Date().toISOString()
  return {
    id,
    title,
    content,
    category: 'PRODUCT_CAPABILITY',
    tags: [],
    authority: 'L1',
    ownerId: 'USR-OWNER',
    primaryAssetId: 'AST-SOURCE',
    supportingAssetIds: [],
    sourceLocator: 'source:1',
    status: 'ACTIVE',
    version: 1,
    lastVerifiedAt: timestamp,
    aiEnabled: true,
    indexStatus: 'INDEXED',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

describe('Asset → Candidate flow', () => {
  it.each([
    ['>=', '<='],
    ['>', '<'],
    ['≥', '≤'],
  ])('preserves opposite %s and %s constraint operators during normalization', (left, right) => {
    expect(normalizeKnowledgeText(`平台最低容量 ${left} 10`))
      .not.toBe(normalizeKnowledgeText(`平台最低容量 ${right} 10`))
  })

  it.each([
    ['1.5', '15'],
    ['-10', '10'],
    ['1/2', '12'],
    ['!= 1', '= 1'],
  ])('preserves distinct numeric expressions %s and %s during normalization', (left, right) => {
    expect(normalizeKnowledgeText(`平台最低参数 ${left}。`))
      .not.toBe(normalizeKnowledgeText(`平台最低参数 ${right}。`))
  })

  it('does not auto-reject an opposite constraint as an exact duplicate', async () => {
    const knowledge = activeKnowledge('KNW-CONSTRAINT', '最低容量', '平台最低容量 >= 10。')
    const seed = seedSnapshot()
    seed.knowledge.push(knowledge)
    const { app } = await fixture(seed)
    const created = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: validAsset('平台最低容量 <= 10。'),
    })
    const processed = await app.inject({
      method: 'POST',
      url: `/api/assets/${created.json().asset.id}/process`,
    })

    expect(processed.statusCode).toBe(200)
    expect(processed.json().candidates[0]).toMatchObject({ relation: 'NEW', status: 'PENDING' })
  })

  it('keeps opposite constraints as separate candidates with distinct hashes', async () => {
    const { app } = await fixture()
    const created = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: validAsset('平台最低容量 >= 10。平台最低容量 <= 10。'),
    })
    const processed = await app.inject({
      method: 'POST',
      url: `/api/assets/${created.json().asset.id}/process`,
    })

    expect(processed.statusCode).toBe(200)
    expect(processed.json().candidates).toHaveLength(2)
    expect(new Set(processed.json().candidates.map((candidate: { candidateHash: string }) => candidate.candidateHash)).size).toBe(2)
  })

  it('creates and processes UTF-8 text into traceable candidates and a review', async () => {
    const { app } = await fixture()
    const created = await app.inject({ method: 'POST', url: '/api/assets', payload: validAsset('平台支持私有化部署。') })

    expect(created.statusCode).toBe(201)
    const createdAsset = created.json().asset
    expect(createdAsset).toMatchObject({ processStatus: 'NEW', provider: 'LOCAL' })
    expect(createdAsset).not.toHaveProperty('content')

    const processed = await app.inject({ method: 'POST', url: `/api/assets/${createdAsset.id}/process` })
    expect(processed.statusCode).toBe(200)
    const detail = processed.json()
    const asset = detail.asset

    expect(asset.processStatus).toBe('PROCESSED')
    expect(asset.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(detail.candidates).toHaveLength(1)
    expect(detail.candidates[0].sourceExcerpt).toContain('私有化部署')
    expect(detail.candidates[0].authority).toBe(asset.authority)
    expect(detail.candidates[0].relation).toBe('NEW')
    expect(detail.reviews).toHaveLength(1)
    expect(detail.candidates[0].sourceAssetId).toBe(asset.id)
    expect(detail.candidates[0].sourceLocator).toBe(asset.sections[0].locator)
    expect(asset.sections[0].excerpt).toContain(detail.candidates[0].sourceExcerpt)
  })

  it('retains failed binary assets and allows retry after replacing input with text', async () => {
    const { app, repository } = await fixture()
    const created = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: validAsset('\u0000not text', { mimeType: 'application/pdf' }),
    })
    const id = created.json().asset.id

    const failed = await app.inject({ method: 'POST', url: `/api/assets/${id}/process` })
    expect(failed.statusCode).toBe(200)
    expect(failed.json().asset).toMatchObject({ processStatus: 'FAILED', errorMessage: 'UNSUPPORTED_BINARY_FORMAT' })
    expect(failed.json().candidates).toHaveLength(0)
    expect(failed.json().reviews).toHaveLength(0)

    await repository.transact((draft) => {
      draft.assetInputs[id] = { content: '平台必须支持安全部署。', mimeType: 'text/plain' }
    })
    const retried = await app.inject({ method: 'POST', url: `/api/assets/${id}/process` })
    expect(retried.statusCode).toBe(200)
    expect(retried.json().asset.processStatus).toBe('PROCESSED')
    expect(retried.json().candidates).toHaveLength(1)
  })

  it('does not let a text suffix override an explicitly unsupported MIME type', async () => {
    const { app } = await fixture()
    const created = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: validAsset('平台支持错误格式。', {
        title: '伪装资料.txt',
        mimeType: 'application/pdf',
      }),
    })
    const processed = await app.inject({
      method: 'POST',
      url: `/api/assets/${created.json().asset.id}/process`,
    })

    expect(processed.statusCode).toBe(200)
    expect(processed.json().asset).toMatchObject({
      processStatus: 'FAILED',
      errorMessage: 'UNSUPPORTED_BINARY_FORMAT',
    })
    expect(processed.json().candidates).toHaveLength(0)
    expect(processed.json().reviews).toHaveLength(0)
  })

  it.each(['application/octet-stream', 'application/unknown'])('uses a text suffix for generic MIME %s', async (mimeType) => {
    const { app } = await fixture()
    const created = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: validAsset('平台支持 Markdown 资料。', {
        title: '资料.md',
        mimeType,
      }),
    })
    const processed = await app.inject({
      method: 'POST',
      url: `/api/assets/${created.json().asset.id}/process`,
    })

    expect(processed.statusCode).toBe(200)
    expect(processed.json().asset.processStatus).toBe('PROCESSED')
    expect(processed.json().candidates).toHaveLength(1)
  })

  it('automatically rejects high-confidence exact duplicates without a review', async () => {
    const knowledge: Knowledge = {
      id: 'KNW-EXACT',
      title: '私有化部署说明',
      content: '平台支持私有化部署。',
      category: 'PRODUCT_CAPABILITY',
      tags: [],
      authority: 'L1',
      ownerId: 'USR-OWNER',
      primaryAssetId: 'AST-SOURCE',
      supportingAssetIds: [],
      sourceLocator: 'source:1',
      status: 'ACTIVE',
      version: 1,
      lastVerifiedAt: new Date().toISOString(),
      aiEnabled: true,
      indexStatus: 'INDEXED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const seed = seedSnapshot()
    seed.knowledge.push(knowledge)
    const { app } = await fixture(seed)
    const created = await app.inject({ method: 'POST', url: '/api/assets', payload: validAsset(knowledge.content) })
    const id = created.json().asset.id
    const processed = await app.inject({ method: 'POST', url: `/api/assets/${id}/process` })

    expect(processed.statusCode).toBe(200)
    expect(processed.json().candidates[0]).toMatchObject({ relation: 'DUPLICATE', confidence: expect.any(Number), status: 'REJECTED' })
    expect(processed.json().candidates[0].confidence).toBeGreaterThanOrEqual(0.9)
    expect(processed.json().reviews).toHaveLength(0)
  })

  it('routes low-confidence duplicate fixtures to a conflict review', async () => {
    const knowledge: Knowledge = {
      id: 'KNW-LOW',
      title: '可能重复说明',
      content: '平台支持私有化部署，可能重复。',
      category: 'PRODUCT_CAPABILITY',
      tags: [],
      authority: 'L1',
      ownerId: 'USR-OWNER',
      primaryAssetId: 'AST-SOURCE',
      supportingAssetIds: [],
      sourceLocator: 'source:1',
      status: 'ACTIVE',
      version: 1,
      lastVerifiedAt: new Date().toISOString(),
      aiEnabled: true,
      indexStatus: 'INDEXED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const seed = seedSnapshot()
    seed.knowledge.push(knowledge)
    const { app } = await fixture(seed)
    const created = await app.inject({ method: 'POST', url: '/api/assets', payload: validAsset(knowledge.content) })
    const id = created.json().asset.id
    const processed = await app.inject({ method: 'POST', url: `/api/assets/${id}/process` })

    expect(processed.statusCode).toBe(200)
    expect(processed.json().candidates[0]).toMatchObject({ relation: 'DUPLICATE', confidence: 0.85, status: 'PENDING' })
    expect(processed.json().reviews).toHaveLength(1)
    expect(processed.json().reviews[0]).toMatchObject({ reviewType: 'CONFLICT', candidateId: processed.json().candidates[0].id })
  })

  it('routes an update marker to the matched active knowledge', async () => {
    const knowledge = activeKnowledge('KNW-UPDATE', '部署能力', '平台支持私有化部署。')
    const seed = seedSnapshot()
    seed.knowledge.push(knowledge)
    const { app } = await fixture(seed)
    const created = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: validAsset('平台支持私有化部署更新标记。'),
    })
    const processed = await app.inject({
      method: 'POST',
      url: `/api/assets/${created.json().asset.id}/process`,
    })

    expect(processed.statusCode).toBe(200)
    expect(processed.json().candidates[0]).toMatchObject({
      relation: 'UPDATE',
      existingKnowledgeId: knowledge.id,
    })
    expect(processed.json().reviews[0]).toMatchObject({
      reviewType: 'UPDATE',
      targetKnowledgeId: knowledge.id,
    })
  })

  it('routes a conflict marker to the matched active knowledge', async () => {
    const knowledge = activeKnowledge('KNW-CONFLICT', '安全审核规则', '平台不得绕过安全审核。')
    const seed = seedSnapshot()
    seed.knowledge.push(knowledge)
    const { app } = await fixture(seed)
    const created = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: validAsset('平台不得绕过安全审核，冲突标记。'),
    })
    const processed = await app.inject({
      method: 'POST',
      url: `/api/assets/${created.json().asset.id}/process`,
    })

    expect(processed.statusCode).toBe(200)
    expect(processed.json().candidates[0]).toMatchObject({
      relation: 'CONFLICT',
      existingKnowledgeId: knowledge.id,
    })
    expect(processed.json().reviews[0]).toMatchObject({
      reviewType: 'CONFLICT',
      targetKnowledgeId: knowledge.id,
    })
  })

  it('is idempotent by candidate hash when processing an asset repeatedly', async () => {
    const { app } = await fixture()
    const created = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: validAsset('平台不得绕过安全审核。', { ownerId: 'USR-OWNER' }),
    })
    const id = created.json().asset.id

    const first = await app.inject({ method: 'POST', url: `/api/assets/${id}/process` })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await app.inject({ method: 'POST', url: `/api/assets/${id}/process` })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.json().candidates).toHaveLength(1)
    expect(second.json().reviews).toHaveLength(1)
    expect(second.json().candidates[0].candidateHash).toBe(first.json().candidates[0].candidateHash)
    expect(second.json().reviews[0].reviewerId).toBe('USR-OWNER')
    expect(second.json().asset.processedAt).toBe(first.json().asset.processedAt)
  })

  it('shows only current evidence after a changed source while preserving resolved audit history', async () => {
    const { app, repository } = await fixture()
    const created = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: validAsset('平台支持旧能力。平台必须保留旧流程。'),
    })
    const id = created.json().asset.id
    const first = await app.inject({ method: 'POST', url: `/api/assets/${id}/process` })
    const [resolvedCandidate, staleCandidate] = first.json().candidates
    const resolvedReview = first.json().reviews.find((review: { candidateId: string }) => review.candidateId === resolvedCandidate.id)
    const staleReview = first.json().reviews.find((review: { candidateId: string }) => review.candidateId === staleCandidate.id)
    const resolvedAt = new Date().toISOString()

    await repository.transact((draft) => {
      const candidate = draft.candidates.find((item) => item.id === resolvedCandidate.id)
      const review = draft.reviews.find((item) => item.id === resolvedReview.id)
      if (!candidate || !review) throw new Error('TEST_FIXTURE_NOT_FOUND')
      candidate.status = 'APPROVED'
      candidate.reviewedAt = resolvedAt
      review.status = 'RESOLVED'
      review.resolvedAt = resolvedAt
      draft.assetInputs[id] = { content: '平台支持当前能力。', mimeType: 'text/plain' }
    })

    const changed = await app.inject({ method: 'POST', url: `/api/assets/${id}/process` })
    expect(changed.statusCode).toBe(200)
    expect(changed.json().candidates).toHaveLength(1)
    expect(changed.json().candidates[0].sourceExcerpt).toContain('当前能力')
    expect(changed.json().reviews).toHaveLength(1)
    expect(changed.json().reviews[0].candidateId).toBe(changed.json().candidates[0].id)

    const listed = await app.inject({ method: 'GET', url: '/api/assets' })
    expect(listed.json().assets[0]).toMatchObject({ candidateCount: 1, reviewCount: 1 })

    const snapshot = await repository.read()
    expect(snapshot.candidates.find((candidate) => candidate.id === resolvedCandidate.id)?.status).toBe('APPROVED')
    expect(snapshot.reviews.find((review) => review.id === resolvedReview.id)?.status).toBe('RESOLVED')
    expect(snapshot.candidates.find((candidate) => candidate.id === staleCandidate.id)).toMatchObject({
      status: 'REJECTED',
      reviewedAt: expect.any(String),
    })
    expect(snapshot.reviews.find((review) => review.id === staleReview.id)?.status).toBe('CANCELLED')
  })

  it('creates a fresh pending review when retired evidence returns after another source version', async () => {
    const { app, repository } = await fixture()
    const created = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: validAsset('平台支持能力 A。'),
    })
    const id = created.json().asset.id
    const first = await app.inject({ method: 'POST', url: `/api/assets/${id}/process` })
    const firstCandidateId = first.json().candidates[0].id
    const firstReviewId = first.json().reviews[0].id

    await repository.transact((draft) => {
      draft.assetInputs[id] = { content: '平台支持能力 B。', mimeType: 'text/plain' }
    })
    await app.inject({ method: 'POST', url: `/api/assets/${id}/process` })

    await repository.transact((draft) => {
      draft.assetInputs[id] = { content: '平台支持能力 A。', mimeType: 'text/plain' }
    })
    const restored = await app.inject({ method: 'POST', url: `/api/assets/${id}/process` })

    expect(restored.statusCode).toBe(200)
    expect(restored.json().candidates).toHaveLength(1)
    expect(restored.json().candidates[0]).toMatchObject({ status: 'PENDING', reviewRequired: true })
    expect(restored.json().candidates[0].id).not.toBe(firstCandidateId)
    expect(restored.json().reviews).toHaveLength(1)
    expect(restored.json().reviews[0]).toMatchObject({ status: 'PENDING' })
    expect(restored.json().reviews[0].id).not.toBe(firstReviewId)
  })

  it('clears current evidence and retires pending derivatives when changed input cannot be parsed', async () => {
    const { app, repository } = await fixture()
    const created = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: validAsset('平台支持旧能力。'),
    })
    const id = created.json().asset.id
    const first = await app.inject({ method: 'POST', url: `/api/assets/${id}/process` })
    const oldHash = first.json().asset.contentHash
    const oldCandidateId = first.json().candidates[0].id
    const oldReviewId = first.json().reviews[0].id
    const binary = '\u0000changed binary'

    await repository.transact((draft) => {
      draft.assetInputs[id] = { content: binary, mimeType: 'application/pdf' }
    })
    const failed = await app.inject({ method: 'POST', url: `/api/assets/${id}/process` })
    const expectedHash = createHash('sha256').update(binary, 'utf8').digest('hex')

    expect(failed.statusCode).toBe(200)
    expect(failed.json().asset).toMatchObject({
      processStatus: 'FAILED',
      errorMessage: 'UNSUPPORTED_BINARY_FORMAT',
      contentHash: expectedHash,
      sections: [],
    })
    expect(failed.json().asset.contentHash).not.toBe(oldHash)
    expect(failed.json().asset.summary).toBeUndefined()
    expect(failed.json().candidates).toHaveLength(0)
    expect(failed.json().reviews).toHaveLength(0)

    const snapshot = await repository.read()
    expect(snapshot.candidates.find((candidate) => candidate.id === oldCandidateId)?.status).toBe('REJECTED')
    expect(snapshot.reviews.find((review) => review.id === oldReviewId)?.status).toBe('CANCELLED')
  })

  it('validates owner and does not echo raw input in asset lists or create responses', async () => {
    const { app } = await fixture()
    const rejected = await app.inject({ method: 'POST', url: '/api/assets', payload: validAsset('内容', { ownerId: 'USR-MISSING' }) })
    expect(rejected.statusCode).toBe(404)
    expect(rejected.json().error.code).toBe('OWNER_NOT_FOUND')

    const created = await app.inject({ method: 'POST', url: '/api/assets', payload: validAsset('平台支持本地检索。') })
    const listed = await app.inject({ method: 'GET', url: '/api/assets' })
    expect(created.json().asset).not.toHaveProperty('content')
    expect(listed.json().assets[0]).not.toHaveProperty('content')
    expect(listed.json().assets[0]).not.toHaveProperty('contentHash')
    expect(listed.json().assets[0]).toMatchObject({ candidateCount: 0, reviewCount: 0 })
  })
})
