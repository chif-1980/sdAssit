import { ulid } from 'ulid'

import type {
  Asset,
  Citation,
  Conversation,
  ConversationMessage,
  ConversationSkillId,
  Knowledge,
  PlatformSnapshot,
} from '../../shared/domain/models.js'
import type { ConversationScope } from '../../shared/domain/enums.js'
import { createBusinessId } from '../../shared/domain/ids.js'
import { deriveApplicability } from './crossDocumentService.js'
import type { PlatformRepository } from './ports.js'

export interface CreateConversationInput {
  scope: ConversationScope
  title?: string
  sessionAssetIds?: string[]
}

export interface AddMessageInput {
  text: string
  scope?: ConversationScope
  sessionAssetIds?: string[]
  materialIds?: string[]
  skillId?: ConversationSkillId
  answerOverride?: AnswerPayload
}

export interface AnswerPayload {
  text: string
  confidence: 'SUPPORTED' | 'INSUFFICIENT' | 'CONFLICTING'
  citations: Citation[]
}

interface Evidence {
  title: string
  content: string
  authority: string
  updatedAt: string
  citation: Citation
  logicalFactKey?: string
  applicability?: Knowledge['applicability']
}

function now() {
  return new Date().toISOString()
}

function messageId() {
  return `MSG-${ulid()}`
}

function assertScope(scope: ConversationScope) {
  if (!['ENTERPRISE', 'SESSION', 'BOTH'].includes(scope)) throw new Error('INVALID_REQUEST')
}

function assertConversationOwner(snapshot: PlatformSnapshot, conversation: Conversation) {
  if (conversation.userId !== snapshot.session.userId) throw new Error('FORBIDDEN')
}

function tokenize(value: string) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  return [...new Set(normalized.match(/[\p{Script=Han}]|[a-z0-9]+/giu) ?? [])]
}

function scoreEvidence(question: string, evidence: Evidence) {
  const tokens = tokenize(question)
  if (!tokens.length) return 0
  const haystack = `${evidence.title}${evidence.content}`.normalize('NFKC').toLocaleLowerCase()
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0)
}

function authorityRank(authority: string) {
  return Number(authority.slice(1)) || 0
}

function applicabilityKey(scope: Knowledge['applicability']) {
  return Object.entries(scope ?? {})
    .filter(([key]) => key !== 'locale')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('|') || 'generic'
}

function applicabilityLabel(scope: Knowledge['applicability']) {
  const labels = Object.entries(scope ?? {})
    .filter(([key]) => key !== 'locale')
    .map(([key, value]) => `${key}=${value}`)
  return labels.length ? `（适用：${labels.join('，')}）` : ''
}

function eligibleKnowledge(snapshot: PlatformSnapshot, scope: ConversationScope) {
  if (scope === 'SESSION') return []
  const actor = snapshot.users.find((user) => user.id === snapshot.session.userId && user.role === snapshot.session.role)
  if (!actor) return []
  return snapshot.knowledge.filter((knowledge) => knowledge.status === 'ACTIVE'
    && knowledge.aiEnabled && knowledge.indexStatus === 'INDEXED')
}

function eligibleSessionAssets(snapshot: PlatformSnapshot, conversation: Conversation, scope: ConversationScope) {
  if (scope === 'ENTERPRISE') return []
  const requested = new Set(conversation.sessionAssetIds)
  return snapshot.assets.filter((asset) => asset.ownerId === conversation.userId
    && asset.isSessionAsset
    && asset.processStatus === 'PROCESSED'
    && (asset.expiresAt === undefined || asset.expiresAt > now())
    && requested.has(asset.id))
}

function evidenceForKnowledge(knowledge: Knowledge, snapshot: PlatformSnapshot): Evidence | undefined {
  const asset = snapshot.assets.find((item) => item.id === knowledge.primaryAssetId)
    ?? (knowledge.aliasAssetIds ?? []).map((id) => snapshot.assets.find((item) => item.id === id)).find(Boolean)
  if (!asset) return undefined
  return {
    title: knowledge.title,
    content: knowledge.content,
    authority: knowledge.authority,
    updatedAt: knowledge.updatedAt,
    citation: {
      knowledgeId: knowledge.id,
      title: knowledge.title,
      assetId: asset.id,
      assetOwnerId: asset.ownerId,
      locator: knowledge.sourceLocator,
      excerpt: knowledge.content,
    },
    logicalFactKey: knowledge.logicalFactKey ?? `${knowledge.category}:${knowledge.title}:${knowledge.content}`,
    applicability: knowledge.applicability,
  }
}

