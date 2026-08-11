import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { ReviewService } from '../application/reviewService.js'

const knowledgeListQuery = z.object({
  q: z.string().max(200).optional(),
  category: z.enum([
    'PRODUCT_CAPABILITY',
    'PRODUCT_PARAMETER',
    'TECHNICAL',
    'FAQ',
    'PROCESS',
    'POLICY',
    'BEST_PRACTICE',
    'PROJECT',
    'OTHER',
  ]).optional(),
  status: z.enum(['ACTIVE', 'STALE', 'ARCHIVED']).optional(),
  authority: z.enum(['L0', 'L1', 'L2', 'L3']).optional(),
  ownerId: z.string().min(1).optional(),
  updatedFrom: z.string().datetime().optional(),
  updatedTo: z.string().datetime().optional(),
}).strict().refine(
  (value) => value.updatedFrom === undefined
    || value.updatedTo === undefined
    || value.updatedFrom <= value.updatedTo,
)

const requestUpdateBody = z.object({
  proposedContent: z.string().trim().min(1).max(4000),
  decisionComment: z.string().trim().min(1).max(2000),
}).strict()

function invalidRequest() {
  return new Error('INVALID_REQUEST')
}

export function registerKnowledgeRoutes(app: FastifyInstance, service: ReviewService) {
  app.get('/api/knowledge', async (request) => {
    const parsed = knowledgeListQuery.safeParse(request.query)
    if (!parsed.success) throw invalidRequest()
    return { knowledge: await service.listKnowledge(parsed.data) }
  })

  app.get<{ Params: { knowledgeId: string } }>('/api/knowledge/:knowledgeId', async (request) => {
    return service.knowledgeDetail(request.params.knowledgeId)
  })

  app.post<{ Params: { knowledgeId: string } }>('/api/knowledge/:knowledgeId/request-update', async (request, reply) => {
    const parsed = requestUpdateBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    const review = await service.requestUpdate(
      request.params.knowledgeId,
      parsed.data.proposedContent,
      parsed.data.decisionComment,
    )
    return reply.status(201).send({ review })
  })

  app.post<{ Params: { knowledgeId: string } }>('/api/knowledge/:knowledgeId/reindex', async (request) => {
    return service.reindex(request.params.knowledgeId)
  })
}
