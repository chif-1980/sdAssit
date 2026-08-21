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
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-cross-document-'))
  directories.push(directory)
  const snapshot = seedSnapshot()
  snapshot.session = { userId: 'USR-OWNER', role: 'OWNER' }
  snapshot.users.push({ id: 'USR-OWNER-2', name: '另一位负责人', role: 'OWNER' })
  const repository = new JsonRepository(join(directory, 'snapshot.json'), snapshot)
  const app = buildApp(repository)
  await app.ready()
  apps.push(app)
  return { app, repository }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createAndProcess(app: ReturnType<typeof buildApp>, title: string, content: string) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/assets',
    payload: {
      title,
      assetType: 'DOCUMENT',
      businessType: 'PRODUCT_DOCUMENT',
      ownerId: 'USR-OWNER',
      content,
      mimeType: 'text/plain',
    },
  })
  const id = created.json().asset.id as string
  return app.inject({ method: 'POST', url: `/api/assets/${id}/process` })
}

describe('cross-document governance', () => {
  it('keeps same content in different industries as conditional variants', async () => {
    const { app, repository } = await fixture()
    const first = await createAndProcess(app, '制造业方案', '平台必须支持私有化部署。')
    const firstReviewId = first.json().reviews[0].id as string
    await app.inject({
      method: 'POST',
      url: `/api/reviews/${firstReviewId}/resolve`,
      payload: {
        action: 'CREATE_KNOWLEDGE',
        decision: 'PUBLISH',
        applicability: { industry: '制造业', deploymentMode: '私有化部署', locale: 'zh-CN' },
        finalContent: '平台必须支持私有化部署。',
        decisionComment: '发布通用能力的制造业适用版本',
      },
    })

    const second = await createAndProcess(app, '金融方案', '平台必须支持私有化部署。')
    expect(second.json().candidates[0]).toMatchObject({ relation: 'NEW', status: 'PENDING' })
    expect(second.json().reviews[0]).toMatchObject({ reviewType: 'NEW' })
    const comparisonResponse = await app.inject({ method: 'GET', url: `/api/reviews/${second.json().reviews[0].id}/comparisons` })
    expect(comparisonResponse.statusCode).toBe(200)
    expect(comparisonResponse.json().comparisons).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationType: 'CONDITIONAL_VARIANT' }),
    ]))
    const stored = await repository.read()
    expect(stored.crossDocumentRelations?.some((relation) => relation.relationType === 'CONDITIONAL_VARIANT')).toBe(true)
  })

  it('aliases exact duplicates within the same applicability scope', async () => {
    const { app, repository } = await fixture()
    const first = await createAndProcess(app, '制造业方案', '平台必须支持私有化部署。')
    await app.inject({
      method: 'POST',
      url: `/api/reviews/${first.json().reviews[0].id}/resolve`,
      payload: {
        action: 'CREATE_KNOWLEDGE',
        decision: 'PUBLISH',
        applicability: { industry: '制造业', deploymentMode: '私有化部署', locale: 'zh-CN' },
        finalContent: '平台必须支持私有化部署。',
        decisionComment: '发布',
      },
    })
    const duplicate = await createAndProcess(app, '制造业方案副本', '平台必须支持私有化部署。')
    expect(duplicate.json().candidates[0]).toMatchObject({ relation: 'DUPLICATE', status: 'REJECTED' })
    expect(duplicate.json().reviews).toHaveLength(0)
    const stored = await repository.read()
    expect(stored.knowledge[0].aliasAssetIds).toContain(duplicate.json().asset.id)
  })

  it('supports request-changes and transfer without publishing', async () => {
    const { app, repository } = await fixture()
    const created = await createAndProcess(app, '待补充方案', '平台必须支持私有化部署。')
    const reviewId = created.json().reviews[0].id as string
    const requested = await app.inject({
      method: 'POST',
      url: `/api/reviews/${reviewId}/resolve`,
      payload: {
        action: 'MARK_INSUFFICIENT',
        decision: 'REQUEST_CHANGES',
        problemTags: ['INSUFFICIENT_EVIDENCE'],
        decisionComment: '请补充适用行业和版本信息',
      },
    })
    expect(requested.statusCode).toBe(200)
    expect(requested.json().review).toMatchObject({ status: 'CHANGES_REQUESTED', decision: 'REQUEST_CHANGES' })
    expect(requested.json().candidate.status).toBe('NEEDS_CHANGES')

    const transferred = await app.inject({
      method: 'POST',
      url: `/api/reviews/${reviewId}/resolve`,
      payload: {
        action: 'MARK_INSUFFICIENT',
        decision: 'TRANSFER',
        assigneeId: 'USR-OWNER-2',
        decisionComment: '转交行业负责人确认',
      },
    })
    expect(transferred.statusCode).toBe(200)
    expect(transferred.json().review).toMatchObject({ status: 'PENDING', reviewerId: 'USR-OWNER-2', decision: 'TRANSFER' })
    expect((await repository.read()).knowledge).toHaveLength(0)
  })
})
