import type { Knowledge } from '../../shared/domain/models.js'
import type { KnowledgeIndexer } from '../application/ports.js'

export class LocalIndexer implements KnowledgeIndexer {
  async index(knowledge: Knowledge): Promise<void> {
    if (knowledge.content.includes('[INDEX_FAIL]')) throw new Error('INDEXING_FAILED')
  }
}
