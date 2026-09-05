import type {
  CapabilityMatch,
  ConfidenceSummary,
  ConflictItem,
  DraftCitation,
  DraftEvidenceItem,
  DraftRequirement,
  DraftSection,
  SolutionReviewState,
  SolutionDraftQuality,
  SolutionDraftStatus,
} from '../domain/models.js'

export type AnswerStatus = 'SUPPORTED' | 'INSUFFICIENT' | 'CONFLICTING'
export type ConversationStatus = 'ACTIVE' | 'ARCHIVED'
export type FeedbackRating = 'LIKE' | 'DISLIKE'
export type FeedbackReasonType = 'CONTENT_ERROR' | 'OUTDATED' | 'MISSING_SOURCE' | 'CITATION_ERROR' | 'OTHER'
export type AnswerMode = 'CONCISE' | 'DETAILED'
export type ProductAnswerStage =
  | 'UNDERSTANDING'
  | 'REQUIREMENTS_ANALYSIS'
  | 'CAPABILITY_MATCHING'
  | 'ARCHITECTURE_DESIGN'
  | 'RETRIEVING'
  | 'VERIFYING'
  | 'EVIDENCE_CHECK'
  | 'QUALITY_REVIEW'
  | 'COMPOSING'
  | 'WAITING_FOR_INPUT'
export type ProductSkillId = 'MATERIAL_SEARCH' | 'SOLUTION_DRAFT' | 'MEETING_ANALYSIS'

export interface ProductAnswerProgress {
  stage: ProductAnswerStage
  message: string
  runId?: string
  status?: string
  elapsedMs?: number
}

export interface SolutionExecutionStep {
  stage: string
  label: string
  message: string
  status: 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | string
  startedAt?: string | null
  finishedAt?: string | null
  elapsedMs: number
}

export interface SolutionExecutionTrace {
  status: string
  startedAt?: string | null
  finishedAt?: string | null
  elapsedMs: number
  steps: SolutionExecutionStep[]
}

export interface ProductAgentInterrupt {
  runId?: string
  question: string
  status: 'INTERRUPTED'
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

export interface ProductMaterial {
  id: string
  title: string
  type: string
  fileName: string
  mimeType: string
  sizeBytes: number
  updatedAt: string
  summary: string
  status: 'APPROVED' | 'PUBLISHED'
  approvalStatus: 'APPROVED'
  publicationStatus: 'PUBLISHED'
  citation: ProductCitation
}

export interface ProductMessage {
  id: string
  role: 'USER' | 'ASSISTANT'
  content: string
  skillId?: ProductSkillId
  answerStatus: AnswerStatus | null
  feedbackRating?: FeedbackRating | null
  feedbackReasonType?: FeedbackReasonType | null
  feedbackReasonText?: string | null
  citations: ProductCitation[]
  materials?: ProductMaterial[]
  attachments?: ProductAttachment[]
  solutionDraft?: SolutionDraft
  createdAt: string
}

export interface SolutionDraft {
  id: string
  conversationId: string
  sourceRunId?: string
  currentVersion: number
  status: SolutionDraftStatus
  title: string
  customerContext: string
  executiveSummary: string
  requirements: DraftRequirement[]
  sections: DraftSection[]
  assumptions: string[]
  openQuestions: string[]
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
  executionTrace?: SolutionExecutionTrace
  createdAt: string
  updatedAt: string
}

export interface SolutionDraftEditRequest {
  customer?: string
  title?: string
  customerContext?: string
  executiveSummary?: string
  requirements?: DraftRequirement[]
  sections?: DraftSection[]
  assumptions?: string[]
  openQuestions?: string[]
  risks?: string[]
  conflicts?: ConflictItem[]
  evidenceGaps?: string[]
  citations?: DraftCitation[]
  capabilityMatches?: CapabilityMatch[]
  architecture?: Record<string, unknown>
  evidence?: DraftEvidenceItem[]
  confidenceSummary?: ConfidenceSummary
  review?: SolutionReviewState
}
