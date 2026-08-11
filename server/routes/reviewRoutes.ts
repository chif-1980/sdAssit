import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { ReviewService } from '../application/reviewService.js'

const reviewListQuery = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(['PENDING', 'RESOLVED', 'CANCELLED']).optional(),
  reviewType: z.enum(['NEW', 'UPDATE', 'CONFLICT', 'STALE']).optional(),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
}).strict()

const resolveReviewBody = z.object({
  action: z.enum([
    'CREATE_KNOWLEDGE',
    'UPDATE_KNOWLEDGE',
    'KEEP_CURRENT',
    'REJECT_CANDIDATE',
    'ARCHIVE_KNOWLEDGE',
    'CONFIRM_VALID',
  ]),
  finalContent: z.string().max(4000).optional(),
  decisionComment: z.string().trim().min(1).max(2000),
}).strict()

function invalidRequest() {
  return new Error('INVALID_REQUEST')
}

export function registerReviewRoutes(app: FastifyInstance, service: ReviewService) {
  app.get('/api/reviews', async (request) => {
    const parsed = reviewListQuery.safeParse(request.query)
    if (!parsed.success) throw invalidRequest()
    return { reviews: await service.listReviews(parsed.data) }
  })

  app.get<{ Params: { reviewId: string } }>('/api/reviews/:reviewId', async (request) => {
    return service.reviewDetail(request.params.reviewId)
  })

  app.post<{ Params: { reviewId: string } }>('/api/reviews/:reviewId/resolve', async (request) => {
    const parsed = resolveReviewBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    return service.resolve(request.params.reviewId, parsed.data)
  })
}
