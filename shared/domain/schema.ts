import { z } from 'zod'

import type { PlatformSnapshot } from './models.js'

const authoritySchema = z.enum(['L0', 'L1', 'L2', 'L3'])
const isoSchema = z.string().datetime()
const knowledgeTypeSchema = z.enum([
  'PRODUCT_CAPABILITY', 'PRODUCT_PARAMETER', 'TECHNICAL', 'FAQ', 'PROCESS',
  'POLICY', 'BEST_PRACTICE', 'PROJECT', 'OTHER',
])
const feedbackTypeSchema = z.enum(['WRONG', 'OUTDATED', 'MISSING', 'CITATION_ERROR', 'OTHER'])
const applicabilitySchema = z.object({
  industry: z.string().max(120).optional(),
  product: z.string().max(120).optional(),
  productVersion: z.string().max(120).optional(),
  deploymentMode: z.string().max(120).optional(),
  customerType: z.string().max(120).optional(),
  locale: z.string().max(120).optional(),
  effectiveFrom: isoSchema.optional(),
  effectiveTo: isoSchema.optional(),
}).strict().refine(
  (value) => value.effectiveFrom === undefined || value.effectiveTo === undefined || value.effectiveFrom <= value.effectiveTo,
)

const assetSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  locator: z.string(),
  excerpt: z.string(),
}).strict()

const assetSchema = z.object({
  id: z.string(),
  title: z.string(),
  assetType: z.enum(['DOCUMENT', 'AUDIO', 'VIDEO', 'IMAGE']),
  businessType: z.enum([
    'PRODUCT_DOCUMENT', 'SOLUTION', 'POLICY', 'PROCESS', 'TRAINING',
    'CUSTOMER_MEETING', 'INTERNAL_MEETING', 'PROJECT_DOCUMENT', 'SESSION_UPLOAD', 'OTHER',
  ]),
  provider: z.literal('LOCAL'),
  externalId: z.string(),
  sourceUrl: z.string().optional(),
  ownerId: z.string(),
  authority: authoritySchema,
  processStatus: z.enum(['NEW', 'PROCESSING', 'PROCESSED', 'FAILED']),
  summary: z.string().optional(),
  contentHash: z.string().optional(),
  errorMessage: z.string().optional(),
  sourceModifiedAt: isoSchema.optional(),
  processedAt: isoSchema.optional(),
  createdAt: isoSchema,
  updatedAt: isoSchema,
  isSessionAsset: z.boolean(),
  expiresAt: isoSchema.optional(),
  sections: z.array(assetSectionSchema),
}).strict()

const candidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  knowledgeType: knowledgeTypeSchema,
  sourceAssetId: z.string(),
  sourceLocator: z.string(),
  sourceExcerpt: z.string(),
  authority: authoritySchema,
  confidence: z.number().min(0).max(1),
  relation: z.enum(['NEW', 'DUPLICATE', 'UPDATE', 'CONFLICT']),
  existingKnowledgeId: z.string().optional(),
  aiReason: z.string(),
  status: z.enum(['PENDING', 'NEEDS_CHANGES', 'APPROVED', 'REJECTED']),
  reviewRequired: z.boolean(),
  reviewerId: z.string().optional(),
  candidateHash: z.string(),
  applicability: applicabilitySchema.optional(),
  comparisonRelationIds: z.array(z.string()).optional(),
  createdAt: isoSchema,
  reviewedAt: isoSchema.optional(),
}).strict()

const knowledgeSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  category: knowledgeTypeSchema,
  tags: z.array(z.string()),
  authority: authoritySchema,
  ownerId: z.string(),
  primaryAssetId: z.string(),
  supportingAssetIds: z.array(z.string()),
  sourceLocator: z.string(),
  status: z.enum(['ACTIVE', 'STALE', 'ARCHIVED']),
  version: z.number().int().positive(),
  validFrom: isoSchema.optional(),
  validTo: isoSchema.optional(),
  lastVerifiedAt: isoSchema,
  staleReason: z.string().optional(),
  aiEnabled: z.boolean(),
  indexStatus: z.enum(['PENDING', 'INDEXED', 'FAILED']),
  createdAt: isoSchema,
  updatedAt: isoSchema,
  applicability: applicabilitySchema.optional(),
  logicalFactKey: z.string().optional(),
  aliasAssetIds: z.array(z.string()).optional(),
  sourceLinks: z.array(z.object({ assetId: z.string(), locator: z.string().optional(), role: z.enum(['PRIMARY', 'SUPPORTING', 'ALIAS']) }).strict()).optional(),
}).strict()

