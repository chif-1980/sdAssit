import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { Candidate, Knowledge, PlatformSnapshot, Review } from '../../shared/domain/models.js'
import type { Relation, ReviewType } from '../../shared/domain/enums.js'
import { canAnswerWithKnowledge } from '../../shared/domain/rules.js'
import { JsonRepository } from '../adapters/jsonRepository.js'
import { buildApp } from '../app.js'
import type { KnowledgeIndexer } from '../application/ports.js'
import { seedSnapshot } from '../seed.js'

const directories: string[] = []
const apps: ReturnType<typeof buildApp>[] = []

const timestamp = '2026-08-11T12:00:00.000Z'

async function fixture(snapshot: PlatformSnapshot, indexer?: KnowledgeIndexer) {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-review-flow-'))
  directories.push(directory)
  const repository = new JsonRepository(join(directory, 'snapshot.json'), snapshot)
  const app = buildApp(repository, indexer)
  await app.ready()
  apps.push(app)
  return { app, repository }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function knowledge(overrides: Partial<Knowledge> = {}): Knowledge {
  return {
    id: 'KNW-TARGET',
    title: '标准部署要求',
    content: '标准部署最低需要 4 张 A800。',
    category: 'TECHNICAL',
    tags: ['部署'],
    authority: 'L1',
    ownerId: 'USR-OWNER',
    primaryAssetId: 'AST-PRIMARY',
    supportingAssetIds: [],
    sourceLocator: 'paragraph:1',
    status: 'ACTIVE',
    version: 2,
    lastVerifiedAt: timestamp,
    aiEnabled: true,
    indexStatus: 'INDEXED',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  }
}

function candidate(relation: Relation, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'KCD-CANDIDATE',
    title: '轻量部署要求',
    content: '轻量部署最低需要 2 张 A800。',
    knowledgeType: 'TECHNICAL',
    sourceAssetId: 'AST-CANDIDATE',
    sourceLocator: 'paragraph:1',
    sourceExcerpt: '轻量部署最低需要 2 张 A800。',
    authority: 'L1',
    confidence: 0.82,
    relation,
    ...(relation === 'NEW' ? {} : { existingKnowledgeId: 'KNW-TARGET' }),
    aiReason: 'TEST_FIXTURE',
    status: 'PENDING',
    reviewRequired: true,
    candidateHash: `hash-${relation}`,
    createdAt: timestamp,
    ...overrides,
  }
}

function review(type: ReviewType, relation: Relation, overrides: Partial<Review> = {}): Review {
  return {
    id: 'RVW-REVIEW',
    title: '审核轻量部署要求',
    triggerType: 'CANDIDATE',
    reviewType: type,
    candidateId: 'KCD-CANDIDATE',
    ...(type === 'NEW' ? {} : { targetKnowledgeId: 'KNW-TARGET' }),
    risk: type === 'CONFLICT' ? 'HIGH' : type === 'UPDATE' ? 'MEDIUM' : 'LOW',
    currentSnapshot: type === 'NEW' ? undefined : '标准部署最低需要 4 张 A800。',
    proposedContent: '轻量部署最低需要 2 张 A800。',
    aiSuggestion: 'TEST_FIXTURE',
    reviewerId: 'USR-OWNER',
    status: 'PENDING',
    createdAt: timestamp,
    ...overrides,
  }
}

