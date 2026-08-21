import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { Asset, Knowledge, PlatformSnapshot } from '../../shared/domain/models.js'
import { JsonRepository } from '../adapters/jsonRepository.js'
import { buildApp } from '../app.js'
import { seedSnapshot } from '../seed.js'

const directories: string[] = []
const apps: ReturnType<typeof buildApp>[] = []
const timestamp = '2026-08-11T12:00:00.000Z'

function knowledge(overrides: Partial<Knowledge> = {}): Knowledge {
  return {
    id: 'KNW-READY', title: '标准部署要求', content: '标准部署最低需要 4 张 A800。', category: 'TECHNICAL', tags: ['部署'],
    authority: 'L1', ownerId: 'USR-OWNER', primaryAssetId: 'AST-ENTERPRISE', supportingAssetIds: [], sourceLocator: 'paragraph:1',
    status: 'ACTIVE', version: 1, lastVerifiedAt: timestamp, aiEnabled: true, indexStatus: 'INDEXED', createdAt: timestamp, updatedAt: timestamp,
    ...overrides,
  }
}

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'AST-SESSION', title: '会话资料', assetType: 'DOCUMENT', businessType: 'SESSION_UPLOAD', provider: 'LOCAL', externalId: 'session',
    ownerId: 'USR-EMPLOYEE', authority: 'L0', processStatus: 'PROCESSED', createdAt: timestamp, updatedAt: timestamp,
    processedAt: timestamp, isSessionAsset: true, sections: [{ id: 'SEC-1', title: '轻量部署', locator: 'paragraph:1', excerpt: '轻量部署最低需要 2 张 A800。' }],
    ...overrides,
  }
}

