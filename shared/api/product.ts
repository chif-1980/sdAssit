export type AnswerStatus = 'SUPPORTED' | 'INSUFFICIENT' | 'CONFLICTING'
export type ConversationStatus = 'ACTIVE' | 'ARCHIVED'

export interface ProductUser {
  id: string
  name: string
  avatarUrl: string | null
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
  citations: ProductCitation[]
  createdAt: string
}
