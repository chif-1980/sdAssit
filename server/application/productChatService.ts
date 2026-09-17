import type {
  MaterialDistributionResponse,
  MaterialShareChannel,
} from '../../shared/api/materials.js'
import type {
  ProductCitation,
  ProductConversation,
  ProductMaterial,
  ProductMessage,
  SolutionDraftEditRequest,
} from '../../shared/api/product.js'
import type { ProductSkillCatalogResponse, ProductSkillDefinition, ProductSkillId } from '../../shared/api/skills.js'
import type { Asset, Citation, ConversationMessage, DistributionTask, PlatformSnapshot, SolutionDraft } from '../../shared/domain/models.js'
import { createBusinessId } from '../../shared/domain/ids.js'
import { ConversationService, displayConversationTitle, imageCitationFromText, type AddMessageInput } from './conversationService.js'
import type { PlatformRepository } from './ports.js'
import { buildCapabilityIndex, confirmSolutionDraft, createAgentSolutionDraft, createLocalSolutionDraft, editLocalSolutionDraft, normalizeSolutionAnswerForDisplay, normalizeSolutionDraftForDisplay, renderLocalSolutionDraft } from './solutionDraftService.js'
import { ulid } from 'ulid'

const skillCatalog: ProductSkillDefinition[] = [
  {
    id: 'MATERIAL_SEARCH',
    label: '查资料',
    description: '找产品说明、宣传手册和解决方案',
    prompt: '请帮我找一份产品说明、宣传手册和解决方案。',
    triggerKeywords: [
      '资料', '文档', '文件', '产品说明', '宣传手册', '宣传册', '解决方案', '白皮书',
      '查一下', '查找', '检索', '搜索', '寻找', '找一下', '找一份', '相关文档',
      '下载', '分发', '原文',
    ],
    availability: 'AVAILABLE',
    stage: 1,
  },
  {
    id: 'SOLUTION_DRAFT',
    label: '做方案 / 汇报',
    description: '输入需求，生成可确认的方案草稿',
    prompt: '我有一条业务需求，请结合企业正式资料生成方案草稿和汇报提纲。',
    triggerKeywords: [
      '做方案', '做解决方案', '制定方案', '制定解决方案', '生成方案', '生成解决方案',
      '实施方案', '方案草稿', '方案汇报', '汇报材料', '业务需求', '客户需求', '提纲',
      '售前', '起草方案', '起草汇报', '草稿',
    ],
    availability: 'AVAILABLE',
    stage: 2,
  },
  {
    id: 'MEETING_ANALYSIS',
    label: '分析会议',
    description: '提炼摘要、待办和产品建议',
    prompt: '请分析我上传的会议纪要，提炼摘要、待办和产品建议。',
    triggerKeywords: ['会议', '纪要', '待办', '行动项'],
    availability: 'PLANNED',
    stage: 3,
  },
]

const materialTypeLabels: Record<Asset['businessType'], string> = {
  PRODUCT_DOCUMENT: '产品说明',
  SOLUTION: '解决方案',
  POLICY: '政策规范',
  PROCESS: '流程文档',
  TRAINING: '培训资料',
  CUSTOMER_MEETING: '客户会议',
  INTERNAL_MEETING: '内部会议',
  PROJECT_DOCUMENT: '项目资料',
  SESSION_UPLOAD: '会话资料',
  OTHER: '其他资料',
}

function authorityRank(authority: Asset['authority']) {
  return Number(authority.slice(1)) || 0
}

function encodeCitationId(knowledgeId: string, assetId: string, locator: string) {
  return `CIT-${Buffer.from(JSON.stringify({ knowledgeId, assetId, locator }), 'utf8').toString('base64url')}`
}

function decodeCitationId(id: string) {
  if (!id.startsWith('CIT-')) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(id.slice(4), 'base64url').toString('utf8')) as unknown
    if (!decoded || typeof decoded !== 'object') return undefined
    const value = decoded as Record<string, unknown>
    if (typeof value.knowledgeId !== 'string' || typeof value.assetId !== 'string' || typeof value.locator !== 'string') return undefined
    return { knowledgeId: value.knowledgeId, assetId: value.assetId, locator: value.locator }
  } catch {
    return undefined
  }
}

function materialPath(asset: Asset) {
  return asset.sourceUrl ?? `飞书知识库 / ${asset.title}`
}

function materialTypeLabel(asset: Asset) {
  if (/宣传手册|宣传册/u.test(asset.title)) return '宣传手册'
  return materialTypeLabels[asset.businessType]
}

function isFeishuSource(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
      && (parsed.hostname === 'feishu.cn' || parsed.hostname.endsWith('.feishu.cn')
        || parsed.hostname === 'larksuite.com' || parsed.hostname.endsWith('.larksuite.com'))
  } catch {
    return false
  }
}

function citationId(citation: Citation) {
  return encodeCitationId(citation.knowledgeId, citation.assetId, citation.locator)
}