async function fixture(seed?: PlatformSnapshot) {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-conversation-flow-'))
  directories.push(directory)
  const repository = new JsonRepository(join(directory, 'snapshot.json'), seed ?? seedSnapshot())
  const app = buildApp(repository)
  await app.ready()
  apps.push(app)
  return { app, repository }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Conversation flow', () => {
  it('answers only with eligible enterprise knowledge and persists messages separately', async () => {
    const seed = seedSnapshot()
    seed.session = { userId: 'USR-EMPLOYEE', role: 'EMPLOYEE' }
    seed.assets.push(asset({ id: 'AST-ENTERPRISE', title: '企业部署指南', isSessionAsset: false, businessType: 'PRODUCT_DOCUMENT', ownerId: 'USR-OWNER', authority: 'L1' }))
    seed.knowledge.push(
      knowledge(),
      knowledge({ id: 'KNW-STALE', title: '过期部署要求', content: '过期部署最低需要 1 张 A800。', status: 'STALE', aiEnabled: false }),
      knowledge({ id: 'KNW-PENDING', title: '待索引部署要求', content: '待索引部署最低需要 8 张 A800。', indexStatus: 'PENDING' }),
    )
    const { app, repository } = await fixture(seed)

    const created = await app.inject({ method: 'POST', url: '/api/conversations', payload: { scope: 'ENTERPRISE' } })
    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${created.json().conversation.id}/messages`,
      payload: { text: '部署需要多少张卡？', scope: 'ENTERPRISE' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().answer).toMatchObject({ confidence: 'SUPPORTED' })
    expect(response.json().answer.text).toContain('4 张 A800')
    expect(response.json().answer.text).not.toContain('1 张 A800')
    expect(response.json().answer.text).not.toContain('8 张 A800')
    expect(response.json().answer.citations).toMatchObject([{ knowledgeId: 'KNW-READY', assetId: 'AST-ENTERPRISE', assetOwnerId: 'USR-OWNER' }])

    const stored = await repository.read()
    expect(stored.conversations).toHaveLength(1)
    expect(stored.conversations[0]).toMatchObject({
      title: '部署需要多少张卡？',
      topic: '部署需要多少张卡？',
      summary: '标准部署最低需要 4 张 A800。',
      messageCount: 2,
      userId: 'USR-EMPLOYEE',
      scope: 'ENTERPRISE',
    })
    expect(stored.messages).toHaveLength(2)
    expect(stored.messages.map((message) => message.role)).toEqual(['USER', 'ASSISTANT'])
  })

  it('merges ready Session Asset evidence for BOTH scope without using unprocessed assets', async () => {
    const seed = seedSnapshot()
    seed.session = { userId: 'USR-EMPLOYEE', role: 'EMPLOYEE' }
    seed.assets.push(
      asset(),
      asset({ id: 'AST-FAILED', title: '失败会话资料', processStatus: 'FAILED', sections: [{ id: 'SEC-2', title: '失败', locator: 'paragraph:1', excerpt: '失败资料不应进入回答。' }] }),
      asset({ id: 'AST-EXPIRED', title: '过期会话资料', expiresAt: '2026-08-10T12:00:00.000Z', sections: [{ id: 'SEC-3', title: '过期', locator: 'paragraph:1', excerpt: '轻量部署过期资料不应进入回答。' }] }),
    )
    seed.assets.push(asset({ id: 'AST-ENTERPRISE', title: '企业部署指南', isSessionAsset: false, businessType: 'PRODUCT_DOCUMENT', ownerId: 'USR-OWNER', authority: 'L1' }))
    seed.knowledge.push(knowledge())
    const { app, repository } = await fixture(seed)
    const created = await app.inject({
      method: 'POST', url: '/api/conversations',
      payload: { scope: 'BOTH', sessionAssetIds: ['AST-SESSION', 'AST-FAILED', 'AST-EXPIRED'] },
    })
    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${created.json().conversation.id}` })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().sessionAssets.map((item: Asset) => item.id)).toEqual(['AST-SESSION', 'AST-FAILED', 'AST-EXPIRED'])

    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${created.json().conversation.id}/messages`,
      payload: { text: '轻量部署需要多少张卡？', scope: 'BOTH' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().answer.text).toContain('2 张 A800')
    expect(response.json().answer.text).not.toContain('失败资料')
    expect(response.json().answer.text).not.toContain('过期资料')
    expect(response.json().answer.citations.some((citation: { assetId: string }) => citation.assetId === 'AST-SESSION')).toBe(true)
  })

  it('archives conversations and promotes a processed Session Asset to enterprise material', async () => {
    const seed = seedSnapshot()
    seed.session = { userId: 'USR-EMPLOYEE', role: 'EMPLOYEE' }
    const { app, repository } = await fixture(seed)
    const created = await app.inject({ method: 'POST', url: '/api/conversations', payload: { scope: 'SESSION' } })
    const archived = await app.inject({ method: 'POST', url: `/api/conversations/${created.json().conversation.id}/archive` })
    expect(archived.statusCode).toBe(200)
    expect(archived.json().conversation.status).toBe('ARCHIVED')

    const uploaded = await app.inject({
      method: 'POST', url: '/api/assets', payload: {
        title: '会话上传.txt', assetType: 'DOCUMENT', businessType: 'SESSION_UPLOAD', ownerId: 'USR-EMPLOYEE',
        content: '平台必须支持安全部署。', mimeType: 'text/plain', isSessionAsset: true,
      },
    })
    const processed = await app.inject({ method: 'POST', url: `/api/assets/${uploaded.json().asset.id}/process` })
    expect(processed.json().asset.isSessionAsset).toBe(true)
    expect(processed.json().candidates).toHaveLength(0)
    expect(processed.json().reviews).toHaveLength(0)
    const linked = await app.inject({
      method: 'POST', url: '/api/conversations',
      payload: { scope: 'SESSION', sessionAssetIds: [uploaded.json().asset.id] },
    })
    const promoted = await app.inject({
      method: 'POST', url: `/api/assets/${uploaded.json().asset.id}/promote`,
      payload: { businessType: 'PRODUCT_DOCUMENT', ownerId: 'USR-OWNER' },
    })
    expect(promoted.statusCode).toBe(200)
    expect(promoted.json().asset).toMatchObject({ isSessionAsset: false, businessType: 'PRODUCT_DOCUMENT', ownerId: 'USR-OWNER', authority: 'L1' })
    expect(Object.keys(promoted.json())).toEqual(['asset'])
    const stored = await repository.read()
    expect(stored.candidates).toMatchObject([{ authority: 'L1', sourceAssetId: uploaded.json().asset.id }])
    expect(stored.reviews).toHaveLength(1)
    expect(stored.conversations.find((item) => item.id === linked.json().conversation.id)?.sessionAssetIds).toEqual([])
  })

  it('restores an archived conversation for its owner', async () => {
    const seed = seedSnapshot()
    seed.session = { userId: 'USR-EMPLOYEE', role: 'EMPLOYEE' }
    const { app } = await fixture(seed)
    const created = await app.inject({ method: 'POST', url: '/api/conversations', payload: { scope: 'ENTERPRISE' } })
    const id = created.json().conversation.id

    await app.inject({ method: 'POST', url: `/api/conversations/${id}/archive` })
    const restored = await app.inject({ method: 'POST', url: `/api/conversations/${id}/restore` })

    expect(restored.statusCode).toBe(200)
    expect(restored.json().conversation).toMatchObject({ id, status: 'ACTIVE' })
  })

  it('only promotes the current user Session Asset to a factory-capable owner', async () => {
    const seed = seedSnapshot()
    seed.session = { userId: 'USR-EMPLOYEE', role: 'EMPLOYEE' }
    seed.assets.push(
      asset({ id: 'AST-OTHER', ownerId: 'USR-OWNER' }),
      asset({ id: 'AST-OWN', ownerId: 'USR-EMPLOYEE' }),
    )
    const { app } = await fixture(seed)

    const foreign = await app.inject({
      method: 'POST', url: '/api/assets/AST-OTHER/promote',
      payload: { businessType: 'PRODUCT_DOCUMENT', ownerId: 'USR-OWNER' },
    })
    expect(foreign.statusCode).toBe(403)

    const employeeOwner = await app.inject({
      method: 'POST', url: '/api/assets/AST-OWN/promote',
      payload: { businessType: 'PRODUCT_DOCUMENT', ownerId: 'USR-EMPLOYEE' },
    })
    expect(employeeOwner.statusCode).toBe(400)
  })

  it('prevents employees from creating enterprise assets or reading another user Session Asset', async () => {
    const seed = seedSnapshot()
    seed.session = { userId: 'USR-EMPLOYEE', role: 'EMPLOYEE' }
    seed.assets.push(asset({ id: 'AST-OTHER', ownerId: 'USR-OWNER' }))
    const { app } = await fixture(seed)

    const enterprise = await app.inject({
      method: 'POST', url: '/api/assets', payload: {
        title: '伪造企业资料', assetType: 'DOCUMENT', businessType: 'PRODUCT_DOCUMENT', ownerId: 'USR-EMPLOYEE',
        content: '不应创建。', mimeType: 'text/plain', isSessionAsset: false,
      },
    })
    expect(enterprise.statusCode).toBe(403)

    const detail = await app.inject({ method: 'GET', url: '/api/assets/AST-OTHER' })
    expect(detail.statusCode).toBe(403)
    const process = await app.inject({ method: 'POST', url: '/api/assets/AST-OTHER/process' })
    expect(process.statusCode).toBe(403)
  })

  it('ranks higher-authority evidence before stronger lexical overlap', async () => {
    const seed = seedSnapshot()
    seed.session = { userId: 'USR-EMPLOYEE', role: 'EMPLOYEE' }
    const items = [
      knowledge({ id: 'KNW-L3', title: '部署规范', content: '部署遵循最高权威规范。', authority: 'L3', primaryAssetId: 'AST-L3' }),
      knowledge({ id: 'KNW-L1-A', title: '部署卡要求 A', content: '部署需要计算卡和存储卡。', primaryAssetId: 'AST-L1-A' }),
      knowledge({ id: 'KNW-L1-B', title: '部署卡要求 B', content: '部署需要计算卡和网络卡。', primaryAssetId: 'AST-L1-B' }),
      knowledge({ id: 'KNW-L1-C', title: '部署卡要求 C', content: '部署需要计算卡和加速卡。', primaryAssetId: 'AST-L1-C' }),
    ]
    seed.knowledge.push(...items)
    seed.assets.push(...items.map((item) => asset({
      id: item.primaryAssetId,
      title: item.title,
      isSessionAsset: false,
      businessType: 'PRODUCT_DOCUMENT',
      ownerId: 'USR-OWNER',
      authority: item.authority,
    })))
    const { app } = await fixture(seed)
    const created = await app.inject({ method: 'POST', url: '/api/conversations', payload: { scope: 'ENTERPRISE' } })
    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${created.json().conversation.id}/messages`,
      payload: { text: '部署需要哪些卡？' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().answer.citations).toHaveLength(3)
    expect(response.json().answer.citations[0].knowledgeId).toBe('KNW-L3')
  })
})
