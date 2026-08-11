import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { PlatformSnapshot } from '../../shared/domain/models.js'
import { parseSnapshot } from '../../shared/domain/schema.js'
import type { PlatformRepository } from '../application/ports.js'

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function invalidDataFile() {
  return new Error('INVALID_DATA_FILE')
}

export class JsonRepository implements PlatformRepository {
  private cache?: PlatformSnapshot
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly seed: PlatformSnapshot,
  ) {}

  private async load(): Promise<PlatformSnapshot> {
    if (this.cache) return this.cache

    let contents: string
    try {
      contents = await readFile(this.file, 'utf8')
    } catch (error) {
      if (!isMissingFile(error)) throw error

      const initial = parseSnapshot(structuredClone(this.seed))
      await this.persist(initial)
      this.cache = initial
      return initial
    }

    let input: unknown
    try {
      input = JSON.parse(contents)
    } catch {
      throw invalidDataFile()
    }

    const loaded = parseSnapshot(input)
    this.cache = loaded
    return loaded
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
    return structuredClone(await this.load())
  }

  async transact<T>(mutator: (draft: PlatformSnapshot) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const current = await this.load()
      const draft = structuredClone(current)
      const result = await mutator(draft)
      const validated = parseSnapshot(draft)

      await this.persist(validated)
      this.cache = validated
      return result
    })

    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }
}