function evidenceForAsset(asset: Asset): Evidence[] {
  return asset.sections.map((section) => ({
    title: section.title,
    content: section.excerpt,
    authority: asset.authority,
    updatedAt: asset.updatedAt,
    citation: {
      knowledgeId: asset.id,
      title: asset.title,
      assetId: asset.id,
      assetOwnerId: asset.ownerId,
      locator: section.locator,
      excerpt: section.excerpt,
    },
  }))
}

function buildAnswer(snapshot: PlatformSnapshot, conversation: Conversation, question: string, scope: ConversationScope): AnswerPayload {
  const evidence: Evidence[] = []
  for (const knowledge of eligibleKnowledge(snapshot, scope)) {
    const item = evidenceForKnowledge(knowledge, snapshot)
    if (item) evidence.push(item)
  }
  for (const asset of eligibleSessionAssets(snapshot, conversation, scope)) evidence.push(...evidenceForAsset(asset))

  const questionScope = deriveApplicability(question)
  const ranked = evidence
    .map((item) => ({ item, score: scoreEvidence(question, item) }))
    .filter(({ score }) => score > 0)
    .filter(({ item }) => !item.applicability || Object.entries(questionScope).every(([key, value]) => {
      const scopedValue = item.applicability?.[key as keyof NonNullable<Evidence['applicability']>]
      return !value || !scopedValue || value === scopedValue
    }))
    .sort((left, right) => authorityRank(right.item.authority) - authorityRank(left.item.authority)
      || right.score - left.score
      || right.item.updatedAt.localeCompare(left.item.updatedAt)
      || left.item.citation.knowledgeId.localeCompare(right.item.citation.knowledgeId))
    .slice(0, 8)

  const distinctFacts = new Map<string, typeof ranked[number]>()
  for (const match of ranked) {
    const key = `${match.item.logicalFactKey ?? match.item.citation.knowledgeId}:${applicabilityKey(match.item.applicability)}`
    const current = distinctFacts.get(key)
    if (!current || match.score > current.score || authorityRank(match.item.authority) > authorityRank(current.item.authority)) {
      distinctFacts.set(key, match)
    }
  }
  const selected = [...distinctFacts.values()].slice(0, 3)

  if (!selected.length) {
    return {
      text: '没有足够可靠资料回答这个问题。',
      confidence: 'INSUFFICIENT',
      citations: [],
    }
  }

  const citations = selected.map(({ item }) => item.citation)
  const distinctNumericFacts = new Set(selected
    .map(({ item }) => item.content.match(/\d+(?:\.\d+)?[^。！？!?；;]*/u)?.[0])
    .filter((value): value is string => Boolean(value)))
  const selectedAssetIds = new Set(selected.map(({ item }) => item.citation.assetId))
  const hasUnresolvedConflict = (snapshot.crossDocumentRelations ?? []).some((relation) =>
    relation.relationType === 'CONFLICT' && relation.status !== 'RESOLVED'
      && selectedAssetIds.has(relation.leftAssetId) && selectedAssetIds.has(relation.rightAssetId))
  const confidence = distinctNumericFacts.size > 1 || hasUnresolvedConflict ? 'CONFLICTING' : 'SUPPORTED'
  const selectedText = selected.map(({ item }) => `${applicabilityLabel(item.applicability)}${item.content}`).join('\n')
  return {
    text: hasUnresolvedConflict
      ? `检索到可能存在冲突的资料，请先确认适用范围：\n${selectedText}`
      : selectedText,
    confidence,
    citations,
  }
}

function conversationTitle(text: string) {
  const value = text.trim().replace(/\s+/gu, ' ')
  return value ? value.slice(0, 40) : '新对话'
}

export class ConversationService {
  constructor(private readonly repository: PlatformRepository) {}

