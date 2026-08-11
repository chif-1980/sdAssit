import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PlatformRepository } from '../application/ports.js'
import { AssetService } from '../application/assetService.js'

const createAssetBody = z.object({
  title: z.string().min(1).max(200),
  assetType: z.enum(['DOCUMENT', 'AUDIO', 'VIDEO', 'IMAGE']),
  businessType: z.enum([
    'PRODUCT_DOCUMENT', 'SOLUTION', 'POLICY', 'PROCESS', 'TRAINING',
    'CUSTOMER_MEETING', 'INTERNAL_MEETING', 'PROJECT_DOCUMENT', 'SESSION_UPLOAD', 'OTHER',
  ]),
  ownerId: z.string().min(1),
  content: z.string(),
  mimeType: z.string().min(1),
  isSessionAsset: z.boolean().default(false),
}).strict()

const promoteAssetBody = z.object({
  businessType: z.enum([
    'PRODUCT_DOCUMENT', 'SOLUTION', 'POLICY', 'PROCESS', 'TRAINING',
    'CUSTOMER_MEETING', 'INTERNAL_MEETING', 'PROJECT_DOCUMENT', 'OTHER',
  ]),
  ownerId: z.string().min(1),
}).strict()

function invalidRequest() {
  return new Error('INVALID_REQUEST')
}

export function registerAssetRoutes(app: FastifyInstance, repository: PlatformRepository) {
  const service = new AssetService(repository)

  app.get('/api/assets', async () => ({ assets: await service.list() }))

  app.post('/api/assets', async (request, reply) => {
    const parsed = createAssetBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    const asset = await service.create(parsed.data)
    return reply.status(201).send({ asset })
  })

  app.get<{ Params: { assetId: string } }>('/api/assets/:assetId', async (request) => {
    return service.detail(request.params.assetId)
  })

  app.post<{ Params: { assetId: string } }>('/api/assets/:assetId/process', async (request) => {
    return service.process(request.params.assetId)
  })

  app.post<{ Params: { assetId: string } }>('/api/assets/:assetId/promote', async (request) => {
    const parsed = promoteAssetBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    const result = await service.promote(request.params.assetId, parsed.data)
    return { asset: result.asset }
  })
}