function citationImage(citation: Pick<Citation, 'mediaType' | 'imageUrl' | 'previewUrl' | 'imageAlt' | 'excerpt'>) {
  if (citation.mediaType === 'IMAGE' && citation.imageUrl) {
    return {
      mediaType: 'IMAGE' as const,
      imageUrl: citation.imageUrl,
      previewUrl: citation.previewUrl ?? citation.imageUrl,
      ...(citation.imageAlt ? { imageAlt: citation.imageAlt } : {}),
    }
  }
  return imageCitationFromText(citation.excerpt)
}

function toProductCitation(citation: Citation, snapshot: PlatformSnapshot): ProductCitation {
  const asset = snapshot.assets.find((item) => item.id === citation.assetId)
  const knowledge = snapshot.knowledge.find((item) => item.id === citation.knowledgeId)
  const image = citationImage(citation)
  return {
    id: citationId(citation),
    kind: 'ENTERPRISE_EVIDENCE',
    title: citation.title,
    path: asset ? materialPath(asset) : null,
    locator: citation.locator,
    excerpt: citation.excerpt,
    versionAt: knowledge?.updatedAt ?? asset?.updatedAt ?? null,
    ...(image ?? {}),
  }
}

function toProductConversation(conversation: {
  id: string
  title: string
  status: 'ACTIVE' | 'ARCHIVED'
  messageCount: number
  createdAt: string
  lastActiveAt: string
}): ProductConversation {
  return {
    id: conversation.id,
    title: displayConversationTitle(conversation.title),
    status: conversation.status,
    messageCount: conversation.messageCount,
    createdAt: conversation.createdAt,
    updatedAt: conversation.lastActiveAt,
  }
}

function conversationTimeline(snapshot: PlatformSnapshot, conversationId: string) {
  // The repository array is the authoritative insertion order.  ULIDs are
  // intentionally not used as a tie breaker here: user/assistant pairs are
  // often created within the same millisecond, and lexical id ordering can
  // put the assistant before its request and break continuation recovery.
  return snapshot.messages.filter((item) => item.conversationId === conversationId)
}

function adjacentSolutionDrafts(
  message: ConversationMessage,
  messageIndex: number,
  timeline: readonly ConversationMessage[],
  snapshot: PlatformSnapshot,
) {
  const drafts: SolutionDraft[] = []
  const direct = message.solutionDraftId
    ? snapshot.solutionDrafts?.find((draft) => draft.id === message.solutionDraftId)
    : undefined
  if (direct) drafts.push(direct)
  // User messages do not carry a solutionDraftId in the legacy snapshot
  // schema.  Resolve the draft from the assistant on the same side of the
  // pair, stopping at the next assistant turn so unrelated prose is never
  // treated as a solution answer.
  for (let index = messageIndex + 1; index < timeline.length; index += 1) {
    const candidate = timeline[index]
    if (candidate.role !== 'ASSISTANT') continue
    if (candidate.solutionDraftId) {
      const draft = snapshot.solutionDrafts?.find((item) => item.id === candidate.solutionDraftId)
      if (draft && !drafts.some((item) => item.id === draft.id)) drafts.push(draft)
    }
    break
  }
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const candidate = timeline[index]
    if (candidate.role !== 'ASSISTANT') continue
    if (candidate.solutionDraftId) {
      const draft = snapshot.solutionDrafts?.find((item) => item.id === candidate.solutionDraftId)
      if (draft && !drafts.some((item) => item.id === draft.id)) drafts.push(draft)
    }
    break
  }
  return drafts
}

function hasSolutionAnswerValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.some((item) => hasSolutionAnswerValue(item))
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('value' in record || 'answer' in record) return hasSolutionAnswerValue(record.value ?? record.answer)
    return Object.keys(record).length > 0
  }
  return true
}

function answerOnlyForQuestions(content: string, draft: SolutionDraft | undefined) {
  const trimmed = content.trim()
  if (!trimmed || !draft?.clarificationQuestions?.length) return false
  if (/(^|\n)补充信息：?/u.test(trimmed)) return false
  const questions = draft.clarificationQuestions
  const values = new Set(questions.flatMap((question) => [
    question.id,
    ...question.options.map((option) => option.id),
    ...question.options.map((option) => option.label),
  ].map((value) => value.trim().toLocaleLowerCase()).filter(Boolean)))
  if (values.has(trimmed.toLocaleLowerCase())) return true
  // Batch/legacy clients can persist `QUESTION_ID: option_id` lines instead
  // of a scalar. Treat the message as answer-only only when every line maps
  // to a known clarification id and has a non-empty value.
  const mappedLines = trimmed.split('\n').map((line) => /^\s*([^：:]{1,120})[：:]\s*(\S.*)\s*$/u.exec(line)).filter(Boolean) as RegExpExecArray[]
  if (mappedLines.length && mappedLines.every((match) => {
    const question = questions.find((item) => item.id.toLocaleLowerCase() === match[1].trim().toLocaleLowerCase())
    return Boolean(question && match[2].trim() && (
      question.options.some((option) => option.id.toLocaleLowerCase() === match[2].trim().toLocaleLowerCase()
        || option.label.trim().toLocaleLowerCase() === match[2].trim().toLocaleLowerCase())
      || /^其他[：:]/u.test(match[2].trim())
      || /暂不确定|跳过/u.test(match[2].trim())
    ))
  })) return true
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.entries(parsed as Record<string, unknown>).length > 0
          && Object.entries(parsed as Record<string, unknown>).every(([key, value]) => {
            const question = questions.find((item) => item.id.toLocaleLowerCase() === key.toLocaleLowerCase())
            return Boolean(question && hasSolutionAnswerValue(value))
          })
      }
    } catch {
      // Fall through to normal prose handling.
    }
  }
  return false
}

