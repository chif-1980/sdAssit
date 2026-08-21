export type AnswerStatus = 'SUPPORTED' | 'INSUFFICIENT' | 'CONFLICTING'
export type ConversationStatus = 'ACTIVE' | 'ARCHIVED'
export type FeedbackRating = 'LIKE' | 'DISLIKE'
export type AnswerMode = 'CONCISE' | 'DETAILED'
export type ProductAnswerStage = 'UNDERSTANDING' | 'RETRIEVING' | 'VERIFYING' | 'COMPOSING'

export interface ProductAnswerProgress {
  stage: ProductAnswerStage
  message: string
}

export interface ProductUser {
  id: string
  name: string
  avatarUrl: string | null
}

export interface FeishuQrLoginConfig {
  goto: string
  expiresIn: number
}

export interface ProductConversation {
  id: string
  title: string
  status: ConversationStatus
  messageCount: number
  createdAt: string
  updatedAt: string
}

export interface ProductCitation {
  id: string
  kind: 'ENTERPRISE_EVIDENCE'
  title: string
  path: string | null
  locator: string
  excerpt: string
  versionAt: string | null
}

export interface ProductMessage {
  id: string
  role: 'USER' | 'ASSISTANT'
  content: string
  answerStatus: AnswerStatus | null
  feedbackRating?: FeedbackRating | null
  citations: ProductCitation[]
  createdAt: string
}
