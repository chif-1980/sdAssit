import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { Knowledge } from '../../shared/domain/models.js'
import { JsonRepository } from '../adapters/jsonRepository.js'
import { buildApp } from '../app.js'
import { seedSnapshot } from '../seed.js'

const directories: string[] = []
const apps: ReturnType<typeof buildApp>[] = []
const timestamp = '2026-08-11T12:00:00.000Z'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-audit-flow-'))
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

describe('audit and source integrity', () => {
  it('only lets an admin read audit logs and records key session/conversation actions', async () => {
    const { app } = await fixture()
    const denied = await app.inject({ method: 'GET', url: '/api/audit-logs' })
    expect(denied.statusCode).toBe(403)

    await app.inject({ method: 'PUT', url: '/api/session/role', payload: { role: 'ADMIN' } })
    const created = await app.inject({ method: 'POST', url: '/api/conversations', payload: { scope: 'ENTERPRISE' } })
    const conversationId = created.json().conversation.id
    await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, payload: { text: '测试审计' } })
    const response = await app.inject({ method: 'GET', url: '/api/audit-logs?resourceType=conversation' })

    expect(response.statusCode).toBe(200)
    expect(response.json().logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'conversation.create', resourceId: conversationId, outcome: 'SUCCESS' }),
      expect.objectContaining({ action: 'conversation.message_add', resourceId: conversationId, outcome: 'SUCCESS' }),
    ]))
  })

  it('does not answer from active indexed knowledge whose primary source is missing or unprocessed', async () => {
    const seed = seedSnapshot()
    const knowledge: Knowledge = {
      id: 'KNW-ORPHAN', title: '孤立资料', content: '孤立资料中的答案。', category: 'FAQ', tags: [],
      authority: 'L1', ownerId: 'USR-OWNER', primaryAssetId: 'AST-MISSING', supportingAssetIds: [],
      sourceLocator: 'paragraph:1', status: 'ACTIVE', version: 1, lastVerifiedAt: timestamp,
      aiEnabled: true, indexStatus: 'INDEXED', createdAt: timestamp, updatedAt: timestamp,
    }
    seed.knowledge.push(knowledge)
    const directory = await mkdtemp(join(tmpdir(), 'knowledge-source-integrity-'))
    directories.push(directory)
    const repository = new JsonRepository(join(directory, 'snapshot.json'), seed)
    const app = buildApp(repository)
    await app.ready()
    apps.push(app)

    const created = await app.inject({ method: 'POST', url: '/api/conversations', payload: { scope: 'ENTERPRISE' } })
    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${created.json().conversation.id}/messages`,
      payload: { text: '孤立资料中的答案是什么？' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().answer).toMatchObject({ confidence: 'INSUFFICIENT', citations: [] })
  })
})
