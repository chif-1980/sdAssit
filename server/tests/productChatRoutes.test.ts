import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { Asset, Knowledge, PlatformSnapshot } from '../../shared/domain/models.js'
import { JsonRepository } from '../adapters/jsonRepository.js'
import { buildApp } from '../app.js'
import { imageCitationFromText } from '../application/conversationService.js'
import { seedSnapshot } from '../seed.js'

const directories: string[] = []
const apps: ReturnType<typeof buildApp>[] = []
const timestamp = '2026-08-28T12:00:00.000Z'

function enterpriseAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'AST-PRODUCT',
    title: '产品说明 v3.2.pdf',
    assetType: 'DOCUMENT',
    businessType: 'PRODUCT_DOCUMENT',
    provider: 'LOCAL',
    externalId: 'feishu-doc-1',
    sourceUrl: 'https://feishu.cn/docx/product-1',
    ownerId: 'USR-OWNER',
    authority: 'L1',
    processStatus: 'PROCESSED',
    summary: '产品定位和部署要求。',
    createdAt: timestamp,
    updatedAt: timestamp,
    isSessionAsset: false,
    sections: [{ id: 'SEC-PRODUCT', title: '部署要求', locator: 'page:2', excerpt: '标准部署最低需要 4 张 A800。' }],
    ...overrides,
  }
}

function enterpriseKnowledge(overrides: Partial<Knowledge> = {}): Knowledge {
  return {
    id: 'KNW-PRODUCT',
    title: '产品部署要求',
    content: '标准部署最低需要 4 张 A800。',
    category: 'PRODUCT_PARAMETER',
    tags: ['部署'],
    authority: 'L1',
    ownerId: 'USR-OWNER',
    primaryAssetId: 'AST-PRODUCT',
    supportingAssetIds: [],
    sourceLocator: 'page:2',
    status: 'ACTIVE',
    version: 1,
    lastVerifiedAt: timestamp,
    aiEnabled: true,
    indexStatus: 'INDEXED',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  }
}