const crossDocumentRelationSchema = z.object({
  id: z.string(),
  relationKey: z.string(),
  relationType: z.enum(['EXACT_DUPLICATE', 'OVERLAP', 'COMPLEMENTARY', 'CONDITIONAL_VARIANT', 'CONFLICT', 'INSUFFICIENT']),
  leftAssetId: z.string(),
  rightAssetId: z.string(),
  leftCandidateId: z.string().optional(),
  rightCandidateId: z.string().optional(),
  leftLocator: z.string(),
  rightLocator: z.string(),
  leftExcerpt: z.string(),
  rightExcerpt: z.string(),
  similarity: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  scopeDiffs: z.array(z.string()),
  sharedContent: z.string().optional(),
  diffContent: z.string().optional(),
  aiReason: z.string(),
  status: z.enum(['AUTO_RESOLVED', 'PENDING', 'RESOLVED']),
  reviewerId: z.string().optional(),
  resolutionAction: z.enum([
    'CREATE_KNOWLEDGE', 'UPDATE_KNOWLEDGE', 'KEEP_CURRENT', 'REJECT_CANDIDATE',
    'ARCHIVE_KNOWLEDGE', 'CONFIRM_VALID', 'MARK_DUPLICATE', 'SPLIT_BY_SCOPE', 'MARK_INSUFFICIENT',
  ]).optional(),
  createdAt: isoSchema,
  updatedAt: isoSchema,
}).strict()

const knowledgeVersionSchema = z.object({
  id: z.string(),
  knowledgeId: z.string(),
  version: z.number().int().positive(),
  content: z.string(),
  applicability: applicabilitySchema.optional(),
  primaryAssetId: z.string(),
  supportingAssetIds: z.array(z.string()),
  aliasAssetIds: z.array(z.string()),
  sourceLinks: z.array(z.object({ assetId: z.string(), locator: z.string().optional(), role: z.enum(['PRIMARY', 'SUPPORTING', 'ALIAS']) }).strict()),
  sourceLocator: z.string(),
  reviewId: z.string(),
  reviewerId: z.string(),
  decisionComment: z.string(),
  createdAt: isoSchema,
}).strict()

const reviewSchema = z.object({
  id: z.string(),
  title: z.string(),
  triggerType: z.enum(['CANDIDATE', 'USER_FEEDBACK', 'LIFECYCLE', 'SOURCE_CHANGE']),
  reviewType: z.enum(['NEW', 'UPDATE', 'CONFLICT', 'STALE']),
  candidateId: z.string().optional(),
  targetKnowledgeId: z.string().optional(),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  currentSnapshot: z.string().optional(),
  proposedContent: z.string().optional(),
  aiSuggestion: z.string().optional(),
  reviewerId: z.string(),
  status: z.enum(['PENDING', 'CHANGES_REQUESTED', 'RESOLVED', 'CANCELLED']),
  resolutionAction: z.enum([
    'CREATE_KNOWLEDGE', 'UPDATE_KNOWLEDGE', 'KEEP_CURRENT',
    'REJECT_CANDIDATE', 'ARCHIVE_KNOWLEDGE', 'CONFIRM_VALID', 'MARK_DUPLICATE',
    'SPLIT_BY_SCOPE', 'MARK_INSUFFICIENT',
  ]).optional(),
  finalContent: z.string().optional(),
  decisionComment: z.string().optional(),
  conversationId: z.string().optional(),
  feedbackType: feedbackTypeSchema.optional(),
  feedbackText: z.string().optional(),
  createdAt: isoSchema,
  dueAt: isoSchema.optional(),
  resolvedAt: isoSchema.optional(),
  decision: z.enum(['PUBLISH', 'REQUEST_CHANGES', 'REJECT', 'TRANSFER']).optional(),
  problemTags: z.array(z.enum([
    'DUPLICATE', 'OVERLAP', 'CONFLICT', 'INSUFFICIENT_EVIDENCE', 'MISSING_SCOPE',
    'OUTDATED', 'OCR_ERROR', 'SOURCE_UNCLEAR',
  ])).optional(),
  applicability: applicabilitySchema.optional(),
  requestedChanges: z.string().optional(),
  assigneeId: z.string().optional(),
  transferHistory: z.array(z.object({
    from: z.string(), to: z.string(), at: isoSchema, comment: z.string(),
  }).strict()).optional(),
  comparisonRelationIds: z.array(z.string()).optional(),
}).strict()

