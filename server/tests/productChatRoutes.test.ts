import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { Asset, Conversation, Knowledge, PlatformSnapshot } from '../../shared/domain/models.js'
import { JsonRepository } from '../adapters/jsonRepository.js'
import { buildApp } from '../app.js'
import { imageCitationFromText } from '../application/conversationService.js'
import { createAgentSolutionDraft } from '../application/solutionDraftService.js'
import {
  buildSolutionResumeContent,
  createSolutionStreamState,
  solutionSafeStreamDelta,
  splitSolutionStreamText,
} from '../routes/productChatRoutes.js'
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
  it('splits aggregated solution body deltas into independently paintable updates', () => {
    const state = createSolutionStreamState()
    const raw = JSON.stringify({
      executive_summary: '这是一个较长的方案摘要，用于验证单个运行事件中的聚合正文会被拆成多次可见更新，而不是一次性刷出。还要保留段落顺序、中文标点和原始内容，确保浏览器可以逐段渲染。',
      tool_args: '不得展示',
    })
    const safe = solutionSafeStreamDelta(raw, state)
    const chunks = splitSolutionStreamText(safe)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(safe)
    expect(chunks.join('')).not.toContain('executive_summary')
    expect(chunks.join('')).not.toContain('不得展示')
  })

  it('keeps every clarification answer when a solution run is resumed repeatedly', () => {
    expect(buildSolutionResumeContent('设计投标方案', ['客户是轨交集团', '需要国产化部署'])).toBe(
      '设计投标方案\n\n补充信息：\n客户是轨交集团\n需要国产化部署',
    )
    expect(buildSolutionResumeContent('设计投标方案', ['  ', '客户是轨交集团'])).toBe(
      '设计投标方案\n\n补充信息：\n客户是轨交集团',
    )
  })

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

  it('uses a visible fallback label for legacy conversations with an empty title', async () => {
    const seed = seedSnapshot()
    const legacyConversation: Conversation = {
      id: 'CVS-EMPTY-TITLE',
      title: '  ',
      userId: 'USR-EMPLOYEE',
      scope: 'ENTERPRISE',
      sessionAssetIds: [],
      status: 'ACTIVE',
      messageCount: 0,
      negativeFeedbackCount: 0,
      hasOpenIssue: false,
      createdAt: timestamp,
      lastActiveAt: timestamp,
    }
    seed.conversations.push(legacyConversation)
    const { app } = await fixture(seed)

    const listed = await app.inject({ method: 'GET', url: '/api/chat/conversations' })

    expect(listed.statusCode).toBe(200)
    expect(listed.json().conversations).toMatchObject([{ id: 'CVS-EMPTY-TITLE', title: '未命名会话' }])
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

  it('records explicit solution-draft skill calls and returns a structured blocked draft when evidence is absent', async () => {
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
      solutionDraft: {
        status: 'BLOCKED',
        quality: { status: 'BLOCKED', evidenceCoverage: 0 },
        capabilityMatches: [{ matchType: 'UNKNOWN', deliveryStatus: 'UNKNOWN' }],
        confidenceSummary: { enterpriseCoverage: 0, evidenceCoverage: 0 },
      },
    })
    expect(sent.json().assistantMessage.content).toContain('草稿状态：BLOCKED')
  })

  it('normalizes the snake_case payload emitted by the Yuxi solution skill', async () => {
    const seed = seedSnapshot()
    seed.assets.push(enterpriseAsset())
    seed.knowledge.push(enterpriseKnowledge())
    const draft = createAgentSolutionDraft(seed, 'CONV-AGENT', 'RUN-AGENT', JSON.stringify({
      title: '投标一体机方案',
      customer_context: '客户需要一体机部署方案',
      executive_summary: '基于已发布产品资料形成初稿。',
      requirements: [{ id: 'REQ-1', text: '完成一体机部署' }],
      sections: [
        { id: 'SEC-1', title: '执行摘要', content_markdown: '摘要正文', requirement_ids: ['REQ-1'], citation_ids: ['CIT-1'] },
        { id: 'SEC-2', title: '需求与范围', content_markdown: '范围正文', requirement_ids: ['REQ-1'], citation_ids: ['CIT-1'] },
        { id: 'SEC-3', title: '方案设计', content_markdown: '设计正文', requirement_ids: ['REQ-1'], citation_ids: ['CIT-1'] },
        { id: 'SEC-4', title: '实施计划', content_markdown: '计划正文', requirement_ids: ['REQ-1'], citation_ids: ['CIT-1'] },
        { id: 'SEC-5', title: '风险与待确认', content_markdown: '风险正文', requirement_ids: ['REQ-1'], citation_ids: ['CIT-1'] },
      ],
      assumptions: [],
      open_questions: [],
      risks: [],
      conflicts: [],
      evidence_gaps: [],
      citations: [{ id: 'CIT-1', title: '产品说明', locator: 'page:2', excerpt: '标准部署最低需要 4 张 A800。', source_url: 'https://feishu.cn/docx/product-1' }],
    }))

    expect(draft).toMatchObject({
      title: '投标一体机方案',
      customerContext: '客户需要一体机部署方案',
      executiveSummary: '基于已发布产品资料形成初稿。',
      status: 'NEEDS_REVIEW',
      quality: { status: 'NEEDS_REVIEW', evidenceCoverage: 1 },
    })
    expect(draft.sections[0]).toMatchObject({ contentMarkdown: '摘要正文', requirementIds: ['REQ-1'], citationIds: ['CIT-1'] })
    expect(draft.citations[0].sourceUrl).toBe('https://feishu.cn/docx/product-1')
    expect(draft.quality).not.toHaveProperty('confidenceSummary')
    expect(draft.confidenceSummary).toMatchObject({ evidenceCoverage: 1 })
  })

  it('keeps rich risk details and exposes missing capability matches as review items', () => {
    const draft = createAgentSolutionDraft(seedSnapshot(), 'CONV-AGENT', 'RUN-RICH', {
      title: '语音智控国产化方案',
      executive_summary: '基于正式资料形成的方案初稿。',
      requirements: [{ id: 'REQ-1', text: '完成国产化部署' }],
      sections: [{
        id: 'SEC-1',
        title: '总体架构',
        content_markdown: '分层架构与适配策略。',
        citation_ids: ['CIT-1'],
      }],
      risks: [{ id: 'RISK-1', description: '型号尚未确认', mitigation: '建立兼容性矩阵' }],
      citations: [{ id: 'CIT-1', title: '产品白皮书', locator: '第 1 页', excerpt: '正式资料' }],
    })

    expect(draft.status).toBe('NEEDS_REVIEW')
    expect(draft.risks).toEqual(['型号尚未确认（缓解措施：建立兼容性矩阵）'])
    expect(draft.capabilityMatches?.[0]).toMatchObject({
      requirementId: 'REQ-1',
      matchType: 'UNKNOWN',
      reviewRequired: true,
    })
    expect(draft.architecture).toMatchObject({ sourceSectionId: 'SEC-1' })
  })

  it('accepts a session attachment for solution drafting', async () => {
    const { app } = await fixture()
    const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: {} })
    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${created.json().conversation.id}/attachments`,
      headers: { 'content-type': 'multipart/form-data; boundary=solution-draft-test' },
      payload: [
        '--solution-draft-test',
        'Content-Disposition: form-data; name="file"; filename="方案.md"',
        'Content-Type: text/markdown',
        '',
        '# 方案',
        '--solution-draft-test--',
        '',
      ].join('\r\n'),
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().attachment).toMatchObject({
      name: '方案.md',
      mimeType: 'text/markdown',
      status: 'READY',
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
