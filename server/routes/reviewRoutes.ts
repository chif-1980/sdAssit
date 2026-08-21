import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { ReviewService } from '../application/reviewService.js'

const reviewListQuery = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(['OPEN', 'PENDING', 'CHANGES_REQUESTED', 'RESOLVED', 'CANCELLED']).optional(),
  reviewType: z.enum(['NEW', 'UPDATE', 'CONFLICT', 'STALE']).optional(),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  problemTag: z.enum([
    'DUPLICATE', 'OVERLAP', 'CONFLICT', 'INSUFFICIENT_EVIDENCE', 'MISSING_SCOPE',
    'OUTDATED', 'OCR_ERROR', 'SOURCE_UNCLEAR',
  ]).optional(),
}).strict()

const resolveReviewBody = z.object({
  action: z.enum([
    'CREATE_KNOWLEDGE',
    'UPDATE_KNOWLEDGE',
    'KEEP_CURRENT',
    'REJECT_CANDIDATE',
    'ARCHIVE_KNOWLEDGE',
    'CONFIRM_VALID',
    'MARK_DUPLICATE',
    'SPLIT_BY_SCOPE',
    'MARK_INSUFFICIENT',
  ]),
  finalContent: z.string().max(4000).optional(),
  decisionComment: z.string().trim().min(1).max(2000),
  decision: z.enum(['PUBLISH', 'REQUEST_CHANGES', 'REJECT', 'TRANSFER']).optional(),
  problemTags: z.array(z.enum([
    'DUPLICATE', 'OVERLAP', 'CONFLICT', 'INSUFFICIENT_EVIDENCE', 'MISSING_SCOPE',
    'OUTDATED', 'OCR_ERROR', 'SOURCE_UNCLEAR',
  ])).optional(),
  applicability: z.object({
    industry: z.string().max(120).optional(),
    product: z.string().max(120).optional(),
    productVersion: z.string().max(120).optional(),
    deploymentMode: z.string().max(120).optional(),
    customerType: z.string().max(120).optional(),
    locale: z.string().max(120).optional(),
    effectiveFrom: z.string().datetime().optional(),
    effectiveTo: z.string().datetime().optional(),
  }).strict().optional(),
  assigneeId: z.string().min(1).optional(),
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

  app.get<{ Params: { reviewId: string } }>('/api/reviews/:reviewId/comparisons', async (request) => {
    const detail = await service.reviewDetail(request.params.reviewId)
    return { comparisons: detail.comparisons }
  })

  app.post<{ Params: { reviewId: string } }>('/api/reviews/:reviewId/resolve', async (request) => {
    const parsed = resolveReviewBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    return service.resolve(request.params.reviewId, parsed.data)
  })
}
