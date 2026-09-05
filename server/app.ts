import Fastify from 'fastify'

import { LocalIndexer } from './adapters/localIndexer.js'
import type { KnowledgeIndexer, PlatformRepository } from './application/ports.js'
import { ReviewService } from './application/reviewService.js'
import { registerAssetRoutes } from './routes/assetRoutes.js'
import { registerConversationRoutes } from './routes/conversationRoutes.js'
import { registerKnowledgeRoutes } from './routes/knowledgeRoutes.js'
import { registerProductChatRoutes } from './routes/productChatRoutes.js'
import { registerReviewRoutes } from './routes/reviewRoutes.js'
import { registerSessionRoutes } from './routes/sessionRoutes.js'

const badRequestCodes = new Set([
  'INVALID_DATA_FILE',
  'INVALID_REQUEST',
  'FINAL_CONTENT_REQUIRED',
  'KNOWLEDGE_AUTHORITY_EXCEEDS_SOURCE',
  'REVIEW_ACTION_NOT_ALLOWED',
  'ASSET_NOT_PROCESSED',
  'DECISION_COMMENT_REQUIRED',
  'ASSIGNEE_NOT_FOUND',
  'INVALID_APPLICABILITY_SCOPE',
  'ATTACHMENTS_NOT_AVAILABLE',
  'ATTACHMENT_TOO_LARGE',
  'CHANNEL_NOT_AVAILABLE',
  'QUESTION_NOT_CURRENT',
  'RUN_NOT_WAITING_FOR_INPUT',
])

function classifyError(error: unknown) {
  const errorRecord = typeof error === 'object' && error !== null ? error as Record<string, unknown> : undefined
  const explicitStatus = typeof errorRecord?.status === 'number' ? errorRecord.status : undefined
  const explicitCode = typeof errorRecord?.code === 'string' ? errorRecord.code : undefined
  const statusCode = typeof error === 'object' && error !== null
    && 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined

  if (explicitStatus !== undefined && explicitStatus >= 400 && explicitStatus < 600 && explicitCode) {
    return { code: explicitCode, status: explicitStatus }
  }
  if (explicitCode?.startsWith('YUXI_')) {
    return { code: explicitCode, status: explicitStatus ?? 503 }
  }

  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    if (statusCode === 403) return { code: 'FORBIDDEN', status: 403 }
    if (statusCode === 404) return { code: 'NOT_FOUND', status: 404 }
    return { code: 'INVALID_REQUEST', status: statusCode }
  }

  if (!(error instanceof Error)) {
    return { code: 'INTERNAL_ERROR', status: 500 }
  }

  const code = error.message
  if (code === 'FORBIDDEN') return { code, status: 403 }
  if (code === 'NOT_FOUND' || code.endsWith('_NOT_FOUND')) return { code, status: 404 }
  if (code === 'REVIEW_ALREADY_RESOLVED') return { code, status: 409 }
  if (code === 'CONVERSATION_ARCHIVED' || code === 'ASSET_ALREADY_PROMOTED') return { code, status: 409 }
  if (code === 'SOLUTION_DRAFT_NOT_READY') return { code, status: 409 }
  if (code === 'SOURCE_NOT_AVAILABLE') return { code, status: 404 }
  if (code === 'CONFLICT' || code.endsWith('_CONFLICT')) return { code, status: 409 }
  if (badRequestCodes.has(code)) return { code, status: 400 }
  return { code: 'INTERNAL_ERROR', status: 500 }
}

export function buildApp(repository: PlatformRepository, indexer: KnowledgeIndexer = new LocalIndexer()) {
  const app = Fastify()
  const reviewService = new ReviewService(repository, indexer)

  app.get('/api/health', async () => ({
    ok: true,
    provider: 'local-json',
  }))

  registerAssetRoutes(app, repository)
  registerConversationRoutes(app, repository)
  registerProductChatRoutes(app, repository)
  registerReviewRoutes(app, reviewService)
  registerKnowledgeRoutes(app, reviewService)
  registerSessionRoutes(app, repository)

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'NOT_FOUND',
        details: {},
      },
    })
  })

  app.setErrorHandler((error, _request, reply) => {
    const { code, status } = classifyError(error)
    const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
    const message = typeof value.code === 'string' && typeof value.status === 'number'
      && error instanceof Error && error.message && error.message !== code
      ? error.message
      : code
    const details = value.details && typeof value.details === 'object' ? value.details : {}

    reply.status(status).send({
      error: {
        code,
        message,
        details,
        ...(typeof value.runId === 'string' ? { runId: value.runId } : {}),
        ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
      },
    })
  })

  return app
}