function previousSolutionRequest(
  assistantIndex: number,
  draft: SolutionDraft | undefined,
  timeline: readonly ConversationMessage[],
) {
  if (!draft) return ''
  const directPrevious = assistantIndex > 0 && timeline[assistantIndex - 1]?.role === 'USER'
    ? timeline[assistantIndex - 1]
    : undefined
  let root = directPrevious?.text?.trim() || draft.customerContext.trim()
  const answers: string[] = []

  // An old continuation persisted only the scalar answer as the user turn.
  // Recover the original request from the blocked solution pair before it.
  if (directPrevious && answerOnlyForQuestions(directPrevious.text, draft)) {
    for (let index = assistantIndex - 2; index >= 0; index -= 1) {
      const candidate = timeline[index]
      if (candidate.role === 'ASSISTANT') {
        if (!candidate.solutionDraftId) break
        const priorUser = timeline[index - 1]
        if (priorUser?.role === 'USER') root = priorUser.text.trim()
        break
      }
    }
    answers.push(directPrevious.text.trim())
  }

  // A legacy blocked draft can be followed by one or more answer-only user
  // turns before the final assistant projection.  Include only values that
  // match this draft's clarification set and stop at the next assistant.
  for (let index = assistantIndex + 1; index < timeline.length; index += 1) {
    const candidate = timeline[index]
    if (candidate.role === 'ASSISTANT') break
    if (candidate.role === 'USER' && (
      answerOnlyForQuestions(candidate.text, draft)
      || /(^|\n)补充信息：?/u.test(candidate.text)
    )) answers.push(candidate.text.trim())
  }
  if (!answers.length) return root
  const supplement = answers.join('\n')
  if (/(^|\n)补充信息：?/u.test(root)) return `${root}\n${supplement}`
  return `${root}\n\n补充信息：\n${supplement}`
}

function solutionDisplayContext(
  message: ConversationMessage,
  snapshot: PlatformSnapshot,
) {
  const timeline = conversationTimeline(snapshot, message.conversationId)
  const messageIndex = timeline.findIndex((item) => item.id === message.id)
  if (messageIndex < 0) return { text: message.text, request: '', draft: undefined as SolutionDraft | undefined }
  const drafts = adjacentSolutionDrafts(message, messageIndex, timeline, snapshot)
  const draft = drafts[0]
  if (!draft) return { text: message.text, request: '', draft: undefined as SolutionDraft | undefined }
  // A resumed user turn is commonly adjacent to a final draft whose
  // clarificationQuestions have already been filtered out.  Retain the
  // preceding blocked draft's options as display metadata so values such as
  // `ENTERPRISE` can still be rendered as “企业客户” after a refresh.
  const mergedQuestions = drafts.flatMap((item) => item.clarificationQuestions ?? [])
    .filter((question, index, all) => all.findIndex((candidate) => candidate.id === question.id) === index)
  const contextDraft = mergedQuestions.length
    ? { ...draft, clarificationQuestions: mergedQuestions }
    : draft
  const request = message.role === 'ASSISTANT'
    ? previousSolutionRequest(messageIndex, contextDraft, timeline)
    : (() => {
      // Only the immediately following assistant can be the response to this
      // user turn.  Skipping a normal assistant would incorrectly attach an
      // unrelated later solution draft to an intervening question or reply.
      let assistantIndex = -1
      for (let index = messageIndex + 1; index < timeline.length; index += 1) {
        if (timeline[index].role === 'ASSISTANT') {
          assistantIndex = index
          break
        }
      }
      const nextAssistant = assistantIndex >= 0 ? timeline[assistantIndex] : undefined
      return nextAssistant?.solutionDraftId
        ? previousSolutionRequest(assistantIndex, contextDraft, timeline)
        : message.text
    })()
  return {
    text: normalizeSolutionAnswerForDisplay(message.text, mergedQuestions),
    request,
    draft: contextDraft,
  }
}

function toProductMessage(message: ConversationMessage, snapshot: PlatformSnapshot): ProductMessage {
  const context = solutionDisplayContext(message, snapshot)
  const solutionDraft = context.draft ? normalizeSolutionDraftForDisplay(context.draft, context.request) : undefined
  return {
    id: message.id,
    role: message.role,
    content: solutionDraft && message.role === 'ASSISTANT'
      ? renderLocalSolutionDraft(solutionDraft)
      : context.text,
    ...(message.skillId ? { skillId: message.skillId } : {}),
    answerStatus: message.answerStatus ?? null,
    citations: message.citations.map((citation) => toProductCitation(citation, snapshot)),
    ...(message.materialIds?.length
      ? { materials: message.materialIds.flatMap((id) => {
        const material = materialForAsset(snapshot, id)
        return material ? [material] : []
      }) }
      : {}),
    ...(solutionDraft ? { solutionDraft } : {}),
    createdAt: message.createdAt,
    feedbackRating: message.feedback ? (message.feedback.helpful ? 'LIKE' : 'DISLIKE') : null,
    feedbackReasonType: message.feedback?.type === 'WRONG'
      ? 'CONTENT_ERROR'
      : message.feedback?.type === 'MISSING'
        ? 'MISSING_SOURCE'
        : message.feedback?.type ?? null,
    feedbackReasonText: message.feedback?.text ?? null,
  }
}

