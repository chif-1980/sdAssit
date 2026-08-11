import type {
  AssetType,
  Authority,
  BusinessType,
  CandidateStatus,
  ConversationScope,
  ConversationStatus,
  FeedbackType,
  IndexStatus,
  KnowledgeStatus,
  KnowledgeType,
  MessageRole,
  ProcessStatus,
  Relation,
  ResolutionAction,
  ReviewStatus,
  ReviewType,
  Risk,
  TriggerType,
  UserRole,
} from './enums.js'

export interface User {
  id: string
  name: string
  role: UserRole
}

export interface AssetSection {
  id: string
  title: string
  locator: string
  excerpt: string
}

export interface Asset {
  id: string
  title: string
  assetType: AssetType
  businessType: BusinessType
  provider: 'LOCAL'
  externalId: string
  sourceUrl?: string
  ownerId: string
  authority: Authority
  processStatus: ProcessStatus
  summary?: string
  contentHash?: string
  errorMessage?: string
  sourceModifiedAt?: string
  processedAt?: string
  createdAt: string
  updatedAt: string
  isSessionAsset: boolean
  expiresAt?: string
  sections: AssetSection[]
}

export interface Candidate {
  id: string
  title: string
  content: string
  knowledgeType: KnowledgeType
  sourceAssetId: string
  sourceLocator: string
  sourceExcerpt: string
  authority: Authority
  confidence: number
  relation: Relation
  existingKnowledgeId?: string
  aiReason: string
  status: CandidateStatus
  reviewRequired: boolean
  reviewerId?: string
  candidateHash: string
  createdAt: string
  reviewedAt?: string
}

export interface Knowledge {
  id: string
  title: string
  content: string
  category: KnowledgeType
  tags: string[]
  authority: Authority
  ownerId: string
  primaryAssetId: string
  supportingAssetIds: string[]
  sourceLocator: string
  status: KnowledgeStatus
  version: number
  validFrom?: string
  validTo?: string
  lastVerifiedAt: string
  staleReason?: string
  aiEnabled: boolean
  indexStatus: IndexStatus
  createdAt: string
  updatedAt: string
}

export interface Review {
  id: string
  title: string
  triggerType: TriggerType
  reviewType: ReviewType
  candidateId?: string
  targetKnowledgeId?: string
  risk: Risk
  currentSnapshot?: string
  proposedContent?: string
  aiSuggestion?: string
  reviewerId: string
  status: ReviewStatus
  resolutionAction?: ResolutionAction
  finalContent?: string
  decisionComment?: string
  conversationId?: string
  feedbackType?: FeedbackType
  feedbackText?: string
  createdAt: string
  dueAt?: string
  resolvedAt?: string
}

export interface Conversation {
  id: string
  title: string
  userId: string
  topic?: string
  scope: ConversationScope
  summary?: string
  sessionAssetIds: string[]
  status: ConversationStatus
  messageCount: number
  negativeFeedbackCount: number
  hasOpenIssue: boolean
  lastFeedbackType?: FeedbackType
  lastFeedbackText?: string
  createdAt: string
  lastActiveAt: string
}

export interface Citation {
  knowledgeId: string
  title: string
  assetId: string
  assetOwnerId?: string
  locator: string
  excerpt: string
}

export interface MessageFeedback {
  helpful: boolean
  type?: FeedbackType
  text?: string
  createdAt: string
}

export interface ConversationMessage {
  id: string
  conversationId: string
  role: MessageRole
  text: string
  citations: Citation[]
  createdAt: string
  feedback?: MessageFeedback
}

export interface PlatformSnapshot {
  version: 1
  session: { userId: string; role: UserRole }
  users: User[]
  assets: Asset[]
  candidates: Candidate[]
  knowledge: Knowledge[]
  reviews: Review[]
  conversations: Conversation[]
  messages: ConversationMessage[]
  assetInputs: Record<string, { content: string; mimeType: string }>
}
