import type { Knowledge, PlatformSnapshot } from '../../shared/domain/models.js'

export interface PlatformRepository {
  read(): Promise<PlatformSnapshot>
  transact<T>(mutator: (draft: PlatformSnapshot) => T | Promise<T>): Promise<T>
}

export interface KnowledgeIndexer {
  index(knowledge: Knowledge): Promise<void>
}