function eligibleKnowledge(snapshot: PlatformSnapshot) {
  return snapshot.knowledge.filter((knowledge) => knowledge.status === 'ACTIVE'
    && knowledge.aiEnabled && knowledge.indexStatus === 'INDEXED')
}

function eligibleAssetIds(snapshot: PlatformSnapshot) {
  return new Set(eligibleKnowledge(snapshot).flatMap((knowledge) => [
    knowledge.primaryAssetId,
    ...(knowledge.supportingAssetIds ?? []),
    ...(knowledge.aliasAssetIds ?? []),
  ]))
}

function materialSearchScore(query: string, asset: Asset) {
  const normalized = query.trim().normalize('NFKC').toLocaleLowerCase()
  if (!normalized) return 1
  const haystack = `${asset.title}\n${asset.summary ?? ''}\n${asset.sections.map((section) => section.excerpt).join('\n')}`
    .normalize('NFKC').toLocaleLowerCase()
  return [...new Set(normalized.match(/[\p{Script=Han}]|[a-z0-9]+/giu) ?? [])]
    .reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0)
}

function materialSearchQuery(content: string) {
  const query = content
    .replace(/@[\p{Script=Han}A-Za-z0-9_/-]+/gu, ' ')
    .replace(/(?:请|帮我|帮忙|给我|查一下|查|找一下|找|一份|资料|下载|分发|打开|查看|原文)/gu, ' ')
    .replace(/[，。！？、,.!?；;：:]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return query
}

function materialForAsset(snapshot: PlatformSnapshot, assetId: string): ProductMaterial | undefined {
  const allowedKnowledge = eligibleKnowledge(snapshot)
  const allowed = new Set(allowedKnowledge.flatMap((knowledge) => [
    knowledge.primaryAssetId,
    ...knowledge.supportingAssetIds,
    ...(knowledge.aliasAssetIds ?? []),
  ]))
  const asset = snapshot.assets.find((item) => item.id === assetId && !item.isSessionAsset
    && item.processStatus === 'PROCESSED' && allowed.has(item.id))
  if (!asset) return undefined
  const primaryKnowledge = allowedKnowledge
    .filter((knowledge) => knowledge.primaryAssetId === asset.id
      || knowledge.supportingAssetIds.includes(asset.id)
      || knowledge.aliasAssetIds?.includes(asset.id))
    .sort((left, right) => authorityRank(right.authority) - authorityRank(left.authority))[0]
  const sourceSection = asset.sections[0]
  const citation: Citation = {
    knowledgeId: primaryKnowledge?.id ?? asset.id,
    title: primaryKnowledge?.title ?? asset.title,
    assetId: asset.id,
    assetOwnerId: asset.ownerId,
    locator: primaryKnowledge?.primaryAssetId === asset.id
      ? primaryKnowledge.sourceLocator
      : sourceSection?.locator ?? primaryKnowledge?.sourceLocator ?? 'document',
    excerpt: primaryKnowledge?.primaryAssetId === asset.id
      ? primaryKnowledge.content
      : sourceSection?.excerpt ?? primaryKnowledge?.content ?? asset.summary ?? '',
    ...imageCitationFromText(primaryKnowledge?.primaryAssetId === asset.id
      ? primaryKnowledge.content
      : sourceSection?.excerpt ?? primaryKnowledge?.content ?? asset.summary ?? ''),
  }
  const input = snapshot.assetInputs[asset.id]
  return {
    id: asset.id,
    title: asset.title,
    type: materialTypeLabel(asset),
    fileName: asset.title,
    mimeType: input?.mimeType ?? 'application/octet-stream',
    sizeBytes: input ? Buffer.byteLength(input.content, 'utf8') : 0,
    updatedAt: asset.updatedAt,
    summary: asset.summary ?? primaryKnowledge?.content ?? '',
    status: 'PUBLISHED',
    approvalStatus: 'APPROVED',
    publicationStatus: 'PUBLISHED',
    citation: toProductCitation(citation, snapshot),
  }
}

function materialSearchAnswer(materials: ProductMaterial[]): AddMessageInput['answerOverride'] {
  if (!materials.length) {
    return {
      text: '没有找到符合条件且已审核、已发布的资料。可以换一个产品名称或关键词再试。',
      confidence: 'INSUFFICIENT',
      citations: [],
    }
  }

  const citations = materials.slice(0, 8).flatMap((material) => {
    const key = decodeCitationId(material.citation.id)
    if (!key) return []
    return [{
      knowledgeId: key.knowledgeId,
      title: material.citation.title,
      assetId: key.assetId,
      assetOwnerId: undefined,
      locator: key.locator,
      excerpt: material.citation.excerpt,
      ...(citationImage(material.citation) ?? {}),
    } satisfies Citation]
  })

  return {
    text: `已找到 ${materials.length} 份符合条件的资料，仅展示已审核、已发布并完成索引的内容。`,
    confidence: 'SUPPORTED',
    citations,
  }
}

function inferSkillId(content: string) {
  const matched = skillCatalog
    .map((skill) => ({ skill, score: skill.triggerKeywords.reduce((score, keyword) => score + (content.includes(keyword) ? 1 : 0), 0) }))
    .sort((left, right) => right.score - left.score)[0]
  return matched && matched.score > 0 ? matched.skill.id : undefined
}

function skillForId(id: ProductSkillId) {
  return skillCatalog.find((skill) => skill.id === id)
}

function unavailableSkillAnswer(skill: ProductSkillDefinition): AddMessageInput['answerOverride'] {
  return {
    text: `「${skill.label}」将在第 ${skill.stage ?? 2} 阶段开放。当前版本先支持查资料；你可以继续使用普通问答，或输入“查资料”调用资料检索。`,
    confidence: 'INSUFFICIENT',
    citations: [],
  }
}

export interface ProductFeedbackInput {
  rating: 'LIKE' | 'DISLIKE' | null
  reasonType?: 'CONTENT_ERROR' | 'OUTDATED' | 'MISSING_SOURCE' | 'CITATION_ERROR' | 'OTHER'
  reasonText?: string
}

export class ProductChatService {
  private readonly conversations: ConversationService

  constructor(private readonly repository: PlatformRepository) {
    this.conversations = new ConversationService(repository)
  }

  skills(): ProductSkillCatalogResponse {
    return { skills: structuredClone(skillCatalog) }
  }

  async capabilityIndex() {
    const snapshot = await this.repository.read()
    return buildCapabilityIndex(snapshot)
  }

  async listConversations() {
    return (await this.conversations.list()).map(toProductConversation)
  }

  async createConversation() {
    const conversation = await this.conversations.create({ scope: 'ENTERPRISE' })
    return toProductConversation(conversation)
  }

  async uploadAttachment(conversationId: string, file: { name: string; mimeType: string; content: Buffer }) {
    const attachment = await this.repository.transact((snapshot) => {
      const conversation = snapshot.conversations.find((item) => item.id === conversationId)
      if (!conversation || conversation.userId !== snapshot.session.userId) throw new Error('CONVERSATION_NOT_FOUND')
      const id = createBusinessId('asset')
      const isText = file.mimeType.startsWith('text/') || /\.(md|markdown|txt|csv)$/iu.test(file.name)
      const content = isText ? file.content.toString('utf8') : `[附件 ${file.name}，已上传，需由方案 Agent 解析]`
      const timestamp = new Date().toISOString()
      snapshot.assets.push({
        id,
        title: file.name,
        assetType: file.mimeType.startsWith('image/') ? 'IMAGE' : 'DOCUMENT',
        businessType: 'SESSION_UPLOAD',
        provider: 'LOCAL',
        externalId: id,
        ownerId: snapshot.session.userId,
        authority: 'L0',
        processStatus: 'PROCESSED',
        summary: content.slice(0, 500),
        createdAt: timestamp,
        updatedAt: timestamp,
        isSessionAsset: true,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        sections: [{ id: `${id}-section`, title: file.name, locator: 'document', excerpt: content.slice(0, 2000) }],
      })
      snapshot.assetInputs[id] = {
        content,
        mimeType: file.mimeType || 'application/octet-stream',
        ...(isText ? {} : { contentBase64: file.content.toString('base64') }),
      }
      if (!conversation.sessionAssetIds.includes(id)) conversation.sessionAssetIds.push(id)
      return { id, name: file.name, mimeType: file.mimeType, size: file.content.byteLength, status: 'READY' as const }
    })
    return attachment
  }

  async attachmentFile(conversationId: string, attachmentId: string) {
    const snapshot = await this.repository.read()
    const conversation = snapshot.conversations.find((item) => item.id === conversationId)
    const asset = snapshot.assets.find((item) => item.id === attachmentId)
    if (!conversation || conversation.userId !== snapshot.session.userId) throw new Error('CONVERSATION_NOT_FOUND')
    if (!asset || !asset.isSessionAsset || asset.ownerId !== snapshot.session.userId || !conversation.sessionAssetIds.includes(attachmentId)) {
      throw new Error('ASSET_NOT_FOUND')
    }
    const input = snapshot.assetInputs[attachmentId]
    if (!input) throw new Error('ASSET_NOT_FOUND')
    return {
      name: asset.title,
      mimeType: input.mimeType,
      content: input.contentBase64 ? Buffer.from(input.contentBase64, 'base64') : Buffer.from(input.content, 'utf8'),
    }
  }

  async detail(id: string) {
    const detail = await this.conversations.detail(id)
    const snapshot = await this.repository.read()
    return {
      conversation: toProductConversation(detail.conversation),
      messages: detail.messages.map((message) => toProductMessage(message, snapshot)),
    }
  }

  async addMessage(
    id: string,
    content: string,
    requestedSkillId?: ProductSkillId,
    attachmentIds: string[] = [],
    sourceRunId?: string,
    executionTrace?: SolutionDraft['executionTrace'],
  ) {
    const skillId = requestedSkillId ?? inferSkillId(content)
    const skill = skillId ? skillForId(skillId) : undefined
    if (skillId === 'SOLUTION_DRAFT') {
      if (sourceRunId) {
        const existing = (await this.repository.read()).solutionDrafts?.find((item) => item.sourceRunId === sourceRunId)
        if (existing) {
          const final = await this.detail(id)
          const assistant = final.messages.find((message) => message.solutionDraft?.id === existing.id)
          const user = [...final.messages].slice(0, final.messages.indexOf(assistant ?? final.messages.at(-1)!)).at(-1)
          if (assistant && user) return { conversation: final.conversation, userMessage: user, assistantMessage: assistant }
        }
      }
      const result = await this.conversations.addMessage(id, {
        text: content,
        skillId,
        sessionAssetIds: attachmentIds,
        answerOverride: {
          text: '正在生成方案草稿…',
          confidence: 'INSUFFICIENT',
          citations: [],
        },
      })
      const snapshot = await this.repository.read()
      const resolvedSourceRunId = sourceRunId ?? `local-${ulid()}`
      const requiresClarification = !executionTrace?.steps.some((step) => step.stage === 'WAITING_FOR_INPUT')
      const rawDraft = createLocalSolutionDraft(snapshot, id, content, attachmentIds, resolvedSourceRunId, executionTrace, requiresClarification)
      const displayContent = normalizeSolutionAnswerForDisplay(content, rawDraft.clarificationQuestions ?? [])
      const draft = normalizeSolutionDraftForDisplay(rawDraft, displayContent)
      await this.repository.transact((next) => {
        next.solutionDrafts ??= []
        next.solutionDrafts.push(draft)
        const user = next.messages.find((message) => message.id === result.userMessage.id)
        if (user) user.text = displayContent
        const assistant = next.messages.find((message) => message.id === result.message.id)
        if (assistant) {
          assistant.solutionDraftId = draft.id
          assistant.text = renderLocalSolutionDraft(draft)
          assistant.answerStatus = draft.conflicts.length ? 'CONFLICTING' : draft.status === 'BLOCKED' ? 'INSUFFICIENT' : 'SUPPORTED'
          assistant.citations = draft.citations.flatMap((citation) => {
            const match = citation.id.startsWith('DRAFT-')
              ? (() => { try { return JSON.parse(Buffer.from(citation.id.slice(6), 'base64url').toString('utf8')) as { knowledgeId: string; assetId: string } } catch { return undefined } })()
              : undefined
            return match ? [{ knowledgeId: match.knowledgeId, title: citation.title, assetId: match.assetId, locator: citation.locator, excerpt: citation.excerpt }] : []
          })
        }
      })
      const final = await this.detail(id)
      return {
        conversation: final.conversation,
        userMessage: final.messages.at(-2)!,
        assistantMessage: final.messages.at(-1)!,
      }
    }
    const materials = skillId === 'MATERIAL_SEARCH'
      ? await this.searchMaterials(materialSearchQuery(content))
      : []
    const answerOverride = skill?.availability === 'PLANNED'
      ? unavailableSkillAnswer(skill)
      : skillId === 'MATERIAL_SEARCH'
        ? materialSearchAnswer(materials)
        : undefined
    const result = await this.conversations.addMessage(id, {
      text: content,
      materialIds: materials.map((material) => material.id),
      ...(skillId ? { skillId } : {}),
      ...(answerOverride ? { answerOverride } : {}),
    } satisfies AddMessageInput)
    const snapshot = await this.repository.read()
    return {
      conversation: toProductConversation(result.conversation),
      userMessage: toProductMessage(result.userMessage, snapshot),
      assistantMessage: {
        ...toProductMessage(result.message, snapshot),
        ...(materials.length ? { materials } : {}),
      },
    }
  }

  /** Persist a completed Yuxi Agent Run as a local product draft projection. */
  async addAgentSolutionMessage(
    id: string,
    content: string,
    attachmentIds: string[],
    sourceRunId: string,
    payload: unknown,
  ) {
    const snapshot = await this.repository.read()
    const existing = snapshot.solutionDrafts?.find((item) => item.sourceRunId === sourceRunId)
    if (existing) {
      const final = await this.detail(id)
      const assistant = final.messages.find((message) => message.solutionDraft?.id === existing.id)
      const assistantIndex = assistant ? final.messages.indexOf(assistant) : -1
      const user = assistantIndex > 0 ? final.messages[assistantIndex - 1] : undefined
      if (assistant && user) return { conversation: final.conversation, userMessage: user, assistantMessage: assistant }
    }
    const rawDraft = createAgentSolutionDraft(snapshot, id, sourceRunId, payload, content)
    const displayContent = normalizeSolutionAnswerForDisplay(content, rawDraft.clarificationQuestions ?? [])
    const draft = normalizeSolutionDraftForDisplay(rawDraft, displayContent)
    const result = await this.conversations.addMessage(id, {
      text: displayContent,
      skillId: 'SOLUTION_DRAFT',
      sessionAssetIds: attachmentIds,
      answerOverride: { text: '正在生成方案草稿…', confidence: 'INSUFFICIENT', citations: [] },
    })
    await this.repository.transact((next) => {
      next.solutionDrafts ??= []
      if (!next.solutionDrafts.some((item) => item.sourceRunId === sourceRunId)) next.solutionDrafts.push(draft)
      const assistant = next.messages.find((message) => message.id === result.message.id)
      if (assistant) {
        assistant.solutionDraftId = draft.id
        assistant.text = renderLocalSolutionDraft(draft)
        assistant.answerStatus = draft.conflicts.length ? 'CONFLICTING' : draft.status === 'BLOCKED' ? 'INSUFFICIENT' : 'SUPPORTED'
      }
    })
    const final = await this.detail(id)
    return { conversation: final.conversation, userMessage: final.messages.at(-2)!, assistantMessage: final.messages.at(-1)! }
  }

  async getSolutionDraft(id: string) {
    const snapshot = await this.repository.read()
    const draft = snapshot.solutionDrafts?.find((item) => item.id === id)
    if (!draft) throw new Error('SOLUTION_DRAFT_NOT_FOUND')
    const conversation = snapshot.conversations.find((item) => item.id === draft.conversationId)
    if (!conversation || conversation.userId !== snapshot.session.userId) throw new Error('FORBIDDEN')
    return draft
  }

  async updateSolutionDraft(id: string, patch: SolutionDraftEditRequest) {
    return this.repository.transact((snapshot) => {
      const draft = snapshot.solutionDrafts?.find((item) => item.id === id)
      if (!draft) throw new Error('SOLUTION_DRAFT_NOT_FOUND')
      const conversation = snapshot.conversations.find((item) => item.id === draft.conversationId)
      if (!conversation || conversation.userId !== snapshot.session.userId) throw new Error('FORBIDDEN')
      const updated = editLocalSolutionDraft(draft, patch)
      snapshot.solutionDrafts = (snapshot.solutionDrafts ?? []).map((item) => item.id === id ? updated : item)
      const linked = snapshot.messages.find((message) => message.solutionDraftId === id)
      if (linked) {
        linked.text = renderLocalSolutionDraft(updated)
        linked.answerStatus = updated.conflicts.length ? 'CONFLICTING' : updated.status === 'BLOCKED' ? 'INSUFFICIENT' : 'SUPPORTED'
      }
      return structuredClone(updated)
    })
  }

  async confirmSolutionDraft(id: string) {
    return this.repository.transact((snapshot) => {
      const draft = snapshot.solutionDrafts?.find((item) => item.id === id)
      if (!draft) throw new Error('SOLUTION_DRAFT_NOT_FOUND')
      const conversation = snapshot.conversations.find((item) => item.id === draft.conversationId)
      if (!conversation || conversation.userId !== snapshot.session.userId) throw new Error('FORBIDDEN')
      const confirmed = confirmSolutionDraft(draft)
      snapshot.solutionDrafts = (snapshot.solutionDrafts ?? []).map((item) => item.id === id ? confirmed : item)
      const linked = snapshot.messages.find((message) => message.solutionDraftId === id)
      if (linked) {
        linked.text = renderLocalSolutionDraft(confirmed)
        linked.answerStatus = 'SUPPORTED'
      }
      return structuredClone(confirmed)
    })
  }

  async archive(id: string) {
    const result = await this.conversations.archive(id)
    return toProductConversation(result.conversation)
  }

  async restore(id: string) {
    const result = await this.conversations.restore(id)
    return toProductConversation(result.conversation)
  }

  async searchMaterials(query = ''): Promise<ProductMaterial[]> {
    const snapshot = await this.repository.read()
    const allowed = eligibleAssetIds(snapshot)
    return snapshot.assets
      .filter((asset) => !asset.isSessionAsset && asset.processStatus === 'PROCESSED' && allowed.has(asset.id))
      .map((asset) => ({ material: materialForAsset(snapshot, asset.id), score: materialSearchScore(query, asset) }))
      .filter((item): item is { material: ProductMaterial; score: number } => Boolean(item.material))
      .filter((asset) => asset.score > 0)
      .sort((left, right) => right.score - left.score
        || right.material.updatedAt.localeCompare(left.material.updatedAt))
      .map(({ material }) => material)
  }

  async resolveCitation(id: string) {
    const key = decodeCitationId(id)
    if (!key) throw new Error('CITATION_NOT_FOUND')
    const snapshot = await this.repository.read()
    const knowledge = eligibleKnowledge(snapshot).find((item) => item.id === key.knowledgeId)
    const asset = snapshot.assets.find((item) => item.id === key.assetId)
    if (!knowledge || !asset || asset.isSessionAsset || asset.processStatus !== 'PROCESSED') throw new Error('CITATION_NOT_FOUND')
    const linked = knowledge.primaryAssetId === asset.id
      || knowledge.supportingAssetIds.includes(asset.id)
      || knowledge.aliasAssetIds?.includes(asset.id)
    if (!linked) throw new Error('CITATION_NOT_FOUND')
    const source = knowledge.sourceLocator === key.locator
      ? { ...knowledge, excerpt: knowledge.content }
      : asset.sections.find((section) => section.locator === key.locator)
    if (!source) throw new Error('CITATION_NOT_FOUND')
    const citation: Citation = {
      knowledgeId: knowledge.id,
      title: knowledge.title,
      assetId: asset.id,
      assetOwnerId: asset.ownerId,
      locator: key.locator,
      excerpt: 'excerpt' in source ? source.excerpt : knowledge.content,
    }
    return toProductCitation(citation, snapshot)
  }

  async openCitation(id: string) {
    const citation = await this.resolveCitation(id)
    const snapshot = await this.repository.read()
    const key = decodeCitationId(id)
    const asset = key ? snapshot.assets.find((item) => item.id === key.assetId) : undefined
    if (!asset?.sourceUrl || !isFeishuSource(asset.sourceUrl)) throw new Error('SOURCE_NOT_AVAILABLE')
    return { citation, sourceUrl: asset.sourceUrl }
  }

  async downloadMaterial(id: string) {
    const snapshot = await this.repository.read()
    const allowed = eligibleAssetIds(snapshot)
    const asset = snapshot.assets.find((item) => item.id === id && !item.isSessionAsset
      && item.processStatus === 'PROCESSED' && allowed.has(item.id))
    if (!asset) throw new Error('MATERIAL_NOT_FOUND')
    const input = snapshot.assetInputs[id]
    if (!input) throw new Error('MATERIAL_NOT_FOUND')
    return { asset, content: input.content, mimeType: input.mimeType }
  }

  async createDistribution(materialId: string, channel: MaterialShareChannel): Promise<MaterialDistributionResponse> {
    if (channel === 'DINGTALK') throw new Error('CHANNEL_NOT_AVAILABLE')
    const material = await this.downloadMaterial(materialId)
    const task = await this.repository.transact((draft) => {
      const distribution: DistributionTask = {
        id: createBusinessId('distribution'),
        materialId,
        requesterId: draft.session.userId,
        channel,
        mode: 'DEVICE_SHARE',
        status: 'READY',
        createdAt: new Date().toISOString(),
      }
      if (!draft.distributionTasks) draft.distributionTasks = []
      draft.distributionTasks.push(distribution)
      return structuredClone(distribution)
    })
    return {
      distribution: task,
      title: material.asset.title,
      text: `${material.asset.title}\n${material.asset.summary ?? ''}\n来源：${materialPath(material.asset)}`.trim(),
      downloadUrl: `/api/chat/materials/${encodeURIComponent(materialId)}/download`,
      requiresUserConfirmation: true,
    }
  }

  async updateFeedback(messageId: string, input: ProductFeedbackInput) {
    const result = await this.repository.transact((draft) => {
      const message = draft.messages.find((item) => item.id === messageId && item.role === 'ASSISTANT')
      if (!message) throw new Error('MESSAGE_NOT_FOUND')
      const conversation = draft.conversations.find((item) => item.id === message.conversationId)
      if (!conversation) throw new Error('CONVERSATION_NOT_FOUND')
      if (conversation.userId !== draft.session.userId) throw new Error('FORBIDDEN')
      const previousDislike = message.feedback && !message.feedback.helpful
      const nextDislike = input.rating === 'DISLIKE'
      if (previousDislike && !nextDislike) conversation.negativeFeedbackCount = Math.max(0, conversation.negativeFeedbackCount - 1)
      if (!previousDislike && nextDislike) conversation.negativeFeedbackCount += 1
      if (input.rating === null) {
        message.feedback = undefined
      } else {
        const type = input.reasonType === 'CONTENT_ERROR'
          ? 'WRONG'
          : input.reasonType === 'MISSING_SOURCE'
            ? 'MISSING'
            : input.reasonType
        message.feedback = {
          helpful: input.rating === 'LIKE',
          ...(type ? { type } : {}),
          ...(input.reasonText?.trim() ? { text: input.reasonText.trim() } : {}),
          createdAt: new Date().toISOString(),
        }
      }
      conversation.lastFeedbackType = message.feedback?.type
      conversation.lastFeedbackText = message.feedback?.text
      return { message: structuredClone(message), conversation: structuredClone(conversation) }
    })
    return {
      messageId,
      feedbackRating: result.message.feedback ? (result.message.feedback.helpful ? 'LIKE' : 'DISLIKE') : null,
      feedbackReasonType: result.message.feedback?.type === 'WRONG'
        ? 'CONTENT_ERROR'
        : result.message.feedback?.type === 'MISSING'
          ? 'MISSING_SOURCE'
          : result.message.feedback?.type ?? null,
      feedbackReasonText: result.message.feedback?.text ?? null,
    }
  }
}
