import type { PlatformSnapshot } from '../../shared/domain/models.js'

export interface PlatformRepository {
  read(): Promise<PlatformSnapshot>
  transact<T>(mutator: (draft: PlatformSnapshot) => T | Promise<T>): Promise<T>
}
