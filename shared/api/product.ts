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

export type ProductAttachmentStatus = 'PROCESSING' | 'READY' | 'FAILED'

export interface ProductAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  status: ProductAttachmentStatus
  errorMessage?: string
}

export interface ProductCitation {
  id: string
  kind: 'ENTERPRISE_EVIDENCE'
  title: string
  path: string | null
  locator: string
  excerpt: string
  versionAt: string | null
  mediaType?: 'IMAGE' | null
  imageUrl?: string | null
  previewUrl?: string | null
  imageAlt?: string | null
}

export interface ProductMessage {
  id: string
  role: 'USER' | 'ASSISTANT'
  content: string
  answerStatus: AnswerStatus | null
  feedbackRating?: FeedbackRating | null
  citations: ProductCitation[]
  attachments?: ProductAttachment[]
  createdAt: string
}