function reviewSnapshot(type: ReviewType, relation: Relation, options: {
  target?: Knowledge
  candidateOverrides?: Partial<Candidate>
  reviewOverrides?: Partial<Review>
} = {}) {
  const snapshot = seedSnapshot()
  snapshot.session = { userId: 'USR-OWNER', role: 'OWNER' }
  snapshot.users.push({ id: 'USR-OWNER-2', name: '另一位 Owner', role: 'OWNER' })
  snapshot.assets.push(
    {
      id: 'AST-PRIMARY', title: '标准来源', assetType: 'DOCUMENT', businessType: 'PRODUCT_DOCUMENT',
      provider: 'LOCAL', externalId: 'primary', ownerId: 'USR-OWNER', authority: 'L1', processStatus: 'PROCESSED',
      createdAt: timestamp, updatedAt: timestamp, processedAt: timestamp, isSessionAsset: false,
      sections: [{ id: 'SEC-1', title: '标准', locator: 'paragraph:1', excerpt: '标准部署最低需要 4 张 A800。' }],
    },
    {
      id: 'AST-CANDIDATE', title: '候选来源', assetType: 'DOCUMENT', businessType: 'PRODUCT_DOCUMENT',
      provider: 'LOCAL', externalId: 'candidate', ownerId: 'USR-OWNER', authority: 'L1', processStatus: 'PROCESSED',
      createdAt: timestamp, updatedAt: timestamp, processedAt: timestamp, isSessionAsset: false,
      sections: [{ id: 'SEC-1', title: '候选', locator: 'paragraph:1', excerpt: '轻量部署最低需要 2 张 A800。' }],
    },
  )
  snapshot.candidates.push(candidate(relation, options.candidateOverrides))
  snapshot.reviews.push(review(type, relation, options.reviewOverrides))
  if (type !== 'NEW') snapshot.knowledge.push(options.target ?? knowledge())
  return snapshot
}

async function resolve(app: ReturnType<typeof buildApp>, action: string, finalContent?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/reviews/RVW-REVIEW/resolve',
    payload: {
      action,
      ...(finalContent === undefined ? {} : { finalContent }),
      decisionComment: '测试审核意见',
    },
  })
}

