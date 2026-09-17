import type { ConversationSkillId } from '../domain/models.js'

/**
 * Product-facing skill contract.
 *
 * The chat UI may render skills differently, but the id, trigger and run
 * states are shared with the API so a skill can move from the prototype to a
 * server-backed implementation without changing the conversation contract.
 */
export type ProductSkillId = ConversationSkillId

export type ProductSkillTrigger = 'AUTO' | 'MENTION' | 'DEFAULT'

export type ProductSkillRunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'

export type ProductSkillAvailability = 'AVAILABLE' | 'PLANNED'

export interface ProductSkillDefinition {
  id: ProductSkillId
  label: string
  description: string
  prompt: string
  triggerKeywords: string[]
  availability?: ProductSkillAvailability
  stage?: 1 | 2 | 3
}

export interface ProductSkillRun {
  id: string
  conversationId: string
  skillId: ProductSkillId
  trigger: ProductSkillTrigger
  status: ProductSkillRunStatus
  startedAt?: string
  completedAt?: string
  errorCode?: string
}

export interface ProductSkillCatalogResponse {
  skills: ProductSkillDefinition[]
}
