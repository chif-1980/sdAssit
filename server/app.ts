import Fastify from 'fastify'

import type { PlatformRepository } from './application/ports.js'

export function buildApp(repository: PlatformRepository) {
  void repository

  const app = Fastify()

  app.get('/api/health', async () => ({
    ok: true,
    provider: 'local-json',
  }))

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error && error.message.length > 0
      ? error.message
      : 'INTERNAL_ERROR'
    const code = /^[A-Z][A-Z0-9_]*$/.test(message) ? message : 'INTERNAL_ERROR'

    reply.status(code === 'FORBIDDEN' ? 403 : 400).send({
      error: {
        code,
        message: code,
        details: {},
      },
    })
  })

  return app
}
