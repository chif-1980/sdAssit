import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { PlatformSnapshot } from '../../shared/domain/models.js'
import { JsonRepository } from '../adapters/jsonRepository.js'
import { buildApp } from '../app.js'
import { seedSnapshot } from '../seed.js'

const temporaryDirectories: string[] = []

function testSeed(): PlatformSnapshot {
  return {
    version: 1,
    session: { userId: 'USR-EMPLOYEE', role: 'EMPLOYEE' },
    users: [
      { id: 'USR-EMPLOYEE', name: 'Employee', role: 'EMPLOYEE' },
      { id: 'USR-OWNER', name: 'Owner', role: 'OWNER' },
      { id: 'USR-ADMIN', name: 'Admin', role: 'ADMIN' },
    ],
    assets: [],
    candidates: [],
    knowledge: [],
    reviews: [],
    conversations: [],
    messages: [],
    assetInputs: {},
  }
}

async function temporaryFile() {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-json-repository-'))
  temporaryDirectories.push(directory)
  return { directory, file: join(directory, 'knowledge-platform.json') }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('JsonRepository', () => {
  it('persists the seed snapshot on the first read', async () => {
    const { file } = await temporaryFile()
    const seed = testSeed()
    const repository = new JsonRepository(file, seed)

    expect(await repository.read()).toEqual(seed)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(seed)
  })

  it('returns isolated snapshots instead of exposing its cache', async () => {
    const { file } = await temporaryFile()
    const repository = new JsonRepository(file, testSeed())

    const first = await repository.read()
    first.users[0].name = 'Changed outside the repository'

    expect((await repository.read()).users[0].name).not.toBe(first.users[0].name)
  })

  it('reloads a complete transaction from a new repository instance', async () => {
    const { file } = await temporaryFile()
    const first = new JsonRepository(file, testSeed())

    const result = await first.transact((draft) => {
      draft.session = { userId: 'USR-ADMIN', role: 'ADMIN' }
      return 'updated'
    })
    const second = new JsonRepository(file, testSeed())

    expect(result).toBe('updated')
    expect(await second.read()).toEqual(await first.read())
    expect((await second.read()).session).toEqual({ userId: 'USR-ADMIN', role: 'ADMIN' })
  })

  it.each([
    ['malformed JSON', '{ not json'],
    ['an invalid snapshot structure', JSON.stringify({ version: 1 })],
  ])('reports INVALID_DATA_FILE for %s', async (_label, contents) => {
    const { file } = await temporaryFile()
    await writeFile(file, contents, 'utf8')

    const repository = new JsonRepository(file, testSeed())

    await expect(repository.read()).rejects.toMatchObject({
      name: 'Error',
      message: 'INVALID_DATA_FILE',
    })
  })

  it('does not leave temporary files after writes', async () => {
    const { directory, file } = await temporaryFile()
    const repository = new JsonRepository(file, testSeed())

    await repository.read()
    await repository.transact((draft) => {
      draft.session = { userId: 'USR-OWNER', role: 'OWNER' }
    })

    expect(await readdir(directory)).toEqual([basename(file)])
  })

  it('keeps its cache and file unchanged when a transaction fails', async () => {
    const { file } = await temporaryFile()
    const repository = new JsonRepository(file, testSeed())
    const before = await repository.read()
    const persistedBefore = await readFile(file, 'utf8')

    await expect(repository.transact((draft) => {
      draft.session = { userId: 'USR-ADMIN', role: 'ADMIN' }
      throw new Error('MUTATION_FAILED')
    })).rejects.toThrow('MUTATION_FAILED')

    expect(await repository.read()).toEqual(before)
    expect(await readFile(file, 'utf8')).toBe(persistedBefore)

    await repository.transact((draft) => {
      draft.session = { userId: 'USR-OWNER', role: 'OWNER' }
    })
    expect((await repository.read()).session.role).toBe('OWNER')
  })

  it('serializes transactions within one repository instance', async () => {
    const { file } = await temporaryFile()
    const repository = new JsonRepository(file, testSeed())
    const events: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })

    const first = repository.transact(async (draft) => {
      events.push('first:start')
      markFirstStarted()
      await firstCanFinish
      draft.session = { userId: 'USR-ADMIN', role: 'ADMIN' }
      events.push('first:end')
    })
    await firstStarted

    const second = repository.transact((draft) => {
      events.push(`second:saw:${draft.session.role}`)
      draft.session = { userId: 'USR-OWNER', role: 'OWNER' }
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const eventsBeforeRelease = [...events]

    releaseFirst()
    await Promise.all([first, second])

    expect(eventsBeforeRelease).toEqual(['first:start'])
    expect(events).toEqual(['first:start', 'first:end', 'second:saw:ADMIN'])
    expect((await repository.read()).session.role).toBe('OWNER')
  })

  it('serializes updates across instances sharing a normalized file path', async () => {
    const { file } = await temporaryFile()
    const first = new JsonRepository(file, testSeed())
    const second = new JsonRepository(relative(process.cwd(), file), testSeed())

    await Promise.all([first.read(), second.read()])
    await Promise.all([
      first.transact((draft) => {
        draft.assetInputs.first = { content: 'first', mimeType: 'text/plain' }
      }),
      second.transact((draft) => {
        draft.assetInputs.second = { content: 'second', mimeType: 'text/plain' }
      }),
    ])

    const reloaded = new JsonRepository(file, testSeed())
    expect((await reloaded.read()).assetInputs).toEqual({
      first: { content: 'first', mimeType: 'text/plain' },
      second: { content: 'second', mimeType: 'text/plain' },
    })
  })

  it('does not let an initial concurrent read overwrite a transaction', async () => {
    const { file } = await temporaryFile()
    const repository = new JsonRepository(file, testSeed())

    const read = repository.read()
    const transaction = repository.transact((draft) => {
      draft.assetInputs.transaction = { content: 'committed', mimeType: 'text/plain' }
    })
    await Promise.all([read, transaction])

    const reloaded = new JsonRepository(file, testSeed())
    expect((await reloaded.read()).assetInputs.transaction).toEqual({
      content: 'committed',
      mimeType: 'text/plain',
    })
  })
})

describe('seedSnapshot', () => {
  it('returns independent version 1 demo snapshots for every call', () => {
    const first = seedSnapshot()
    const second = seedSnapshot()

    first.users[0].name = 'Changed'

    expect(second.version).toBe(1)
    expect(second.users.map((user) => user.role)).toEqual(['EMPLOYEE', 'OWNER', 'ADMIN'])
    expect(second.session).toEqual({ userId: 'USR-EMPLOYEE', role: 'EMPLOYEE' })
    expect(second.users[0].name).not.toBe(first.users[0].name)
    expect({
      assets: second.assets,
      candidates: second.candidates,
      knowledge: second.knowledge,
      reviews: second.reviews,
      conversations: second.conversations,
      messages: second.messages,
      assetInputs: second.assetInputs,
    }).toEqual({
      assets: [],
      candidates: [],
      knowledge: [],
      reviews: [],
      conversations: [],
      messages: [],
      assetInputs: {},
    })
  })
})

describe('buildApp', () => {
  it('exposes health and stable domain error responses', async () => {
    const { file } = await temporaryFile()
    const app = buildApp(new JsonRepository(file, seedSnapshot()))
    app.get('/api/test/forbidden', async () => {
      throw new Error('FORBIDDEN')
    })
    app.get('/api/test/invalid', async () => {
      throw new Error('INVALID_DATA_FILE')
    })
    app.get('/api/test/not-found', async () => {
      throw new Error('ASSET_NOT_FOUND')
    })
    app.get('/api/test/conflict', async () => {
      throw new Error('WRITE_CONFLICT')
    })
    app.get('/api/test/action', async () => {
      throw new Error('REVIEW_ACTION_NOT_ALLOWED')
    })
    app.get('/api/test/unknown', async () => {
      throw new Error('disk failed')
    })

    const health = await app.inject({ method: 'GET', url: '/api/health' })
    const forbidden = await app.inject({ method: 'GET', url: '/api/test/forbidden' })
    const invalid = await app.inject({ method: 'GET', url: '/api/test/invalid' })
    const notFound = await app.inject({ method: 'GET', url: '/api/test/not-found' })
    const conflict = await app.inject({ method: 'GET', url: '/api/test/conflict' })
    const action = await app.inject({ method: 'GET', url: '/api/test/action' })
    const unknown = await app.inject({ method: 'GET', url: '/api/test/unknown' })

    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ ok: true, provider: 'local-json' })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'FORBIDDEN', details: {} },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toEqual({
      error: { code: 'INVALID_DATA_FILE', message: 'INVALID_DATA_FILE', details: {} },
    })
    expect(notFound.statusCode).toBe(404)
    expect(notFound.json()).toEqual({
      error: { code: 'ASSET_NOT_FOUND', message: 'ASSET_NOT_FOUND', details: {} },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toEqual({
      error: { code: 'WRITE_CONFLICT', message: 'WRITE_CONFLICT', details: {} },
    })
    expect(action.statusCode).toBe(400)
    expect(action.json()).toEqual({
      error: { code: 'REVIEW_ACTION_NOT_ALLOWED', message: 'REVIEW_ACTION_NOT_ALLOWED', details: {} },
    })
    expect(unknown.statusCode).toBe(500)
    expect(unknown.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'INTERNAL_ERROR', details: {} },
    })

    await app.close()
  })

  it('normalizes Fastify parser errors without leaking parser details', async () => {
    const { file } = await temporaryFile()
    const app = buildApp(new JsonRepository(file, seedSnapshot()))
    app.post('/api/test/parser', async () => ({ ok: true }))

    const parser = await app.inject({
      method: 'POST',
      url: '/api/test/parser',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken"',
    })

    expect(parser.statusCode).toBe(400)
    expect(parser.json()).toEqual({
      error: { code: 'INVALID_REQUEST', message: 'INVALID_REQUEST', details: {} },
    })
    await app.close()
  })

  it('normalizes unknown routes without leaking Fastify details', async () => {
    const { file } = await temporaryFile()
    const app = buildApp(new JsonRepository(file, seedSnapshot()))

    const missing = await app.inject({ method: 'GET', url: '/api/missing' })

    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'NOT_FOUND', details: {} },
    })
    await app.close()
  })
})
