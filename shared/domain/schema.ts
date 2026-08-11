import { z } from 'zod'

import type { PlatformSnapshot } from './models.js'

const authoritySchema = z.enum(['L0', 'L1', 'L2', 'L3'])
const isoSchema = z.string().datetime()
const knowledgeTypeSchema = z.enum([
  'PRODUCT_CAPABILITY', 'PRODUCT_PARAMETER', 'TECHNICAL', 'FAQ', 'PROCESS',
  'POLICY', 'BEST_PRACTICE', 'PROJECT', 'OTHER',
])
const feedbackTypeSchema = z.enum(['WRONG', 'OUTDATED', 'MISSING', 'CITATION_ERROR', 'OTHER'])

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
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  reviewRequired: z.boolean(),
  reviewerId: z.string().optional(),
  candidateHash: z.string(),
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
  status: z.enum(['PENDING', 'RESOLVED', 'CANCELLED']),
  resolutionAction: z.enum([
    'CREATE_KNOWLEDGE', 'UPDATE_KNOWLEDGE', 'KEEP_CURRENT',
    'REJECT_CANDIDATE', 'ARCHIVE_KNOWLEDGE', 'CONFIRM_VALID',
  ]).optional(),
  finalContent: z.string().optional(),
  decisionComment: z.string().optional(),
  conversationId: z.string().optional(),
  feedbackType: feedbackTypeSchema.optional(),
  feedbackText: z.string().optional(),
  createdAt: isoSchema,
  dueAt: isoSchema.optional(),
  resolvedAt: isoSchema.optional(),
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
}).strict()

const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(['USER', 'ASSISTANT']),
  text: z.string(),
  citations: z.array(citationSchema),
  createdAt: isoSchema,
  feedback: z.object({
    helpful: z.boolean(),
    type: feedbackTypeSchema.optional(),
    text: z.string().optional(),
    createdAt: isoSchema,
  }).strict().optional(),
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
  reviews: z.array(reviewSchema),
  conversations: z.array(conversationSchema),
  messages: z.array(messageSchema),
  assetInputs: z.record(z.string(), z.object({
    content: z.string(),
    mimeType: z.string(),
  }).strict()),
}).strict()

export function parseSnapshot(input: unknown): PlatformSnapshot {
  const result = platformSnapshotSchema.safeParse(input)
  if (!result.success) {
    throw new Error('INVALID_DATA_FILE')
  }
  return result.data
}
