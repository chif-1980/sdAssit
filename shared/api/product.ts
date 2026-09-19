import type {
  CapabilityIndexEntry,
  CapabilityMatch,
  ClarificationQuestion,
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
  resetAnswer?: boolean
  updatedAt?: string
  completed?: number | null
  total?: number | null
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
  questionId?: string
  type?: ClarificationQuestion['type']
  options?: ClarificationQuestion['options']
  /**
   * A LangGraph ask_user_question interrupt may contain several independent
   * questions.  Keep the first-question fields above for backwards
   * compatibility, while exposing the complete batch to the product UI so a
   * resume is submitted only after every required answer is collected.
   */
  questions?: Array<{
    id?: string
    question: string
    questionId?: string
    type?: ClarificationQuestion['type']
    options?: ClarificationQuestion['options']
    required?: boolean
    allowSkip?: boolean
    position?: number
    total?: number
  }>
  required?: boolean
  allowSkip?: boolean
  position?: number
  total?: number
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
  meeting?: MeetingRecord
  createdAt: string
}

export interface MeetingSource {
  title: string
  platform: string
  url?: string | null
  platformSummary: string
  completeness: string
  summaryNotice?: string
  paragraphs: { id: string; text: string; speaker: string; startMs?: number | null; endMs?: number | null }[]
}

export interface MeetingDirectoryUser {
  userId: string | null
  feishuUserId: string | null
  feishuOpenId?: string | null
  englishName?: string
  departmentIds?: string[]
  displayName: string
}

export interface MeetingDepartment { id: string; parentId: string | null; name: string }

export interface MeetingFollowupTask {
  id: string
  title: string
  content?: string
  assignee: MeetingDirectoryUser | null
  assigneeSuggestion?: string | null
  dueDate: string | null
  dueDateSuggestion?: string | null
  status: 'OPEN' | 'IN_PROGRESS' | 'DONE' | string
  sourceRefs: string[]
  sourceMeetingId?: string
  origin?: 'EXTRACTED' | 'MANUAL' | string
  reviewStatus?: 'PENDING' | 'CONFIRMED' | 'IGNORED' | 'DELIVERY_FAILED' | string
  delivery?: { notification: 'NOT_SENT' | 'SENT' | 'FAILED' | string; feishuTaskId?: string | null; messageId?: string | null; chatId?: string | null; error?: string | null; pendingUpdate?: boolean; syncStatus?: string; syncError?: string | null; lastSyncedAt?: string }
}

export interface MeetingKnowledgeSuggestion {
  id: string
  title: string
  reason: string
  sourceRefs: string[]
  status: 'PENDING_MAINTAINER' | string
  decisionReason?: string
  draftContent?: string
  comparisonStatus?: 'COVERED' | 'NEEDS_UPDATE' | 'NEW_TOPIC' | 'UNVERIFIED' | string
  comparison?: string
  formalEvidenceIds?: string[]
  formalEvidence?: { evidence_id: string; title: string; excerpt: string; source_url: string }[]
}

export interface MeetingFollowup {
  coordinator: { userId: string; displayName: string }
  tasks: MeetingFollowupTask[]
  knowledgeSuggestions: MeetingKnowledgeSuggestion[]
}

export interface MeetingRecord {
  id: string
  conversationId: string
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  version: number
  updatedAt: string
  progress: { message: string; completed?: number; total?: number; updatedAt?: string }
  error?: { code: string; message: string } | null
  result?: {
    title: string
    meetingType: string
    body: string
    coverage?: { processed: number; total: number; paragraphs: number }
    formalEvidence?: { evidence_id: string; title: string; excerpt: string; source_url: string }[]
    selectedHistoryIds?: string[]
    selectedHistory?: { id: string; label?: string; title: string; body: string }[]
    followup?: MeetingFollowup
  } | null
  sources: MeetingSource[]
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
  clarificationQuestionsResolved?: boolean
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
  versions?: Array<{ version: number; payload: Record<string, unknown>; createdAt: string; source?: 'AI' | 'HUMAN_EDIT' | 'CONFIRMED' | string; baseVersionId?: string }>
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
  clarificationQuestions?: ClarificationQuestion[]
  clarificationQuestionsResolved?: boolean
}

export interface SolutionDraftConfirmResponse {
  draft: SolutionDraft
  confirmed: boolean
}

export interface ProductCapabilityIndexResponse {
  capabilities: CapabilityIndexEntry[]
}


export interface MeetingHistoryItem {
  id: string
  conversationId: string
  groupId: string
  title: string
  createdAt: string
  meetingDate?: string | null
  platforms: string[]
  sourceUrls: string[]
  preview: string
  versionCount: number
}

export interface MeetingHistoryPage {
  meetings: MeetingHistoryItem[]
  total: number
  nextOffset: number | null
}
