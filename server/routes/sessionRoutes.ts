import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PlatformSnapshot } from '../../shared/domain/models.js'
import type { PlatformRepository } from '../application/ports.js'
import { seedSnapshot } from '../seed.js'

const switchRoleBody = z.object({
  role: z.enum(['EMPLOYEE', 'OWNER', 'ADMIN']),
}).strict()

function invalidRequest() {
  return new Error('INVALID_REQUEST')
}

function sessionPayload(snapshot: PlatformSnapshot) {
  const user = snapshot.users.find((item) => item.id === snapshot.session.userId)
  if (!user) throw new Error('USER_NOT_FOUND')
  return { session: snapshot.session, user, users: snapshot.users }
}

export function registerSessionRoutes(app: FastifyInstance, repository: PlatformRepository) {
  app.get('/api/session', async () => sessionPayload(await repository.read()))

  app.put('/api/session/role', async (request) => {
    const parsed = switchRoleBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()

    await repository.transact((draft) => {
      const user = draft.users.find((item) => item.role === parsed.data.role)
      if (!user) throw new Error('USER_NOT_FOUND')
      draft.session = { userId: user.id, role: user.role }
    })
    return sessionPayload(await repository.read())
  })

  app.post('/api/demo/reset', async () => {
    const current = await repository.read()
    if (current.session.role !== 'ADMIN') throw new Error('FORBIDDEN')

    await repository.transact((draft) => {
      Object.assign(draft, structuredClone(seedSnapshot()))
    })
    return sessionPayload(await repository.read())
  })
}