describe('Review -> Knowledge flow', () => {
  it('creates indexed version-1 knowledge from a NEW review', async () => {
    const { app } = await fixture(reviewSnapshot('NEW', 'NEW'))
    const response = await resolve(app, 'CREATE_KNOWLEDGE', '轻量部署最低需要 2 张 A800。')

    expect(response.statusCode).toBe(200)
    expect(response.json().review).toMatchObject({ status: 'RESOLVED', resolutionAction: 'CREATE_KNOWLEDGE' })
    expect(response.json().candidate).toMatchObject({ status: 'APPROVED' })
    expect(response.json().knowledge).toMatchObject({ version: 1, status: 'ACTIVE', indexStatus: 'INDEXED' })

    const detail = await app.inject({
      method: 'GET',
      url: `/api/knowledge/${response.json().knowledge.id}`,
    })
    expect(detail.json().history).toMatchObject([
      { id: 'RVW-REVIEW', status: 'RESOLVED', resolutionAction: 'CREATE_KNOWLEDGE' },
    ])
  })

  it('lets CONFLICT create separate knowledge without changing the existing version', async () => {
    const existing = knowledge()
    const { app } = await fixture(reviewSnapshot('CONFLICT', 'CONFLICT', { target: existing }))
    const response = await resolve(app, 'CREATE_KNOWLEDGE', '轻量部署最低需要 2 张 A800。')
    const list = await app.inject({ method: 'GET', url: '/api/knowledge' })

    expect(response.statusCode).toBe(200)
    expect(list.json().knowledge.find((item: Knowledge) => item.id === existing.id).version).toBe(existing.version)
    expect(list.json().knowledge.some((item: Knowledge) => item.id !== existing.id && item.content.includes('轻量部署'))).toBe(true)

    const oldDetail = await app.inject({ method: 'GET', url: `/api/knowledge/${existing.id}` })
    const newDetail = await app.inject({ method: 'GET', url: `/api/knowledge/${response.json().knowledge.id}` })
    expect(oldDetail.json().history.map((item: Review) => item.id)).toContain('RVW-REVIEW')
    expect(newDetail.json().history.map((item: Review) => item.id)).toContain('RVW-REVIEW')
  })

  it('updates target knowledge, increments version, and approves the candidate', async () => {
    const existing = knowledge()
    const { app } = await fixture(reviewSnapshot('UPDATE', 'UPDATE', { target: existing }))
    const response = await resolve(app, 'UPDATE_KNOWLEDGE', '标准与轻量部署分别需要 4 张和 2 张 A800。')

    expect(response.statusCode).toBe(200)
    expect(response.json().knowledge).toMatchObject({ version: existing.version + 1, indexStatus: 'INDEXED' })
    expect(response.json().candidate.status).toBe('APPROVED')
  })

  it('keeps current knowledge and rejects valid evidence not adopted', async () => {
    const existing = knowledge()
    const { app } = await fixture(reviewSnapshot('UPDATE', 'UPDATE', { target: existing }))
    const response = await resolve(app, 'KEEP_CURRENT')

    expect(response.statusCode).toBe(200)
    expect(response.json().candidate.status).toBe('REJECTED')
    expect(response.json().knowledge).toMatchObject({ version: existing.version, content: existing.content })
  })

  it('rejects a candidate without changing knowledge', async () => {
    const existing = knowledge()
    const { app } = await fixture(reviewSnapshot('CONFLICT', 'CONFLICT', { target: existing }))
    const response = await resolve(app, 'REJECT_CANDIDATE')

    expect(response.statusCode).toBe(200)
    expect(response.json().candidate.status).toBe('REJECTED')
    expect(response.json().knowledge).toMatchObject({ version: existing.version, content: existing.content })
  })

  it('archives stale knowledge and disables AI', async () => {
    const target = knowledge({ status: 'STALE', aiEnabled: false, staleReason: '待复核' })
    const snapshot = reviewSnapshot('STALE', 'UPDATE', { target })
    const { app } = await fixture(snapshot)
    const response = await resolve(app, 'ARCHIVE_KNOWLEDGE')

    expect(response.statusCode).toBe(200)
    expect(response.json().knowledge).toMatchObject({ status: 'ARCHIVED', aiEnabled: false })
    expect(response.json().candidate).toMatchObject({ status: 'REJECTED', reviewRequired: false })
  })

  it('confirms stale knowledge as valid and enables AI', async () => {
    const target = knowledge({ status: 'STALE', aiEnabled: false, staleReason: '待复核' })
    const { app } = await fixture(reviewSnapshot('STALE', 'UPDATE', { target }))
    const response = await resolve(app, 'CONFIRM_VALID')

    expect(response.statusCode).toBe(200)
    expect(response.json().knowledge).toMatchObject({ status: 'ACTIVE', aiEnabled: true })
    expect(response.json().knowledge.staleReason).toBeUndefined()
    expect(response.json().candidate).toMatchObject({ status: 'REJECTED', reviewRequired: false })
  })

  it('rejects invalid actions, authority escalation, unassigned owners, and duplicate resolution', async () => {
    const invalid = await fixture(reviewSnapshot('NEW', 'NEW'))
    const invalidAction = await resolve(invalid.app, 'ARCHIVE_KNOWLEDGE')
    expect(invalidAction.statusCode).toBe(400)
    expect(invalidAction.json().error.code).toBe('REVIEW_ACTION_NOT_ALLOWED')

    const elevated = await fixture(reviewSnapshot('NEW', 'NEW', { candidateOverrides: { authority: 'L3' } }))
    const elevatedResponse = await resolve(elevated.app, 'CREATE_KNOWLEDGE', '越级知识')
    expect(elevatedResponse.statusCode).toBe(400)
    expect(elevatedResponse.json().error.code).toBe('KNOWLEDGE_AUTHORITY_EXCEEDS_SOURCE')
    expect((await elevated.repository.read()).reviews[0].status).toBe('PENDING')
    expect((await elevated.repository.read()).knowledge).toHaveLength(0)

    const forbiddenSnapshot = reviewSnapshot('NEW', 'NEW')
    forbiddenSnapshot.session = { userId: 'USR-OWNER-2', role: 'OWNER' }
    const forbidden = await fixture(forbiddenSnapshot)
    expect((await resolve(forbidden.app, 'CREATE_KNOWLEDGE', '内容')).statusCode).toBe(403)

    const repeated = await fixture(reviewSnapshot('NEW', 'NEW'))
    expect((await resolve(repeated.app, 'CREATE_KNOWLEDGE', '内容')).statusCode).toBe(200)
    const second = await resolve(repeated.app, 'CREATE_KNOWLEDGE', '内容')
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('REVIEW_ALREADY_RESOLVED')
  })

  it('keeps the review resolved when deterministic indexing fails', async () => {
    const { app } = await fixture(reviewSnapshot('NEW', 'NEW'))
    const response = await resolve(app, 'CREATE_KNOWLEDGE', '[INDEX_FAIL] 轻量部署最低需要 2 张 A800。')

    expect(response.statusCode).toBe(200)
    expect(response.json().review.status).toBe('RESOLVED')
    expect(response.json().candidate.status).toBe('APPROVED')
    expect(response.json().knowledge.indexStatus).toBe('FAILED')
  })

  it('commits the review and PENDING knowledge before indexing starts', async () => {
    let markIndexStarted!: () => void
    let releaseIndex!: () => void
    const indexStarted = new Promise<void>((resolve) => {
      markIndexStarted = resolve
    })
    const canFinishIndex = new Promise<void>((resolve) => {
      releaseIndex = resolve
    })
    const indexer: KnowledgeIndexer = {
      async index() {
        markIndexStarted()
        await canFinishIndex
      },
    }
    const { app, repository } = await fixture(reviewSnapshot('NEW', 'NEW'), indexer)

    const responsePromise = resolve(app, 'CREATE_KNOWLEDGE', '轻量部署最低需要 2 张 A800。')
    const startedBeforeResponse = await Promise.race([
      indexStarted.then(() => true),
      responsePromise.then(() => false),
    ])
    expect(startedBeforeResponse).toBe(true)

    const pending = await repository.read()
    expect(pending.reviews[0]).toMatchObject({ status: 'RESOLVED', resolutionAction: 'CREATE_KNOWLEDGE' })
    expect(pending.candidates[0]).toMatchObject({ status: 'APPROVED', reviewRequired: false })
    expect(pending.knowledge[0].indexStatus).toBe('PENDING')
    expect(canAnswerWithKnowledge(pending.knowledge[0])).toBe(false)

    releaseIndex()
    const response = await responsePromise
    expect(response.statusCode).toBe(200)
    expect(response.json().knowledge.indexStatus).toBe('INDEXED')
    expect(canAnswerWithKnowledge(response.json().knowledge)).toBe(true)
  })

  it('commits an UPDATE review and PENDING knowledge before indexing starts', async () => {
    let markIndexStarted!: () => void
    let releaseIndex!: () => void
    const indexStarted = new Promise<void>((resolve) => {
      markIndexStarted = resolve
    })
    const canFinishIndex = new Promise<void>((resolve) => {
      releaseIndex = resolve
    })
    const indexer: KnowledgeIndexer = {
      async index() {
        markIndexStarted()
        await canFinishIndex
      },
    }
    const existing = knowledge()
    const { app, repository } = await fixture(
      reviewSnapshot('UPDATE', 'UPDATE', { target: existing }),
      indexer,
    )

    const responsePromise = resolve(
      app,
      'UPDATE_KNOWLEDGE',
      '标准与轻量部署分别需要 4 张和 2 张 A800。',
    )
    const startedBeforeResponse = await Promise.race([
      indexStarted.then(() => true),
      responsePromise.then(() => false),
    ])
    expect(startedBeforeResponse).toBe(true)

    try {
      const pending = await repository.read()
      expect(pending.reviews[0]).toMatchObject({ status: 'RESOLVED', resolutionAction: 'UPDATE_KNOWLEDGE' })
      expect(pending.candidates[0]).toMatchObject({ status: 'APPROVED', reviewRequired: false })
      expect(pending.knowledge[0]).toMatchObject({
        version: existing.version + 1,
        indexStatus: 'PENDING',
      })
      expect(canAnswerWithKnowledge(pending.knowledge[0])).toBe(false)
    } finally {
      releaseIndex()
    }

    const response = await responsePromise
    expect(response.statusCode).toBe(200)
    expect(response.json().knowledge.indexStatus).toBe('INDEXED')
    expect(canAnswerWithKnowledge(response.json().knowledge)).toBe(true)
  })

  it('validates resolve requests and maps final-content errors to stable 400 responses', async () => {
    const { app, repository } = await fixture(reviewSnapshot('NEW', 'NEW'))
    const invalidPayloads = [
      { action: 'CREATE_KNOWLEDGE', finalContent: '内容' },
      { action: 'CREATE_KNOWLEDGE', finalContent: '内容', decisionComment: ' ' },
      { action: 'UNKNOWN_ACTION', finalContent: '内容', decisionComment: '意见' },
      { action: 'CREATE_KNOWLEDGE', finalContent: 'x'.repeat(4001), decisionComment: '意见' },
      { action: 'CREATE_KNOWLEDGE', finalContent: '内容', decisionComment: 'x'.repeat(2001) },
    ]

    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/reviews/RVW-REVIEW/resolve',
        payload,
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({
        error: { code: 'INVALID_REQUEST', message: 'INVALID_REQUEST', details: {} },
      })
    }

    const missingFinalContent = await app.inject({
      method: 'POST',
      url: '/api/reviews/RVW-REVIEW/resolve',
      payload: { action: 'CREATE_KNOWLEDGE', decisionComment: '意见' },
    })
    expect(missingFinalContent.statusCode).toBe(400)
    expect(missingFinalContent.json()).toEqual({
      error: { code: 'FINAL_CONTENT_REQUIRED', message: 'FINAL_CONTENT_REQUIRED', details: {} },
    })

    const unchanged = await repository.read()
    expect(unchanged.reviews[0].status).toBe('PENDING')
    expect(unchanged.candidates[0].status).toBe('PENDING')
    expect(unchanged.knowledge).toHaveLength(0)
  })

  it('filters and prioritizes review lists on the server and protects review detail', async () => {
    const snapshot = reviewSnapshot('CONFLICT', 'CONFLICT')
    snapshot.reviews.push(
      review('NEW', 'NEW', {
        id: 'RVW-LOW',
        title: '普通审核',
        risk: 'LOW',
        candidateId: undefined,
        createdAt: '2026-08-11T13:00:00.000Z',
      }),
      review('UPDATE', 'UPDATE', {
        id: 'RVW-RESOLVED',
        title: '已完成审核',
        status: 'RESOLVED',
        resolutionAction: 'KEEP_CURRENT',
        resolvedAt: '2026-08-11T13:00:00.000Z',
      }),
      review('NEW', 'NEW', {
        id: 'RVW-OTHER',
        title: '其他负责人审核',
        reviewerId: 'USR-OWNER-2',
        candidateId: undefined,
      }),
    )
    const { app } = await fixture(snapshot)

    const pending = await app.inject({ method: 'GET', url: '/api/reviews' })
    expect(pending.statusCode).toBe(200)
    expect(pending.json().reviews.map((item: Review) => item.id)).toEqual(['RVW-REVIEW', 'RVW-LOW'])

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/reviews?status=RESOLVED&reviewType=UPDATE&risk=MEDIUM&q=%E5%AE%8C%E6%88%90',
    })
    expect(filtered.statusCode).toBe(200)
    expect(filtered.json().reviews).toHaveLength(1)
    expect(filtered.json().reviews[0]).toMatchObject({
      id: 'RVW-RESOLVED',
      allowedActions: [],
    })

    const detail = await app.inject({ method: 'GET', url: '/api/reviews/RVW-REVIEW' })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({
      review: { id: 'RVW-REVIEW' },
      candidate: { id: 'KCD-CANDIDATE' },
      knowledge: { id: 'KNW-TARGET' },
      sourceAsset: { id: 'AST-CANDIDATE', authority: 'L1' },
      allowedActions: ['CREATE_KNOWLEDGE', 'UPDATE_KNOWLEDGE', 'KEEP_CURRENT', 'REJECT_CANDIDATE'],
    })

    const forbiddenSnapshot = structuredClone(snapshot)
    forbiddenSnapshot.session = { userId: 'USR-OWNER-2', role: 'OWNER' }
    const forbidden = await fixture(forbiddenSnapshot)
    const forbiddenDetail = await forbidden.app.inject({ method: 'GET', url: '/api/reviews/RVW-REVIEW' })
    expect(forbiddenDetail.statusCode).toBe(403)

    const employeeSnapshot = structuredClone(snapshot)
    employeeSnapshot.session = { userId: 'USR-EMPLOYEE', role: 'EMPLOYEE' }
    const employee = await fixture(employeeSnapshot)
    expect((await employee.app.inject({ method: 'GET', url: '/api/reviews' })).statusCode).toBe(403)
    expect((await employee.app.inject({ method: 'GET', url: '/api/knowledge' })).statusCode).toBe(403)
  })

  it('filters knowledge by role and query and returns evidence with review history', async () => {
    const snapshot = reviewSnapshot('UPDATE', 'UPDATE', {
      target: knowledge({ supportingAssetIds: ['AST-CANDIDATE'] }),
    })
    snapshot.knowledge.push(
      knowledge({
        id: 'KNW-ARCHIVED',
        title: '归档政策',
        content: '这是一条归档政策。',
        category: 'POLICY',
        tags: ['归档'],
        authority: 'L2',
        status: 'ARCHIVED',
        aiEnabled: false,
        updatedAt: '2026-08-10T12:00:00.000Z',
      }),
      knowledge({
        id: 'KNW-OTHER',
        title: '其他负责人知识',
        ownerId: 'USR-OWNER-2',
      }),
    )
    const { app } = await fixture(snapshot)

    const visible = await app.inject({ method: 'GET', url: '/api/knowledge' })
    expect(visible.statusCode).toBe(200)
    expect(visible.json().knowledge.map((item: Knowledge) => item.id)).toEqual(['KNW-TARGET', 'KNW-ARCHIVED'])

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/knowledge?q=%E5%BD%92%E6%A1%A3&category=POLICY&status=ARCHIVED&authority=L2&ownerId=USR-OWNER&updatedFrom=2026-08-10T00%3A00%3A00.000Z&updatedTo=2026-08-10T23%3A59%3A59.999Z',
    })
    expect(filtered.statusCode).toBe(200)
    expect(filtered.json().knowledge.map((item: Knowledge) => item.id)).toEqual(['KNW-ARCHIVED'])

    const cannotBypassRole = await app.inject({ method: 'GET', url: '/api/knowledge?ownerId=USR-OWNER-2' })
    expect(cannotBypassRole.statusCode).toBe(200)
    expect(cannotBypassRole.json().knowledge).toEqual([])

    const detail = await app.inject({ method: 'GET', url: '/api/knowledge/KNW-TARGET' })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({
      knowledge: { id: 'KNW-TARGET' },
      primaryAsset: { id: 'AST-PRIMARY' },
      supportingAssets: [{ id: 'AST-CANDIDATE' }],
      history: [{ id: 'RVW-REVIEW' }],
    })

    const adminSnapshot = structuredClone(snapshot)
    adminSnapshot.session = { userId: 'USR-ADMIN', role: 'ADMIN' }
    const admin = await fixture(adminSnapshot)
    const allKnowledge = await admin.app.inject({ method: 'GET', url: '/api/knowledge' })
    expect(allKnowledge.json().knowledge).toHaveLength(3)
  })

  it('creates update reviews and can reindex knowledge through explicit actions', async () => {
    const snapshot = seedSnapshot()
    snapshot.session = { userId: 'USR-OWNER', role: 'OWNER' }
    snapshot.assets.push(reviewSnapshot('UPDATE', 'UPDATE').assets[0])
    snapshot.knowledge.push(knowledge({ indexStatus: 'FAILED' }))
    const { app, repository } = await fixture(snapshot)

    const requested = await app.inject({
      method: 'POST', url: '/api/knowledge/KNW-TARGET/request-update',
      payload: { proposedContent: '新的正式内容', decisionComment: '发起更新' },
    })
    expect(requested.statusCode).toBe(201)
    expect(requested.json().review).toMatchObject({ reviewType: 'UPDATE', status: 'PENDING' })
    expect((await repository.read()).knowledge[0].content).toBe('标准部署最低需要 4 张 A800。')

    const reindexed = await app.inject({ method: 'POST', url: '/api/knowledge/KNW-TARGET/reindex' })
    expect(reindexed.statusCode).toBe(200)
    expect(reindexed.json().knowledge.indexStatus).toBe('INDEXED')
  })

  it('creates a STALE review when an owner requests archival', async () => {
    const snapshot = seedSnapshot()
    snapshot.session = { userId: 'USR-OWNER', role: 'OWNER' }
    snapshot.assets.push(reviewSnapshot('UPDATE', 'UPDATE').assets[0])
    snapshot.knowledge.push(knowledge())
    const { app, repository } = await fixture(snapshot)

    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/KNW-TARGET/request-update',
      payload: { intent: 'ARCHIVE', decisionComment: '该部署方式已经下线' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().review).toMatchObject({
      reviewType: 'STALE',
      targetKnowledgeId: 'KNW-TARGET',
      status: 'PENDING',
      aiSuggestion: '该部署方式已经下线',
    })
    expect(response.json().review.proposedContent).toBeUndefined()
    expect((await repository.read()).knowledge[0]).toMatchObject({ status: 'ACTIVE', version: 2 })
  })
})
