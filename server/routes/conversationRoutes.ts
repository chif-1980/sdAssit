import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PlatformRepository } from '../application/ports.js'
import { ConversationService } from '../application/conversationService.js'

const scopeSchema = z.enum(['ENTERPRISE', 'SESSION', 'BOTH'])

const createConversationBody = z.object({
  scope: scopeSchema.default('ENTERPRISE'),
  title: z.string().trim().max(200).optional(),
  sessionAssetIds: z.array(z.string()).optional(),
}).strict()

const messageBody = z.object({
  text: z.string().trim().min(1),
  scope: scopeSchema.optional(),
  sessionAssetIds: z.array(z.string()).optional(),
}).strict()

function invalidRequest() {
  return new Error('INVALID_REQUEST')
}

export function registerConversationRoutes(app: FastifyInstance, repository: PlatformRepository) {
  const service = new ConversationService(repository)

  app.get('/api/conversations', async () => ({ conversations: await service.list() }))

  app.post('/api/conversations', async (request, reply) => {
    const parsed = createConversationBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    const conversation = await service.create(parsed.data)
    return reply.status(201).send({ conversation })
  })

  app.get<{ Params: { conversationId: string } }>('/api/conversations/:conversationId', async (request) => {
    return service.detail(request.params.conversationId)
  })

  app.post<{ Params: { conversationId: string } }>('/api/conversations/:conversationId/messages', async (request) => {
    const parsed = messageBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    return service.addMessage(request.params.conversationId, parsed.data)
  })

  app.post<{ Params: { conversationId: string } }>('/api/conversations/:conversationId/archive', async (request) => {
    return service.archive(request.params.conversationId)
  })
}