  async list() {
    const snapshot = await this.repository.read()
    return snapshot.conversations
      .filter((conversation) => conversation.userId === snapshot.session.userId)
      .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt))
  }

  async create(input: CreateConversationInput) {
    assertScope(input.scope)
    return this.repository.transact((draft) => {
      const sessionAssetIds = (input.sessionAssetIds ?? [])
        .filter((assetId, index, ids) => ids.indexOf(assetId) === index)
      if (sessionAssetIds.some((assetId) => !draft.assets.some((asset) => asset.id === assetId
        && asset.ownerId === draft.session.userId && asset.isSessionAsset))) throw new Error('ASSET_NOT_FOUND')

      const timestamp = now()
      const conversation: Conversation = {
        id: createBusinessId('conversation'),
        title: input.title?.trim() || '新对话',
        userId: draft.session.userId,
        scope: input.scope,
        sessionAssetIds,
        status: 'ACTIVE',
        messageCount: 0,
        negativeFeedbackCount: 0,
        hasOpenIssue: false,
        createdAt: timestamp,
        lastActiveAt: timestamp,
      }
      draft.conversations.push(conversation)
      return structuredClone(conversation)
    })
  }

  async detail(id: string) {
    const snapshot = await this.repository.read()
    const conversation = snapshot.conversations.find((item) => item.id === id)
    if (!conversation) throw new Error('CONVERSATION_NOT_FOUND')
    assertConversationOwner(snapshot, conversation)
    const messages = snapshot.messages
      .filter((message) => message.conversationId === conversation.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    const sessionAssetIds = new Set(conversation.sessionAssetIds)
    const sessionAssets = snapshot.assets.filter((asset) => sessionAssetIds.has(asset.id)
      && asset.ownerId === conversation.userId && asset.isSessionAsset)
    return { conversation, messages, sessionAssets }
  }

  async addMessage(id: string, input: AddMessageInput) {
    const text = input.text.trim()
    if (!text) throw new Error('INVALID_REQUEST')
    if (input.scope !== undefined) assertScope(input.scope)

    return this.repository.transact((draft) => {
      const target = draft.conversations.find((item) => item.id === id)
      if (!target) throw new Error('CONVERSATION_NOT_FOUND')
      assertConversationOwner(draft, target)
      if (target.status !== 'ACTIVE') throw new Error('CONVERSATION_ARCHIVED')
      const scope = input.scope ?? target.scope
      const sessionAssetIds = input.sessionAssetIds ?? target.sessionAssetIds
      if (sessionAssetIds.some((assetId) => !draft.assets.some((asset) => asset.id === assetId
        && asset.ownerId === draft.session.userId && asset.isSessionAsset))) throw new Error('ASSET_NOT_FOUND')
      const answer = input.answerOverride ?? buildAnswer(draft, { ...target, scope, sessionAssetIds }, text, scope)
      const timestamp = now()
      target.scope = scope
      if (input.sessionAssetIds) {
        target.sessionAssetIds = [...new Set(input.sessionAssetIds)]
      }
      if (target.messageCount === 0) {
        target.title = conversationTitle(text)
        target.topic = target.title
      }
      target.summary = answer.text
      target.messageCount += 2
      target.lastActiveAt = timestamp

      const userMessage: ConversationMessage = {
        id: messageId(), conversationId: id, role: 'USER', text, citations: [], createdAt: timestamp,
      }
      const assistantMessage: ConversationMessage = {
        id: messageId(), conversationId: id, role: 'ASSISTANT', text: answer.text,
        ...(input.skillId ? { skillId: input.skillId } : {}),
        answerStatus: answer.confidence,
        ...(input.materialIds?.length ? { materialIds: [...new Set(input.materialIds)] } : {}),
        citations: answer.citations, createdAt: now(),
      }
      draft.messages.push(userMessage, assistantMessage)
      return {
        conversation: structuredClone(target),
        userMessage: structuredClone(userMessage),
        message: structuredClone(assistantMessage),
        answer,
      }
    })
  }

  async archive(id: string) {
    const conversation = await this.repository.transact((draft) => {
      const target = draft.conversations.find((item) => item.id === id)
      if (!target) throw new Error('CONVERSATION_NOT_FOUND')
      assertConversationOwner(draft, target)
      target.status = 'ARCHIVED'
      target.lastActiveAt = now()
      return structuredClone(target)
    })
    return { conversation }
  }

  async restore(id: string) {
    const conversation = await this.repository.transact((draft) => {
      const target = draft.conversations.find((item) => item.id === id)
      if (!target) throw new Error('CONVERSATION_NOT_FOUND')
      assertConversationOwner(draft, target)
      target.status = 'ACTIVE'
      target.lastActiveAt = now()
      return structuredClone(target)
    })
    return { conversation }
  }
}
