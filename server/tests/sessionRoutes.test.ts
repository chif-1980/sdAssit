import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { JsonRepository } from '../adapters/jsonRepository.js'
import { buildApp } from '../app.js'
import { seedSnapshot } from '../seed.js'

const directories: string[] = []
const apps: ReturnType<typeof buildApp>[] = []

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-session-routes-'))
  directories.push(directory)
  const repository = new JsonRepository(join(directory, 'snapshot.json'), seedSnapshot())
  const app = buildApp(repository)
  await app.ready()
  apps.push(app)
  return { app, repository }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('session routes', () => {
  it('returns the current demo user and switches roles', async () => {
    const { app, repository } = await fixture()

    const initial = await app.inject({ method: 'GET', url: '/api/session' })
    expect(initial.statusCode).toBe(200)
    expect(initial.json()).toMatchObject({
      session: { userId: 'USR-EMPLOYEE', role: 'EMPLOYEE' },
      user: { id: 'USR-EMPLOYEE', name: '演示员工', role: 'EMPLOYEE' },
      users: expect.arrayContaining([
        { id: 'USR-OWNER', name: '知识负责人', role: 'OWNER' },
      ]),
    })

    const switched = await app.inject({
      method: 'PUT',
      url: '/api/session/role',
      payload: { role: 'OWNER' },
    })
    expect(switched.statusCode).toBe(200)
    expect(switched.json()).toMatchObject({
      session: { userId: 'USR-OWNER', role: 'OWNER' },
      user: { id: 'USR-OWNER', role: 'OWNER' },
    })
    expect((await repository.read()).session).toEqual({ userId: 'USR-OWNER', role: 'OWNER' })
  })

  it('rejects demo reset for an Employee', async () => {
    const { app } = await fixture()

    const response = await app.inject({ method: 'POST', url: '/api/demo/reset' })

    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('FORBIDDEN')
  })

  it('lets an Admin atomically restore the seed snapshot', async () => {
    const { app, repository } = await fixture()
    await app.inject({ method: 'PUT', url: '/api/session/role', payload: { role: 'ADMIN' } })
    await repository.transact((draft) => {
      draft.assets.push({
        id: 'AST-TEMP', title: '临时资料', assetType: 'DOCUMENT', businessType: 'OTHER',
        provider: 'LOCAL', externalId: 'temp', ownerId: 'USR-ADMIN', authority: 'L0',
        processStatus: 'NEW', createdAt: '2026-08-11T12:00:00.000Z',
        updatedAt: '2026-08-11T12:00:00.000Z', isSessionAsset: false, sections: [],
      })
    })

    const response = await app.inject({ method: 'POST', url: '/api/demo/reset' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      session: { userId: 'USR-EMPLOYEE', role: 'EMPLOYEE' },
      user: { id: 'USR-EMPLOYEE', role: 'EMPLOYEE' },
    })
    expect(await repository.read()).toEqual(seedSnapshot())
  })
})
