import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { PlatformSnapshot } from '../../shared/domain/models.js'
import { parseSnapshot } from '../../shared/domain/schema.js'
import type { PlatformRepository } from '../application/ports.js'

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function invalidDataFile() {
  return new Error('INVALID_DATA_FILE')
}

interface RepositoryCoordinator {
  cache?: PlatformSnapshot
  queue: Promise<void>
}

// V1 coordinates repositories inside one process; it does not provide cross-process locking.
const coordinators = new Map<string, RepositoryCoordinator>()

function coordinatorFor(file: string): RepositoryCoordinator {
  const existing = coordinators.get(file)
  if (existing) return existing

  const coordinator: RepositoryCoordinator = { queue: Promise.resolve() }
  coordinators.set(file, coordinator)
  return coordinator
}

export class JsonRepository implements PlatformRepository {
  private readonly file: string
  private readonly seed: PlatformSnapshot
  private readonly coordinator: RepositoryCoordinator

  constructor(file: string, seed: PlatformSnapshot) {
    this.file = resolve(file)
    this.seed = seed
    this.coordinator = coordinatorFor(this.file)
  }

  private async load(): Promise<PlatformSnapshot> {
    if (this.coordinator.cache) return this.coordinator.cache

    let contents: string
    try {
      contents = await readFile(this.file, 'utf8')
    } catch (error) {
      if (!isMissingFile(error)) throw error

      const initial = parseSnapshot(structuredClone(this.seed))
      await this.persist(initial)
      this.coordinator.cache = initial
      return initial
    }

    let input: unknown
    try {
      input = JSON.parse(contents)
    } catch {
      throw invalidDataFile()
    }

    const loaded = parseSnapshot(input)
    this.coordinator.cache = loaded
    return loaded
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.coordinator.queue.then(operation)
    this.coordinator.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async persist(snapshot: PlatformSnapshot): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`

    try {
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      await rename(temporary, this.file)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async read(): Promise<PlatformSnapshot> {
    return this.enqueue(async () => structuredClone(await this.load()))
  }

  async transact<T>(mutator: (draft: PlatformSnapshot) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const current = await this.load()
      const draft = structuredClone(current)
      const result = await mutator(draft)
      const validated = parseSnapshot(draft)

      await this.persist(validated)
      this.coordinator.cache = validated
      return result
    })
  }
}
