import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { listAuditLogs } from '../application/auditService.js'
import type { PlatformRepository } from '../application/ports.js'

const querySchema = z.object({
  action: z.string().max(120).optional(),
  resourceType: z.string().max(80).optional(),
  resourceId: z.string().max(200).optional(),
  outcome: z.enum(['SUCCESS', 'FAILURE']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict()

export function registerAuditRoutes(app: FastifyInstance, repository: PlatformRepository) {
  app.get('/api/audit-logs', async (request) => {
    const parsed = querySchema.safeParse(request.query)
    if (!parsed.success) throw new Error('INVALID_REQUEST')
    return { logs: listAuditLogs(await repository.read(), parsed.data) }
  })
}
