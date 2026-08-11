import Fastify from 'fastify'

import type { PlatformRepository } from './application/ports.js'

const badRequestCodes = new Set([
  'INVALID_DATA_FILE',
  'KNOWLEDGE_AUTHORITY_EXCEEDS_SOURCE',
  'REVIEW_ACTION_NOT_ALLOWED',
])

function classifyError(error: unknown) {
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
  void repository

  const app = Fastify()

  app.get('/api/health', async () => ({
    ok: true,
    provider: 'local-json',
  }))

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
