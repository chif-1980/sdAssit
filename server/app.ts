import Fastify from 'fastify'

import type { PlatformRepository } from './application/ports.js'
import { registerAssetRoutes } from './routes/assetRoutes.js'

const badRequestCodes = new Set([
  'INVALID_DATA_FILE',
  'INVALID_REQUEST',
  'KNOWLEDGE_AUTHORITY_EXCEEDS_SOURCE',
  'REVIEW_ACTION_NOT_ALLOWED',
])

function classifyError(error: unknown) {
  const statusCode = typeof error === 'object' && error !== null
    && 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined

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
  if (code === 'CONFLICT' || code.endsWith('_CONFLICT')) return { code, status: 409 }
  if (badRequestCodes.has(code)) return { code, status: 400 }
  return { code: 'INTERNAL_ERROR', status: 500 }
}

export function buildApp(repository: PlatformRepository) {
  const app = Fastify()

  app.get('/api/health', async () => ({
    ok: true,
    provider: 'local-json',
  }))

  registerAssetRoutes(app, repository)

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

    reply.status(status).send({
      error: {
        code,
        message: code,
        details: {},
      },
    })
  })

  return app
}
