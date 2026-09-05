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
  mediaType?: 'IMAGE' | null
  imageUrl?: string | null
  previewUrl?: string | null
  imageAlt?: string | null
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
  solutionDraftId?: string
  citations: Citation[]
  createdAt: string
  feedback?: MessageFeedback
}

export type SolutionDraftStatus = 'GENERATING' | 'READY' | 'NEEDS_REVIEW' | 'BLOCKED' | 'CONFIRMED' | 'SUPERSEDED'

export type ClarificationQuestionType = 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TEXT'

export interface ClarificationQuestionOption {
  id: string
  label: string
  description?: string
}

export interface ClarificationQuestion {
  id: string
  question: string
  type: ClarificationQuestionType
  options: ClarificationQuestionOption[]
  required: boolean
  allowSkip: boolean
  position: number
  total: number
}

export interface SolutionQuestionAnswer {
  questionId: string
  value?: string | string[]
  action: 'answer' | 'skip'
}

export interface DraftCitation {
  id: string
  title: string
  locator: string
  excerpt: string
  sourceUrl?: string
}

export interface DraftRequirement {
  id: string
  text: string
  source?: string
}

export interface DraftSection {
  id: string
  title: string
  contentMarkdown: string
  requirementIds: string[]
  citationIds: string[]
}

export interface ConflictAlternative {
  statement: string
  applicability: Record<string, string>
  citationIds: string[]
}

export interface ConflictItem {
  claim: string
  alternatives: ConflictAlternative[]
  applicability: string
  citationIds: string[]
  status: 'UNRESOLVED' | 'SCOPED'
}

export interface SolutionDraftQuality {
  status: SolutionDraftStatus
  evidenceCoverage: number
  missingSections: string[]
  invalidCitations: string[]
  notes: string[]
}

export type CapabilityDeliveryStatus = 'PRODUCTIZED' | 'DELIVERED' | 'CUSTOMIZABLE' | 'R_AND_D' | 'UNKNOWN'
export type CapabilityMatchType = 'EXISTING' | 'CUSTOM' | 'R_AND_D' | 'UNKNOWN'

export interface CapabilityMatch {
  requirementId: string
  capabilityId: string
  capabilityName: string
  deliveryStatus: CapabilityDeliveryStatus | string
  matchType: CapabilityMatchType | string
  matchScore: number
  confidence: number
  citationIds: string[]
  limitations: string[]
  reviewRequired: boolean
}

export type DraftEvidenceSourceType = 'ENTERPRISE_FORMAL' | 'PROJECT_CASE' | 'INDUSTRY_REFERENCE' | 'INNOVATION_HYPOTHESIS' | string

export interface DraftEvidenceItem {
  id: string
  sourceType: DraftEvidenceSourceType
  title: string
  locator: string
  excerpt: string
  confidence: number
  citationId?: string
}

export interface ConfidenceSummary {
  enterpriseCoverage: number
  evidenceCoverage: number
  industryReferenceRatio: number
  innovationRatio: number
  notes: string[]
}

export interface SolutionReviewState {
  status: string
  pendingItems: string[]
  requiredRoles: string[]
  decisions: Array<Record<string, unknown>>
}

export interface SolutionDraft {
  id: string
  conversationId: string
  sourceRunId?: string
  baseVersionId?: string
  versionSource?: 'AI' | 'HUMAN_EDIT' | 'CONFIRMED' | string
  confirmedAt?: string
  currentVersion: number
  status: SolutionDraftStatus
  title: string
  customerContext: string
  executiveSummary: string
  requirements: DraftRequirement[]
  sections: DraftSection[]
  assumptions: string[]
  openQuestions: string[]
  clarificationQuestions?: ClarificationQuestion[]
  risks: string[]
  conflicts: ConflictItem[]
  evidenceGaps: string[]
  citations: DraftCitation[]
  quality: SolutionDraftQuality
  customer?: string
  capabilityMatches?: CapabilityMatch[]
  architecture?: Record<string, unknown>
  evidence?: DraftEvidenceItem[]
  confidenceSummary?: ConfidenceSummary
  review?: SolutionReviewState
  executionTrace?: {
    status: string
    startedAt?: string | null
    finishedAt?: string | null
    elapsedMs: number
    steps: Array<{
      stage: string
      label: string
      message: string
      status: string
      startedAt?: string | null
      finishedAt?: string | null
      elapsedMs: number
    }>
  }
  createdAt: string
  updatedAt: string
  versions?: Array<{ version: number; payload: Record<string, unknown>; createdAt: string; source?: 'AI' | 'HUMAN_EDIT' | 'CONFIRMED' | string; baseVersionId?: string }>
}

export interface CapabilityIndexEntry {
  id: string
  name: string
  description: string
  deliveryStatus: CapabilityDeliveryStatus | string
  sourceKnowledgeIds: string[]
  citationIds: string[]
  confidence: number
  updatedAt: string
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
  assetInputs: Record<string, { content: string; mimeType: string; contentBase64?: string }>
  distributionTasks?: DistributionTask[]
  solutionDrafts?: SolutionDraft[]
  capabilityIndex?: CapabilityIndexEntry[]
}
