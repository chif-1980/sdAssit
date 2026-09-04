import type {
  AssetType,
  Authority,
  BusinessType,
  CandidateStatus,
  CrossDocumentRelationStatus,
  CrossDocumentRelationType,
  ConversationScope,
  ConversationStatus,
  FeedbackType,
  IndexStatus,
  KnowledgeStatus,
  KnowledgeType,
  MessageRole,
  ProcessStatus,
  Relation,
  KnowledgeSourceRole,
  ProblemTag,
  ReviewDecision,
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
  applicability?: ApplicabilityScope
  comparisonRelationIds?: string[]
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
  applicability?: ApplicabilityScope
  logicalFactKey?: string
  aliasAssetIds?: string[]
  sourceLinks?: KnowledgeSourceLink[]
}

export interface KnowledgeSourceLink {
  assetId: string
  locator?: string
  role: KnowledgeSourceRole
}

export interface KnowledgeVersion {
  id: string
  knowledgeId: string
  version: number
  content: string
  applicability?: ApplicabilityScope
  primaryAssetId: string
  supportingAssetIds: string[]
  aliasAssetIds: string[]
  sourceLinks: KnowledgeSourceLink[]
  sourceLocator: string
  reviewId: string
  reviewerId: string
  decisionComment: string
  createdAt: string
}

export interface ApplicabilityScope {
  industry?: string
  product?: string
  productVersion?: string
  deploymentMode?: string
  customerType?: string
  locale?: string
  effectiveFrom?: string
  effectiveTo?: string
}

export interface CrossDocumentRelation {
  id: string
  relationKey: string
  relationType: CrossDocumentRelationType
  leftAssetId: string
  rightAssetId: string
  leftCandidateId?: string
  rightCandidateId?: string
  leftLocator: string
  rightLocator: string
  leftExcerpt: string
  rightExcerpt: string
  similarity: number
  confidence: number
  scopeDiffs: string[]
  sharedContent?: string
  diffContent?: string
  aiReason: string
  status: CrossDocumentRelationStatus
  reviewerId?: string
  resolutionAction?: ResolutionAction
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
  decision?: ReviewDecision
  problemTags?: ProblemTag[]
  applicability?: ApplicabilityScope
  requestedChanges?: string
  assigneeId?: string
  transferHistory?: Array<{ from: string; to: string; at: string; comment: string }>
  comparisonRelationIds?: string[]
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

export type ConversationSkillId = 'MATERIAL_SEARCH' | 'SOLUTION_DRAFT' | 'MEETING_ANALYSIS'

export interface ConversationMessage {
  id: string
  conversationId: string
  role: MessageRole
  text: string
  skillId?: ConversationSkillId
  answerStatus?: 'SUPPORTED' | 'INSUFFICIENT' | 'CONFLICTING'
  materialIds?: string[]
  citations: Citation[]
  createdAt: string
  feedback?: MessageFeedback
}

export interface DistributionTask {
  id: string
  materialId: string
  requesterId: string
  channel: 'WECHAT' | 'FEISHU' | 'DINGTALK'
  mode: 'DEVICE_SHARE'
  status: 'READY' | 'DISPATCHED' | 'FAILED' | 'CANCELLED'
  createdAt: string
  completedAt?: string
}

export interface PlatformSnapshot {
  version: 1
  session: { userId: string; role: UserRole }
  users: User[]
  assets: Asset[]
  candidates: Candidate[]
  knowledge: Knowledge[]
  knowledgeVersions?: KnowledgeVersion[]
  reviews: Review[]
  crossDocumentRelations?: CrossDocumentRelation[]
  conversations: Conversation[]
  messages: ConversationMessage[]
  assetInputs: Record<string, { content: string; mimeType: string }>
  distributionTasks?: DistributionTask[]
}
