import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { ProductChatService } from '../application/productChatService.js'
import type { PlatformRepository } from '../application/ports.js'

const emptyBody = z.object({}).strict()
const messageBody = z.object({
  content: z.string().trim().min(1).max(12000),
  mode: z.enum(['CONCISE', 'DETAILED']).optional(),
  attachmentIds: z.array(z.string().min(1)).max(5).optional(),
  skillId: z.enum(['MATERIAL_SEARCH', 'SOLUTION_DRAFT', 'MEETING_ANALYSIS']).optional(),
}).strict()
const materialSearchQuery = z.object({ q: z.string().trim().max(200).optional() }).strict()
const distributionBody = z.object({
  channel: z.enum(['WECHAT', 'FEISHU', 'DINGTALK']),
}).strict()
const feedbackBody = z.object({
  rating: z.enum(['LIKE', 'DISLIKE']).nullable(),
  reasonType: z.enum(['CONTENT_ERROR', 'OUTDATED', 'MISSING_SOURCE', 'CITATION_ERROR', 'OTHER']).optional(),
  reasonText: z.string().trim().max(2000).optional(),
}).strict()

// The composer keeps its existing attachment affordance for the later
// solution/meeting phases. Register a lightweight multipart parser now so a
// phase-1 upload receives an intentional, machine-readable response instead
// of Fastify's generic 415 error.
const multipartContentType = /^multipart\/form-data(?:;.*)?$/u

function invalidRequest() {
  return new Error('INVALID_REQUEST')
}

function writeEvent(raw: NodeJS.WritableStream, event: string, payload: unknown) {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function safeFileName(title: string) {
  const normalized = title.replace(/[\\/:*?"<>|\u0000-\u001F]/gu, '-').trim() || 'material'
  return normalized.length > 180 ? normalized.slice(0, 180) : normalized
}

export function registerProductChatRoutes(app: FastifyInstance, repository: PlatformRepository) {
  const service = new ProductChatService(repository)

  app.addContentTypeParser(
    multipartContentType,
    { parseAs: 'buffer', bodyLimit: 100 * 1024 * 1024 },
    (_request, _body, done) => done(null, undefined),
  )

  app.get('/api/chat/skills', async () => service.skills())

  app.get('/api/chat/conversations', async () => ({ conversations: await service.listConversations() }))

  app.post('/api/chat/conversations', async (request, reply) => {
    const parsed = emptyBody.safeParse(request.body ?? {})
    if (!parsed.success) throw invalidRequest()
    return reply.status(201).send({ conversation: await service.createConversation() })
  })

  app.get<{ Params: { conversationId: string } }>('/api/chat/conversations/:conversationId', async (request) => {
    return service.detail(request.params.conversationId)
  })

  app.post<{ Params: { conversationId: string } }>('/api/chat/conversations/:conversationId/attachments', async () => {
    throw new Error('ATTACHMENTS_NOT_AVAILABLE')
  })

  app.post<{ Params: { conversationId: string } }>('/api/chat/conversations/:conversationId/messages', async (request, reply) => {
    const parsed = messageBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    if (parsed.data.attachmentIds?.length) throw new Error('ATTACHMENTS_NOT_AVAILABLE')
    return reply.status(201).send(await service.addMessage(request.params.conversationId, parsed.data.content, parsed.data.skillId))
  })

  app.post<{ Params: { conversationId: string } }>('/api/chat/conversations/:conversationId/messages/stream', async (request, reply) => {
    const parsed = messageBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    if (parsed.data.attachmentIds?.length) throw new Error('ATTACHMENTS_NOT_AVAILABLE')

    // Validate ownership and archive state before switching to an SSE response,
    // so ordinary HTTP errors keep their useful status codes.
    const existing = await service.detail(request.params.conversationId)
    if (existing.conversation.status !== 'ACTIVE') throw new Error('CONVERSATION_ARCHIVED')

    reply.hijack()
    reply.raw.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    })

    try {
      const progress = [
        { stage: 'UNDERSTANDING', message: '正在理解问题' },
        { stage: 'RETRIEVING', message: '正在检索已审核资料' },
        { stage: 'VERIFYING', message: '正在核验引用与权限' },
        { stage: 'COMPOSING', message: '正在组织回答' },
      ] as const
      for (const item of progress) writeEvent(reply.raw, 'progress', item)
      const result = await service.addMessage(request.params.conversationId, parsed.data.content, parsed.data.skillId)
      writeEvent(reply.raw, 'complete', result)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INTERNAL_ERROR'
      const message = code === 'CONVERSATION_ARCHIVED'
        ? '当前会话已归档，请恢复后再发送'
        : code === 'ATTACHMENTS_NOT_AVAILABLE'
          ? '当前阶段暂不支持附件处理'
          : '知识服务暂时不可用，请稍后重试'
      writeEvent(reply.raw, 'error', { code, message })
    } finally {
      reply.raw.end()
    }
  })

  app.post<{ Params: { conversationId: string } }>('/api/chat/conversations/:conversationId/archive', async (request, reply) => {
    await service.archive(request.params.conversationId)
    return reply.status(204).send()
  })

  app.post<{ Params: { conversationId: string } }>('/api/chat/conversations/:conversationId/restore', async (request, reply) => {
    return reply.send({ conversation: await service.restore(request.params.conversationId) })
  })

  app.get('/api/chat/materials/search', async (request) => {
    const parsed = materialSearchQuery.safeParse(request.query)
    if (!parsed.success) throw invalidRequest()
    return { materials: await service.searchMaterials(parsed.data.q) }
  })

  app.get<{ Params: { assetId: string } }>('/api/chat/materials/:assetId/download', async (request, reply) => {
    const result = await service.downloadMaterial(request.params.assetId)
    reply
      .type(result.mimeType)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(result.asset.title))}`)
      .header('cache-control', 'private, no-store')
    return reply.send(Buffer.from(result.content, 'utf8'))
  })

  app.post<{ Params: { assetId: string } }>('/api/chat/materials/:assetId/distributions', async (request, reply) => {
    const parsed = distributionBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    return reply.status(201).send(await service.createDistribution(request.params.assetId, parsed.data.channel))
  })

  app.put<{ Params: { messageId: string } }>('/api/chat/messages/:messageId/feedback', async (request) => {
    const parsed = feedbackBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    return service.updateFeedback(request.params.messageId, parsed.data)
  })

  app.get<{ Params: { citationId: string } }>('/api/citations/:citationId', async (request) => {
    return service.resolveCitation(request.params.citationId)
  })

  app.get<{ Params: { citationId: string } }>('/api/citations/:citationId/open', async (request, reply) => {
    const result = await service.openCitation(request.params.citationId)
    return reply.code(307).header('location', result.sourceUrl).send()
  })
}