async function fixture(seed?: PlatformSnapshot) {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-product-chat-'))
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

describe('Product chat compatibility API', () => {
  it('accepts only safe same-origin public image references', () => {
    expect(imageCitationFromText('![架构](/minio/public/docs/architecture.png)')).toMatchObject({
      mediaType: 'IMAGE',
      imageUrl: '/minio/public/docs/architecture.png',
      previewUrl: '/minio/public/docs/architecture.png',
    })
    expect(imageCitationFromText('![架构](/minio/public/docs/../private.png)')).toBeUndefined()
    expect(imageCitationFromText('![架构](https://example.test/architecture.png)')).toBeUndefined()
    expect(imageCitationFromText('![架构](/minio/public/docs/architecture.png\n)')).toBeUndefined()
  })

  it('exposes the shared skill catalog and maps conversations to product DTOs', async () => {
    const { app } = await fixture()
    const skills = await app.inject({ method: 'GET', url: '/api/chat/skills' })
    expect(skills.statusCode).toBe(200)
    expect(skills.json().skills.map((skill: { id: string }) => skill.id)).toEqual([
      'MATERIAL_SEARCH', 'SOLUTION_DRAFT', 'MEETING_ANALYSIS',
    ])

    const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: {} })
    expect(created.statusCode).toBe(201)
    expect(created.json().conversation).toMatchObject({ status: 'ACTIVE', messageCount: 0 })
    const listed = await app.inject({ method: 'GET', url: '/api/chat/conversations' })
    expect(listed.json().conversations).toHaveLength(1)
  })

  it('streams a cited answer using only indexed enterprise knowledge', async () => {
    const seed = seedSnapshot()
    seed.assets.push(enterpriseAsset())
    seed.assetInputs['AST-PRODUCT'] = { content: '产品说明正文', mimeType: 'application/pdf' }
    seed.knowledge.push(enterpriseKnowledge())
    seed.knowledge.push(enterpriseKnowledge({ id: 'KNW-PENDING', title: '待索引资料', indexStatus: 'PENDING' }))
    const { app } = await fixture(seed)
    const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: {} })

    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${created.json().conversation.id}/messages/stream`,
      payload: { content: '部署需要多少张卡？', mode: 'CONCISE' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.body).toContain('event: progress')
    expect(response.body).toContain('event: complete')
    expect(response.body).toContain('4 张 A800')
    expect(response.body).toContain('"answerStatus":"SUPPORTED"')
    expect(response.body).not.toContain('待索引资料')
  })

  it('preserves image citation metadata for answers and material-search results', async () => {
    const imageContent = '智能外呼系统架构图：![系统架构图](/minio/public/docs/architecture.png "/minio/public/docs/previews/architecture.webp")。'
    const seed = seedSnapshot()
    seed.assets.push(enterpriseAsset({
      title: '智能外呼系统架构图.md',
      summary: imageContent,
    }))
    seed.assetInputs['AST-PRODUCT'] = { content: imageContent, mimeType: 'text/markdown' }
    seed.knowledge.push(enterpriseKnowledge({
      title: '智能外呼系统架构图',
      content: imageContent,
    }))
    const { app } = await fixture(seed)
    const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: {} })

    const answer = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${created.json().conversation.id}/messages`,
      payload: { content: '智能外呼系统架构图' },
    })
    expect(answer.statusCode).toBe(201)
    expect(answer.json().assistantMessage.citations[0]).toMatchObject({
      mediaType: 'IMAGE',
      imageUrl: '/minio/public/docs/architecture.png',
      previewUrl: '/minio/public/docs/previews/architecture.webp',
      imageAlt: '系统架构图',
    })

    const materialSearch = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${created.json().conversation.id}/messages`,
      payload: { content: '@查资料 智能外呼系统架构图', skillId: 'MATERIAL_SEARCH' },
    })
    expect(materialSearch.statusCode).toBe(201)
    expect(materialSearch.json().assistantMessage.citations[0]).toMatchObject({
      mediaType: 'IMAGE',
      imageUrl: '/minio/public/docs/architecture.png',
      previewUrl: '/minio/public/docs/previews/architecture.webp',
      imageAlt: '系统架构图',
    })

    const detail = await app.inject({
      method: 'GET',
      url: `/api/chat/conversations/${created.json().conversation.id}`,
    })
    expect(detail.json().messages.at(-1).citations[0]).toMatchObject({ mediaType: 'IMAGE' })
  })

  it('keeps pre-stream archive errors as normal HTTP responses', async () => {
    const { app } = await fixture()
    const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: {} })
    await app.inject({ method: 'POST', url: `/api/chat/conversations/${created.json().conversation.id}/archive` })
    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${created.json().conversation.id}/messages/stream`,
      payload: { content: '再问一次' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('CONVERSATION_ARCHIVED')
  })

  it('searches, downloads and revalidates an enterprise citation', async () => {
    const seed = seedSnapshot()
    seed.assets.push(
      enterpriseAsset(),
      enterpriseAsset({ id: 'AST-STALE', title: '过期资料.pdf', processStatus: 'PROCESSED' }),
    )
    seed.assetInputs['AST-PRODUCT'] = { content: '产品说明正文', mimeType: 'text/plain' }
    seed.assetInputs['AST-STALE'] = { content: '过期资料正文', mimeType: 'text/plain' }
    seed.knowledge.push(
      enterpriseKnowledge(),
      enterpriseKnowledge({ id: 'KNW-STALE', title: '过期资料', primaryAssetId: 'AST-STALE', status: 'STALE' }),
    )
    const { app } = await fixture(seed)
    const search = await app.inject({ method: 'GET', url: '/api/chat/materials/search?q=产品说明' })
    expect(search.statusCode).toBe(200)
    expect(search.json().materials).toHaveLength(1)
    const material = search.json().materials[0]
    expect(material).toMatchObject({
      id: 'AST-PRODUCT', status: 'PUBLISHED', approvalStatus: 'APPROVED', publicationStatus: 'PUBLISHED', type: '产品说明',
    })

    const downloaded = await app.inject({ method: 'GET', url: '/api/chat/materials/AST-PRODUCT/download' })
    expect(downloaded.statusCode).toBe(200)
    expect(downloaded.body).toBe('产品说明正文')
    expect(downloaded.headers['content-disposition']).toContain('filename*=UTF-8')

    const citation = await app.inject({ method: 'GET', url: `/api/citations/${material.citation.id}` })
    expect(citation.statusCode).toBe(200)
    expect(citation.json()).toMatchObject({ title: '产品部署要求', locator: 'page:2' })
    const open = await app.inject({ method: 'GET', url: `/api/citations/${material.citation.id}/open` })
    expect(open.statusCode).toBe(307)
    expect(open.headers.location).toBe('https://feishu.cn/docx/product-1')
  })

  it('attaches material results to a natural-language material search and restores them from history', async () => {
    const seed = seedSnapshot()
    const materials = [
      enterpriseAsset({ id: 'AST-PRODUCT', title: '产品说明 v3.2.pdf', businessType: 'PRODUCT_DOCUMENT' }),
      enterpriseAsset({ id: 'AST-BROCHURE', title: '产品宣传手册.pdf', businessType: 'PRODUCT_DOCUMENT', externalId: 'feishu-doc-2' }),
      enterpriseAsset({ id: 'AST-SOLUTION', title: '零售行业解决方案.pdf', businessType: 'SOLUTION', externalId: 'feishu-doc-3' }),
    ]
    seed.assets.push(...materials)
    materials.forEach((asset) => {
      seed.assetInputs[asset.id] = { content: `${asset.title}正文`, mimeType: 'application/pdf' }
      seed.knowledge.push(enterpriseKnowledge({
        id: `KNW-${asset.id}`,
        title: asset.title.replace('.pdf', ''),
        content: `${asset.title}正式内容。`,
        primaryAssetId: asset.id,
      }))
    })
    const { app } = await fixture(seed)
    const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: {} })
    const sent = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${created.json().conversation.id}/messages`,
      payload: { content: '找产品说明、宣传手册和解决方案' },
    })

    expect(sent.statusCode).toBe(201)
    expect(sent.json().assistantMessage).toMatchObject({
      content: '已找到 3 份符合条件的资料，仅展示已审核、已发布并完成索引的内容。',
      answerStatus: 'SUPPORTED',
    })
    expect(sent.json().assistantMessage.citations).toHaveLength(3)
    expect(sent.json().assistantMessage.materials).toHaveLength(3)
    expect(sent.json().assistantMessage.materials.map((material: { id: string }) => material.id)).toEqual(expect.arrayContaining([
      'AST-BROCHURE', 'AST-SOLUTION', 'AST-PRODUCT',
    ]))
    expect(sent.json().assistantMessage.materials.map((material: { type: string }) => material.type)).toEqual(expect.arrayContaining([
      '产品说明', '宣传手册', '解决方案',
    ]))

    const mentionOnly = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${created.json().conversation.id}/messages`,
      payload: { content: '@查资料', skillId: 'MATERIAL_SEARCH' },
    })
    expect(mentionOnly.statusCode).toBe(201)
    expect(mentionOnly.json().assistantMessage.materials).toHaveLength(3)

    const detail = await app.inject({ method: 'GET', url: `/api/chat/conversations/${created.json().conversation.id}` })
    expect(detail.json().messages.at(-1).materials).toHaveLength(3)
  })

  it('infers material search for a natural-language document lookup request', async () => {
    const { app } = await fixture()
    const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: {} })
    const sent = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${created.json().conversation.id}/messages`,
      payload: { content: '帮我查一下投标一体机相关文档' },
    })

    expect(sent.statusCode).toBe(201)
    expect(sent.json().assistantMessage.skillId).toBe('MATERIAL_SEARCH')
  })

  it('records explicit skill calls and keeps later-phase skills honest about availability', async () => {
    const { app } = await fixture()
    const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: {} })
    const sent = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${created.json().conversation.id}/messages`,
      payload: {
        content: '请生成一份客户汇报提纲',
        skillId: 'SOLUTION_DRAFT',
      },
    })

    expect(sent.statusCode).toBe(201)
    expect(sent.json().assistantMessage).toMatchObject({
      skillId: 'SOLUTION_DRAFT',
      answerStatus: 'INSUFFICIENT',
    })
    expect(sent.json().assistantMessage.content).toContain('第 2 阶段开放')
  })

  it('returns an explicit phase boundary for attachment uploads', async () => {
    const { app } = await fixture()
    const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: {} })
    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${created.json().conversation.id}/attachments`,
      headers: { 'content-type': 'multipart/form-data; boundary=phase-one' },
      payload: '--phase-one--',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatchObject({
      code: 'ATTACHMENTS_NOT_AVAILABLE',
      message: 'ATTACHMENTS_NOT_AVAILABLE',
    })
  })

  it('creates a permission-checked device share task without making a public link', async () => {
    const seed = seedSnapshot()
    seed.assets.push(enterpriseAsset())
    seed.assetInputs['AST-PRODUCT'] = { content: '产品说明正文', mimeType: 'text/plain' }
    seed.knowledge.push(enterpriseKnowledge())
    const { app, repository } = await fixture(seed)
    const shared = await app.inject({
      method: 'POST',
      url: '/api/chat/materials/AST-PRODUCT/distributions',
      payload: { channel: 'FEISHU' },
    })
    expect(shared.statusCode).toBe(201)
    expect(shared.json()).toMatchObject({
      distribution: { materialId: 'AST-PRODUCT', channel: 'FEISHU', mode: 'DEVICE_SHARE', status: 'READY' },
      requiresUserConfirmation: true,
      downloadUrl: '/api/chat/materials/AST-PRODUCT/download',
    })
    expect(shared.json().downloadUrl).not.toContain('http')
    expect((await repository.read()).distributionTasks).toHaveLength(1)

    const dingTalk = await app.inject({
      method: 'POST',
      url: '/api/chat/materials/AST-PRODUCT/distributions',
      payload: { channel: 'DINGTALK' },
    })
    expect(dingTalk.statusCode).toBe(400)
    expect(dingTalk.json().error.code).toBe('CHANNEL_NOT_AVAILABLE')
  })

  it('records feedback while preserving the conversation owner boundary', async () => {
    const seed = seedSnapshot()
    seed.assets.push(enterpriseAsset())
    seed.knowledge.push(enterpriseKnowledge())
    const { app, repository } = await fixture(seed)
    const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: {} })
    const sent = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${created.json().conversation.id}/messages`,
      payload: { content: '部署需要多少张卡？' },
    })
    const messageId = sent.json().assistantMessage.id
    const feedback = await app.inject({
      method: 'PUT',
      url: `/api/chat/messages/${messageId}/feedback`,
      payload: { rating: 'DISLIKE', reasonType: 'CONTENT_ERROR', reasonText: '请补充适用范围' },
    })
    expect(feedback.statusCode).toBe(200)
    expect(feedback.json()).toMatchObject({ messageId, feedbackRating: 'DISLIKE', feedbackReasonType: 'CONTENT_ERROR' })
    const stored = await repository.read()
    expect(stored.conversations[0].negativeFeedbackCount).toBe(1)
    expect(stored.messages.find((message) => message.id === messageId)?.feedback).toMatchObject({ helpful: false, type: 'WRONG' })
  })
})