const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  userId: z.string(),
  topic: z.string().optional(),
  scope: z.enum(['ENTERPRISE', 'SESSION', 'BOTH']),
  summary: z.string().optional(),
  sessionAssetIds: z.array(z.string()),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  messageCount: z.number().int().nonnegative(),
  negativeFeedbackCount: z.number().int().nonnegative(),
  hasOpenIssue: z.boolean(),
  lastFeedbackType: feedbackTypeSchema.optional(),
  lastFeedbackText: z.string().optional(),
  createdAt: isoSchema,
  lastActiveAt: isoSchema,
}).strict()

const citationSchema = z.object({
  knowledgeId: z.string(),
  title: z.string(),
  assetId: z.string(),
  assetOwnerId: z.string().optional(),
  locator: z.string(),
  excerpt: z.string(),
  mediaType: z.literal('IMAGE').nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  previewUrl: z.string().nullable().optional(),
  imageAlt: z.string().nullable().optional(),
}).strict()

const draftCitationSchema = z.object({
  id: z.string(),
  title: z.string(),
  locator: z.string(),
  excerpt: z.string(),
  sourceUrl: z.string().optional(),
}).strict()

const draftSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  contentMarkdown: z.string(),
  requirementIds: z.array(z.string()),
  citationIds: z.array(z.string()),
}).strict()

const draftRequirementSchema = z.object({
  id: z.string(),
  text: z.string(),
  source: z.string().optional(),
}).strict()

const capabilityMatchSchema = z.object({
  requirementId: z.string().default(''),
  capabilityId: z.string().default(''),
  capabilityName: z.string().default(''),
  deliveryStatus: z.string().default('UNKNOWN'),
  matchType: z.string().default('UNKNOWN'),
  matchScore: z.number().min(0).max(1).default(0),
  confidence: z.number().min(0).max(1).default(0),
  citationIds: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  reviewRequired: z.boolean().default(true),
}).strict()

const draftEvidenceSchema = z.object({
  id: z.string(),
  sourceType: z.string(),
  title: z.string(),
  locator: z.string(),
  excerpt: z.string(),
  confidence: z.number().min(0).max(1),
  citationId: z.string().optional(),
}).strict()

const confidenceSummarySchema = z.object({
  enterpriseCoverage: z.number().min(0).max(1),
  evidenceCoverage: z.number().min(0).max(1),
  industryReferenceRatio: z.number().min(0).max(1),
  innovationRatio: z.number().min(0).max(1),
  notes: z.array(z.string()),
}).strict()

const solutionReviewSchema = z.object({
  status: z.string(),
  pendingItems: z.array(z.string()),
  requiredRoles: z.array(z.string()),
  decisions: z.array(z.record(z.string(), z.unknown())),
}).strict()

const solutionDraftSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  sourceRunId: z.string().optional(),
  currentVersion: z.number().int().positive(),
  status: z.enum(['GENERATING', 'READY', 'NEEDS_REVIEW', 'BLOCKED', 'SUPERSEDED']),
  title: z.string(),
  customer: z.string().optional(),
  customerContext: z.string(),
  executiveSummary: z.string(),
  requirements: z.array(draftRequirementSchema),
  sections: z.array(draftSectionSchema),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  risks: z.array(z.string()),
  conflicts: z.array(z.object({
    claim: z.string(),
    alternatives: z.array(z.object({
      statement: z.string(),
      applicability: z.record(z.string(), z.string()),
      citationIds: z.array(z.string()),
    }).strict()),
    applicability: z.string(),
    citationIds: z.array(z.string()),
    status: z.enum(['UNRESOLVED', 'SCOPED']),
  }).strict()),
  evidenceGaps: z.array(z.string()),
  citations: z.array(draftCitationSchema),
  capabilityMatches: z.array(capabilityMatchSchema).default([]),
  architecture: z.record(z.string(), z.unknown()).default({}),
  evidence: z.array(draftEvidenceSchema).default([]),
  confidenceSummary: confidenceSummarySchema.optional(),
  review: solutionReviewSchema.optional(),
  executionTrace: z.object({
    status: z.string(),
    startedAt: isoSchema.nullable().optional(),
    finishedAt: isoSchema.nullable().optional(),
    elapsedMs: z.number().nonnegative(),
    steps: z.array(z.object({
      stage: z.string(),
      label: z.string(),
      message: z.string(),
      status: z.string(),
      startedAt: isoSchema.nullable().optional(),
      finishedAt: isoSchema.nullable().optional(),
      elapsedMs: z.number().nonnegative(),
    }).strict()),
  }).optional(),
  quality: z.object({
    status: z.enum(['GENERATING', 'READY', 'NEEDS_REVIEW', 'BLOCKED', 'SUPERSEDED']),
    evidenceCoverage: z.number().min(0).max(1),
    missingSections: z.array(z.string()),
    invalidCitations: z.array(z.string()),
    notes: z.array(z.string()),
  }).strict(),
  createdAt: isoSchema,
  updatedAt: isoSchema,
  versions: z.array(z.object({
    version: z.number().int().positive(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: isoSchema,
  }).strict()).optional(),
}).strict()

const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(['USER', 'ASSISTANT']),
  text: z.string(),
  skillId: z.enum(['MATERIAL_SEARCH', 'SOLUTION_DRAFT', 'MEETING_ANALYSIS']).optional(),
  answerStatus: z.enum(['SUPPORTED', 'INSUFFICIENT', 'CONFLICTING']).optional(),
  materialIds: z.array(z.string()).optional(),
  solutionDraftId: z.string().optional(),
  citations: z.array(citationSchema),
  createdAt: isoSchema,
  feedback: z.object({
    helpful: z.boolean(),
    type: feedbackTypeSchema.optional(),
    text: z.string().optional(),
    createdAt: isoSchema,
  }).strict().optional(),
}).strict()

const distributionTaskSchema = z.object({
  id: z.string(),
  materialId: z.string(),
  requesterId: z.string(),
  channel: z.enum(['WECHAT', 'FEISHU', 'DINGTALK']),
  mode: z.literal('DEVICE_SHARE'),
  status: z.enum(['READY', 'DISPATCHED', 'FAILED', 'CANCELLED']),
  createdAt: isoSchema,
  completedAt: isoSchema.optional(),
}).strict()

export const platformSnapshotSchema = z.object({
  version: z.literal(1),
  session: z.object({
    userId: z.string(),
    role: z.enum(['EMPLOYEE', 'OWNER', 'ADMIN']),
  }).strict(),
  users: z.array(z.object({
    id: z.string(),
    name: z.string(),
    role: z.enum(['EMPLOYEE', 'OWNER', 'ADMIN']),
  }).strict()),
  assets: z.array(assetSchema),
  candidates: z.array(candidateSchema),
  knowledge: z.array(knowledgeSchema),
  knowledgeVersions: z.array(knowledgeVersionSchema).optional(),
  reviews: z.array(reviewSchema),
  crossDocumentRelations: z.array(crossDocumentRelationSchema).optional(),
  conversations: z.array(conversationSchema),
  messages: z.array(messageSchema),
  assetInputs: z.record(z.string(), z.object({
    content: z.string(),
    mimeType: z.string(),
    contentBase64: z.string().optional(),
  }).strict()),
  distributionTasks: z.array(distributionTaskSchema).optional(),
  solutionDrafts: z.array(solutionDraftSchema).optional(),
}).strict()

export function parseSnapshot(input: unknown): PlatformSnapshot {
  const result = platformSnapshotSchema.safeParse(input)
  if (!result.success) {
    throw new Error('INVALID_DATA_FILE')
  }
  return result.data
}
