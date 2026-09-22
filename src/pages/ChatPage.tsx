import { MeetingHistoryPicker } from '../components/chat/MeetingHistoryPicker'
import { Archive, ArchiveRestore, ArrowDown, BookOpen, ChevronDown, ChevronUp, Info, MessageCircle, PanelLeft, PencilLine, Plus, RefreshCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  MaterialDistributionResponse,
  MaterialShareChannel,
} from '../../shared/api/materials.js'
import type {
  AnswerMode,
  FeedbackRating,
  FeedbackReasonType,
  ProductAnswerProgress,
  ProductAgentInterrupt,
  ProductAttachment,
  ProductCitation,
  ProductConversation,
  ProductMaterial,
  ProductMessage,
  SolutionDraftEditRequest,
  SolutionExecutionTrace,
} from '../../shared/api/product.js'
import { ApiError, api, streamApi } from '../api/client'
import { ChatComposer } from '../components/chat/ChatComposer'
import type { ComposerAttachment, ComposerMention } from '../components/chat/ChatComposer'
import { businessTasks, composerMentions, inferBusinessTask, type BusinessTask } from '../components/chat/businessTasks'
import { ConversationOutline } from '../components/chat/ConversationOutline'
import { MeetingActivity, type MeetingActivityTask } from '../components/chat/MeetingActivity'
import { MessageThread } from '../components/chat/MessageThread'
import { enrichClarificationQuestion, type ClarificationAnswer } from '../components/chat/ClarificationCard'
import { clarificationQuestionsForDraft } from '../components/chat/SolutionDraftCard'
import { MaterialDistributionDialog } from '../components/chat/MaterialDistributionDialog'
import { canShareMaterialFiles, openShareApplication, shareMaterialViaDevice, type ShareApplicationOpenResult } from '../components/chat/materialSharing'
import { messagePairAnchorId } from '../components/chat/messagePairs'
import { SourceDrawer } from '../components/chat/SourceDrawer'
import { attachmentError as getAttachmentError } from '../components/chat/fileAttachments'
import { ProductShell } from '../components/layout/ProductShell'
import { useSession } from '../session/SessionProvider'
import { safeReturnPath } from '../session/returnPath'

interface ConversationDetail {
  conversation: ProductConversation
  messages: ProductMessage[]
}

interface SendResponse {
  conversation: ProductConversation
  userMessage: ProductMessage
  assistantMessage: ProductMessage
}

interface FeedbackResponse {
  messageId: string
  feedbackRating: FeedbackRating | null
  feedbackReasonType?: FeedbackReasonType | null
  feedbackReasonText?: string | null
}

const MAX_COMPOSER_ATTACHMENTS = 5
const MEETING_REVISION_PROMPT = '@会议纪要 请按以下要求修改：'

const exampleQuestions = [
  '投标一体机定价体系',
  '语音智控的技术架构',
] as const

const FALLBACK_CONVERSATION_TITLE = '未命名会话'

type InterruptQuestionView = {
  id?: string
  question: string
  questionId?: string
  type?: ProductAgentInterrupt['type']
  options?: ProductAgentInterrupt['options']
  required?: boolean
  allowSkip?: boolean
  position?: number
  total?: number
}

export function normalizeInterrupt(value: unknown, runId?: string): ProductAgentInterrupt | undefined {
  if (!value || typeof value !== 'object') return undefined
  const payload = value as Record<string, unknown>
  const rawQuestions = Array.isArray(payload.questions) && payload.questions.length
    ? payload.questions
    : [payload]
  const seenIds = new Set<string>()
  const seenTexts = new Set<string>()
  const questions = rawQuestions.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    const question = typeof item.question === 'string' && item.question.trim()
      ? item.question.trim()
      : typeof item.prompt === 'string' && item.prompt.trim()
        ? item.prompt.trim()
        : undefined
    if (!question) return []
    const questionId = typeof item.questionId === 'string' && item.questionId.trim()
      ? item.questionId.trim()
      : typeof item.id === 'string' && item.id.trim()
        ? item.id.trim()
        : typeof payload.questionId === 'string' && payload.questionId.trim()
          ? payload.questionId.trim()
          : `question-${index + 1}`
    const normalizedText = question.replace(/\s+/gu, ' ')
    if (seenIds.has(questionId) || seenTexts.has(normalizedText)) return []
    seenIds.add(questionId)
    seenTexts.add(normalizedText)
    const typeValue = item.type ?? payload.type
    const type = typeValue === 'SINGLE_CHOICE' || typeValue === 'MULTIPLE_CHOICE' || typeValue === 'TEXT'
      ? typeValue
      : undefined
    const rawOptions = item.options ?? item.choices ?? payload.options
    const options = Array.isArray(rawOptions)
      ? rawOptions.flatMap((optionValue) => {
      if (!optionValue || typeof optionValue !== 'object') return []
      const option = optionValue as Record<string, unknown>
      const id = typeof option.id === 'string' ? option.id : ''
      const label = typeof option.label === 'string' ? option.label : id
      return id && label ? [{ id, label, ...(typeof option.description === 'string' ? { description: option.description } : {}) }] : []
    })
    : undefined
    return [enrichClarificationQuestion({
      id: questionId,
      question,
      questionId,
      ...(type ? { type } : {}),
      ...(options?.length ? { options } : {}),
      required: item.required !== false && payload.required !== false,
      allowSkip: item.allowSkip !== false && payload.allowSkip !== false,
      ...(typeof item.position === 'number' ? { position: item.position } : {}),
      ...(typeof item.total === 'number' ? { total: item.total } : {}),
    } satisfies InterruptQuestionView)]
  })
  if (!questions.length) return undefined
  const normalizedQuestions = questions.map((question, index) => ({
    ...question,
    id: question.questionId ?? question.id ?? `question-${index + 1}`,
    questionId: question.questionId ?? question.id ?? `question-${index + 1}`,
    position: index + 1,
    total: questions.length,
  }))
  const first = normalizedQuestions[0]
  return {
    ...first,
    questions: normalizedQuestions,
    ...(runId ? { runId } : typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
    status: 'INTERRUPTED',
  } as ProductAgentInterrupt
}

function normalizeConversation(conversation: ProductConversation): ProductConversation {
  const title = typeof conversation.title === 'string' ? conversation.title.trim() : ''
  return { ...conversation, title: title || FALLBACK_CONVERSATION_TITLE }
}

/**
 * Resume requests send option ids to the Agent so the runtime can make a
 * deterministic decision.  Those ids are an implementation detail, though,
 * and should never be rendered as the user's conversational reply.  Prefer
 * the option label from the active question and keep a small compatibility
 * map for legacy questions that were persisted without their options.
 */
const legacyClarificationLabels: Record<string, string> = {
  confirmed: '已确定',
  planning: '已有候选，尚未最终确认',
  undecided: '尚未确定',
  other: '其他情况',
  self_operated: '自营',
  platform: '平台入驻 / 多商户',
  distribution: '分销',
  store_delivery: '门店配送',
  user_app: '用户端',
  admin: '运营管理端',
  catalog: '商品管理与上下架',
  transaction: '购物车、下单和支付',
  small: '少于 100 个 SKU',
  medium: '100–1000 个 SKU',
  large: '超过 1000 个 SKU',
  erp: 'ERP / 业务系统',
  inventory: '库存系统',
  logistics: '物流 / 配送系统',
  service: '客服 / 会员系统',
  none: '暂无系统需要对接',
  refund: '退款与售后',
  coupon: '优惠券 / 促销',
  membership: '会员 / 积分',
  group_buy: '拼团 / 秒杀',
}

export function displayClarificationAnswer(
  answer: ClarificationAnswer,
  question?: ProductAgentInterrupt,
) {
  const questions: InterruptQuestionView[] = question?.questions?.length
    ? question.questions
    : question
      ? [question]
      : []
  /**
   * Convert an Agent-facing option id into the label a user selected.  The
   * runtime has historically returned ids with different casing and, for
   * multi-select answers, occasionally serialized an array as a string.  Do
   * this conversion at the product boundary so neither the transcript nor a
   * pending-answer bubble leaks implementation details such as `confirmed`.
   */
  const displayValue = (value: unknown, currentQuestion?: InterruptQuestionView): string => {
    const enrichedQuestion = currentQuestion ? enrichClarificationQuestion(currentQuestion) : undefined
    const options = enrichedQuestion?.options ?? []
    const optionByLower = new Map(options.map((option) => [option.id.toLocaleLowerCase(), option.label]))
    const legacyByLower = new Map(Object.entries(legacyClarificationLabels).map(([id, label]) => [id.toLocaleLowerCase(), label]))
    const knownIds = new Set([...optionByLower.keys(), ...legacyByLower.keys()])

    if (Array.isArray(value)) {
      return value.map((item) => displayValue(item, currentQuestion)).filter(Boolean).join('、')
    }
    if (value && typeof value === 'object') {
      // Keep nested values readable without exposing a JavaScript object
      // representation.  This also handles adapters that wrap a scalar as
      // `{ value: "confirmed" }`.
      const record = value as Record<string, unknown>
      if ('value' in record || 'answer' in record) return displayValue(record.value ?? record.answer, currentQuestion)
      return Object.values(record).map((item) => displayValue(item, currentQuestion)).filter(Boolean).join('、')
    }
    if (typeof value !== 'string') return value == null ? '' : String(value)
    const normalized = value.trim()
    if (!normalized) return ''
    if (normalized === '（用户暂不确定）' || normalized === '(用户暂不确定)' || normalized === '暂不确定') return '暂不确定'

    // Some older resume adapters persisted a JSON array in the message body.
    // Parse only an array-shaped string; ordinary prose remains unchanged.
    if (normalized.startsWith('[') && normalized.endsWith(']')) {
      try {
        const parsed = JSON.parse(normalized) as unknown
        if (Array.isArray(parsed)) return displayValue(parsed, currentQuestion)
      } catch {
        // Fall through to conservative token handling for JSON-ish strings.
      }
    }

    const labelFor = (token: string) => {
      const tokenKey = token.trim().toLocaleLowerCase()
      if (!tokenKey) return ''
      if (token.trim().startsWith('其他：') || token.trim().startsWith('其他:')) return token.trim()
      return optionByLower.get(tokenKey) ?? legacyByLower.get(tokenKey) ?? token.trim()
    }
    // Translate a plain multi-select serialization only when every segment is
    // a known id.  This avoids rewriting natural-language text containing an
    // English word that happens to resemble an option id.
    const segments = normalized.split(/[、,，;；]/u).map((item) => item.trim()).filter(Boolean)
    if (segments.length > 1 && segments.every((item) => knownIds.has(item.toLocaleLowerCase()))) {
      return segments.map(labelFor).join('、')
    }
    // JSON-ish arrays from legacy clients may use single quotes or omit
    // strict JSON quoting.  Extract only known ids, preserving surrounding
    // punctuation when there is at least one complete token.
    if (normalized.includes('[') && normalized.includes(']') && knownIds.size) {
      const extracted = [...normalized.matchAll(/[A-Za-z][A-Za-z0-9_-]*/gu)]
        .map((match) => match[0])
        .filter((token) => knownIds.has(token.toLocaleLowerCase()))
      if (extracted.length) return extracted.map(labelFor).join('、')
    }
    return labelFor(normalized)
  }
  if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
    return Object.entries(answer)
      .map(([questionId, value]) => {
        const currentQuestion = questions.find((item) => (item.questionId ?? item.id)?.toLocaleLowerCase() === questionId.toLocaleLowerCase())
        const label = currentQuestion?.question ?? questionId
        return `${label}：${displayValue(value, currentQuestion)}`
      })
      .filter(Boolean)
      .join('\n')
  }
  return displayValue(answer, questions[0])
}

function clarificationAnswerIds(answer: ClarificationAnswer, interrupt?: ProductAgentInterrupt) {
  if (answer && typeof answer === 'object' && !Array.isArray(answer)) return new Set(Object.keys(answer))
  const firstQuestion = interrupt?.questions?.[0]
  const questionId = interrupt?.questionId
    ?? firstQuestion?.questionId
    ?? firstQuestion?.id
  return questionId ? new Set([questionId]) : new Set<string>()
}

function filterAnsweredClarifications(
  questions: NonNullable<ProductMessage['solutionDraft']>['clarificationQuestions'] | undefined,
  answeredIds: ReadonlySet<string>,
) {
  if (!questions?.length || !answeredIds.size) return questions ?? []
  return questions.filter((question) => !answeredIds.has(question.id))
}

type HistoricalClarificationQuestion = NonNullable<NonNullable<ProductMessage['solutionDraft']>['clarificationQuestions']>[number]

function historicalClarificationQuestions(
  items: ProductMessage[],
  messageIndex: number,
) {
  // A resumed answer is persisted directly beside the blocked draft.  Keep
  // the lookup adjacent so a later ordinary user message cannot accidentally
  // inherit option ids from an older, unrelated clarification.
  const previous = items[messageIndex - 1]
  const next = items[messageIndex + 1]
  const source = previous?.role === 'ASSISTANT' && previous.solutionDraft?.clarificationQuestions?.length
    ? previous
    : next?.role === 'ASSISTANT' && next.solutionDraft?.clarificationQuestions?.length
      ? next
      : undefined
  return source?.solutionDraft?.clarificationQuestions ?? []
}

function normalizedHistoricalQuestions(
  items: ProductMessage[],
  messageIndex: number,
) {
  return historicalClarificationQuestions(items, messageIndex).map((question) => (
    enrichClarificationQuestion(question) as HistoricalClarificationQuestion
  ))
}

function historicalOptionLabel(value: string, question?: HistoricalClarificationQuestion) {
  const normalized = value.trim()
  if (!normalized) return ''
  if (normalized === '（用户暂不确定）' || normalized === '(用户暂不确定)') return '暂不确定'
  if (normalized.startsWith('其他：')) return normalized
  const option = question?.options?.find((item) => item.id === normalized
    || item.id.toLocaleLowerCase() === normalized.toLocaleLowerCase())
  if (option?.label) return option.label
  const legacy = Object.entries(legacyClarificationLabels)
    .find(([id]) => id.toLocaleLowerCase() === normalized.toLocaleLowerCase())?.[1]
  return legacy ?? normalized
}

function historicalQuestionById(
  questions: HistoricalClarificationQuestion[],
  questionId: string,
) {
  const normalizedId = questionId.trim().toLocaleLowerCase()
  return questions.find((item) => item.id.trim().toLocaleLowerCase() === normalizedId)
}

function historicalQuestionForOption(
  questions: HistoricalClarificationQuestion[],
  optionId: string,
) {
  const normalizedId = optionId.trim().toLocaleLowerCase()
  return questions.find((candidate) => candidate.options?.some(
    (option) => option.id.trim().toLocaleLowerCase() === normalizedId,
  ))
}

function historicalAnswerText(
  value: unknown,
  questions: HistoricalClarificationQuestion[],
  question?: HistoricalClarificationQuestion,
): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => historicalAnswerText(item, questions, question))
      .filter(Boolean)
      .join('、')
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    // Some older adapters persisted one answer as
    // `{ questionId, answer }` instead of a question-id keyed map.
    if (typeof record.questionId === 'string' && ('answer' in record || 'value' in record)) {
      const current = historicalQuestionById(questions, record.questionId)
      const display = historicalAnswerText(record.answer ?? record.value, questions, current)
      return display
        ? current ? `${current.question}：${display}` : display
        : ''
    }
    return Object.entries(record)
      .map(([questionId, answer]) => {
        const current = historicalQuestionById(questions, questionId)
        const label = current?.question ?? questionId
        const display = historicalAnswerText(answer, questions, current)
        return display ? `${label}：${display}` : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  if (!normalized) return ''
  const optionIds = new Set([
    ...questions.flatMap((item) => item.options?.map((option) => option.id) ?? []),
    ...Object.keys(legacyClarificationLabels),
  ])
  const optionIdsByLower = new Map([...optionIds].map((id) => [id.toLocaleLowerCase(), id]))
  // A persisted multi-select answer is occasionally stored as a plain
  // comma-separated string rather than JSON.  Only translate it when every
  // segment is a known option id; ordinary prose remains untouched.
  const segments = normalized.split(/[、,，;；]/u).map((item) => item.trim()).filter(Boolean)
  if (segments.length > 1 && segments.every((item) => optionIdsByLower.has(item.toLocaleLowerCase()))) {
    return segments.map((item) => historicalOptionLabel(
      item,
      question ?? historicalQuestionForOption(questions, item),
    )).join('、')
  }
  return historicalOptionLabel(
    normalized,
    question ?? historicalQuestionForOption(questions, normalized),
  )
}

function normalizeHistoricalClarificationContent(
  content: string,
  questions: HistoricalClarificationQuestion[],
) {
  if (!content.trim()) return content
  const optionIds = new Set([
    ...questions.flatMap((item) => item.options?.map((option) => option.id) ?? []),
    ...Object.keys(legacyClarificationLabels),
  ])
  const optionIdsByLower = new Map([...optionIds].map((id) => [id.toLocaleLowerCase(), id]))
  const trimmed = content.trim()

  // Newer adapters may persist a batch answer as JSON.  Render its values by
  // question while keeping unknown/custom values intact.
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const rendered = historicalAnswerText(parsed, questions)
      if (rendered) return rendered
    } catch {
      // Fall through to the conservative plain-text handling below.
    }
  }

  // Local resume runs keep the original request followed by a "补充信息"
  // section.  Translate only that section so a normal user prompt containing
  // an English word such as "admin" is never rewritten.
  const supplementMarker = /(^|\n)补充信息：?/u.exec(content)
  if (supplementMarker) {
    const markerEnd = supplementMarker.index + supplementMarker[0].length
    const prefix = content.slice(0, markerEnd)
    const supplement = content.slice(markerEnd)
    // Resume answers can be serialized as `user_app、transaction`, JSON-ish
    // arrays, or ordinary whitespace-separated values. Replace only complete
    // option-id tokens (case-insensitively) so punctuation is preserved and a
    // prose word containing an id, such as `administrator`, is untouched.
    const optionIdsByLower = new Map<string, string>()
    for (const id of optionIds) optionIdsByLower.set(id.toLocaleLowerCase(), id)
    const escapedIds = [...optionIdsByLower.keys()]
      .sort((left, right) => right.length - left.length)
      .map((id) => id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    // Batch resumes have also been persisted as `QUESTION_ID: answer` lines.
    // Resolve the line prefix before translating option ids because a
    // question id can legitimately match an option id (for example ADMIN).
    const translatedQuestionIds = supplement
      .split('\n')
      .map((line) => line.replace(
        /^(\s*(?:[-*]\s*)?)([^\s：:]+)(\s*[：:])/u,
        (match, indentation: string, questionId: string, separator: string) => {
          const current = historicalQuestionById(questions, questionId)
          return current ? `${indentation}${current.question}${separator}` : match
        },
      ))
      .join('\n')
    const translated = escapedIds.length
      ? translatedQuestionIds.replace(
        new RegExp(`(?<![A-Za-z0-9_-])(${escapedIds.join('|')})(?![A-Za-z0-9_-])`, 'giu'),
        (token) => {
          const canonicalId = optionIdsByLower.get(token.toLocaleLowerCase()) ?? token
          const question = historicalQuestionForOption(questions, canonicalId)
          return historicalOptionLabel(canonicalId, question)
        },
      )
      : translatedQuestionIds
    return `${prefix}${translated}`
  }

  // A single scalar answer (the common remote-run shape) can be translated
  // directly.  For a plain multi-select string, historicalAnswerText handles
  // the safe all-known-options case above.
  const rendered = historicalAnswerText(trimmed, questions)
  return rendered !== trimmed && (optionIdsByLower.has(trimmed.toLocaleLowerCase()) || rendered.includes('、'))
    ? content.replace(trimmed, rendered)
    : content
}

function normalizeHistoricalMessages(items: ProductMessage[]) {
  const normalized = items.map((message, index) => {
    if (message.role !== 'USER') return message
    const questions = normalizedHistoricalQuestions(items, index)
    const content = normalizeHistoricalClarificationContent(message.content, questions)
    return content === message.content ? message : { ...message, content }
  })
  return markHistoricalAnsweredClarifications(normalized)
}

/**
 * Historical transcripts predate the durable interrupt endpoint.  In those
 * transcripts a blocked draft remains in place after a resume, so rendering
 * its original questions would make an already answered card reappear after
 * a refresh.  Infer only unambiguous answers (option id/label, a structured
 * question-id map, or the explicit "补充信息" section) and mark those
 * questions resolved in the view model.  Ordinary later user messages are
 * deliberately ignored so an unrelated follow-up does not hide a pending
 * clarification.
 */
function markHistoricalAnsweredClarifications(items: ProductMessage[]) {
  return items.map((message, messageIndex) => {
    const draft = message.role === 'ASSISTANT' ? message.solutionDraft : undefined
    const questions = draft?.clarificationQuestions
    if (!draft || draft.status !== 'BLOCKED' || draft.clarificationQuestionsResolved || !questions?.length) return message
    const answeredIds = historicalAnsweredQuestionIds(items, messageIndex, questions)
    if (!answeredIds.size) return message
    const remaining = questions.filter((question) => !answeredIds.has(question.id))
    return {
      ...message,
      solutionDraft: {
        ...draft,
        clarificationQuestions: remaining,
        clarificationQuestionsResolved: remaining.length === 0,
      },
    }
  })
}

function historicalValueTokens(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => historicalValueTokens(item))
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('value' in record || 'answer' in record) return historicalValueTokens(record.value ?? record.answer)
    return Object.values(record).flatMap((item) => historicalValueTokens(item))
  }
  if (typeof value !== 'string') return []
  const text = value.trim()
  if (!text) return []
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      const parsed = JSON.parse(text) as unknown
      const parsedTokens = historicalValueTokens(parsed)
      if (parsedTokens.length) return parsedTokens
    } catch {
      // Keep conservative plain-text handling below for JSON-ish payloads.
    }
  }
  return text
    .split(/[\n、,，;；|]/u)
    .map((item) => item.replace(/^\s*[-*]\s*/u, '').trim())
    .filter(Boolean)
}

function historicalQuestionMatchesToken(question: HistoricalClarificationQuestion, token: string) {
  const normalizedToken = token.trim().toLocaleLowerCase()
  if (!normalizedToken) return false
  if (normalizedToken === '（用户暂不确定）' || normalizedToken === '(用户暂不确定)' || normalizedToken === '暂不确定' || normalizedToken === '跳过') return true
  if (normalizedToken.startsWith('其他：') || normalizedToken.startsWith('其他:')) return true
  const values = [
    question.id,
    ...(question.options ?? []).flatMap((option) => [option.id, option.label]),
    ...Object.keys(legacyClarificationLabels).filter((id) => question.options?.some((option) => option.id.toLocaleLowerCase() === id.toLocaleLowerCase()) ?? false),
  ]
  return values.some((value) => value.trim().toLocaleLowerCase() === normalizedToken)
}

function historicalAnsweredQuestionIds(
  items: ProductMessage[],
  draftIndex: number,
  questions: HistoricalClarificationQuestion[],
) {
  const answered = new Set<string>()
  const normalizedQuestions = questions.map((question) => enrichClarificationQuestion(question) as HistoricalClarificationQuestion)
  const pending = () => normalizedQuestions.filter((question) => !answered.has(question.id))
  const markByTokens = (tokens: string[], preferred?: HistoricalClarificationQuestion) => {
    for (const token of tokens) {
      const match = preferred && historicalQuestionMatchesToken(preferred, token)
        ? preferred
        : normalizedQuestions.find((question) => historicalQuestionMatchesToken(question, token))
      if (match) answered.add(match.id)
    }
  }

  for (let index = draftIndex + 1; index < items.length; index += 1) {
    const item = items[index]
    // The first subsequent assistant solution message closes this historical
    // continuation window.  Messages after it belong to a later turn.
    if (item.role === 'ASSISTANT') {
      // A multi-question resume may persist a second BLOCKED draft for the
      // remaining questions before the final continuation. Keep walking over
      // that intermediate card so the original card can be marked with all
      // answers from the complete historical chain. Stop at a normal answer
      // (or any unrelated assistant turn) to avoid consuming later prose.
      if (item.solutionDraft?.status === 'BLOCKED' && item.solutionDraft.clarificationQuestions?.length) continue
      break
    }
    const content = item.content.trim()
    if (!content) continue
    const supplement = /(?:^|\n)补充信息：?/u.exec(content)
    const answerText = supplement ? content.slice(supplement.index + supplement[0].length) : content

    // Prefer an explicit question-id map when one was persisted.  This is
    // the only safe way to distinguish two questions that share an option
    // label such as “已确定”.
    const parseCandidates = [content, answerText]
    for (const candidate of parseCandidates) {
      const trimmed = candidate.trim()
      if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) continue
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            const question = normalizedQuestions.find((itemToFind) => itemToFind.id.toLocaleLowerCase() === key.toLocaleLowerCase())
            if (question && historicalValueTokens(value).length) answered.add(question.id)
          }
        }
      } catch {
        // Not strict JSON; token matching below remains conservative.
      }
    }

    const lines = answerText.split(/\n+/u).map((line) => line.trim()).filter(Boolean)
    for (const line of lines) {
      const separator = line.search(/[：:]/u)
      if (separator > 0) {
        const left = line.slice(0, separator).trim()
        const right = line.slice(separator + 1).trim()
        const byIdOrQuestion = normalizedQuestions.find((question) => (
          question.id.toLocaleLowerCase() === left.toLocaleLowerCase()
          || question.question.trim() === left
        ))
        if (byIdOrQuestion && historicalValueTokens(right).length) {
          answered.add(byIdOrQuestion.id)
          continue
        }
        // The product's human-readable resume format prefixes a question's
        // answer with its full text. If it is not a prefix, process the right
        // side as a scalar option below.
        markByTokens(historicalValueTokens(right), byIdOrQuestion)
        continue
      }
      const tokens = historicalValueTokens(line)
      const before = answered.size
      markByTokens(tokens)
      // A supplemental free-text answer has no option id to match. Only
      // accept it when the explicit marker is present and exactly one
      // question remains, avoiding accidental suppression for normal prose.
      if (supplement && answered.size === before && pending().length === 1 && normalizedQuestions[0].type === 'TEXT') {
        answered.add(pending()[0].id)
      }
    }

    // A scalar option answer without a section marker is valid only when it
    // maps to exactly one question. This handles older remote transcripts.
    if (!supplement && answered.size === 0 && normalizedQuestions.length === 1) {
      markByTokens(historicalValueTokens(content), normalizedQuestions[0])
    }
    if (answered.size === normalizedQuestions.length) break
  }
  return answered
}

function sortConversations(conversations: ProductConversation[]) {
  return conversations
    .map(normalizeConversation)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function upsertConversation(current: ProductConversation[], next: ProductConversation) {
  const existing = current.some((item) => item.id === next.id)
  return sortConversations(existing
    ? current.map((item) => item.id === next.id ? next : item)
    : [next, ...current])
}

function nextProgressTrail(
  current: ProductAnswerProgress[],
  progress: ProductAnswerProgress,
): ProductAnswerProgress[] {
  const currentProgress = current.at(-1)
  if (currentProgress?.stage === progress.stage) {
    if (
      currentProgress.message === progress.message
      && currentProgress.status === progress.status
      && currentProgress.runId === progress.runId
      && currentProgress.elapsedMs === progress.elapsedMs
    ) return current
    return [...current.slice(0, -1), progress]
  }
  return [...current, progress].slice(-24)
}

function attachmentUploadMessage(error: unknown) {
  if (error instanceof ApiError && error.code === 'ATTACHMENTS_NOT_AVAILABLE') {
    return '当前阶段暂不支持附件处理'
  }
  if (error instanceof ApiError && (error.status === 404 || error.code === 'NOT_FOUND')) {
    return '附件解析服务暂不可用，请稍后重试'
  }
  if (error instanceof Error && error.message && !/^[A-Z][A-Z0-9_]*$/u.test(error.message)) {
    return error.message
  }
  return '附件上传失败，请重试'
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
    || Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
}

function triggerBlobDownload(blob: Blob, fileName: string) {
  if (typeof URL.createObjectURL !== 'function') return false
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = fileName || '资料'
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 0)
  return true
}

function formatMaterialSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '未知大小'
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function businessTaskFromMessages(items: ProductMessage[]): BusinessTask {
  const skillMessage = [...items].reverse().find((item) => item.role === 'ASSISTANT' && item.skillId)
  if (skillMessage?.skillId) return skillMessage.skillId
  // Conversations created before skill metadata was added can still restore
  // the material-search context from their persisted result cards.
  if ([...items].reverse().some((item) => item.role === 'ASSISTANT' && item.materials?.length)) return 'MATERIAL_SEARCH'
  return 'QA'
}

function historicalSolutionInterrupt(items: ProductMessage[]): ProductAgentInterrupt | undefined {
  // A blocked draft is a useful compatibility fallback for conversations
  // created before the active-run endpoint existed.  It is not, however, a
  // durable interrupt by itself.  Prefer the real active run and only fall
  // back to questions that are still unresolved in the historical transcript.
  let message: ProductMessage | undefined
  let messageIndex = -1
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index]
    if (
      candidate.role !== 'ASSISTANT'
      || candidate.solutionDraft?.status !== 'BLOCKED'
      || candidate.solutionDraft.clarificationQuestionsResolved
      || !candidate.solutionDraft.sourceRunId
    ) continue
    message = candidate
    messageIndex = index
    break
  }
  if (!message || messageIndex < 0) return undefined
  const draft = message.solutionDraft
  // Keep the historical interrupt in lock-step with the card renderer.  The
  // helper also recovers early projections that persisted unresolved
  // requirements but omitted both question fields; without this promotion the
  // card could show choices that the resume handler could not submit.
  const allQuestions = draft ? clarificationQuestionsForDraft(draft) : []
  if (!allQuestions.length) return undefined
  const answeredIds = historicalAnsweredQuestionIds(items, messageIndex, allQuestions)
  const questions = allQuestions.filter((question) => !answeredIds.has(question.id))
  // A later user message that cannot be identified as an answer is an
  // ordinary follow-up, not proof that this old draft is still waiting.  Do
  // not resurrect its choices in that case.  If some answers were identified
  // and other questions remain, keep only the remaining batch for resumption.
  const hasLaterUser = items.slice(messageIndex + 1).some((item) => item.role === 'USER')
  if (!questions.length || (hasLaterUser && !answeredIds.size)) return undefined
  const runId = message?.solutionDraft?.sourceRunId
  if (!questions.length || !runId) return undefined
  const first = questions[0]
  return normalizeInterrupt({
    ...enrichClarificationQuestion(first),
    questionId: first.id,
    questions: questions.map((question) => ({ ...enrichClarificationQuestion(question), id: question.id, questionId: question.id })),
  }, runId)
}

function knownSkillTokenSpans(value: string, mentions: readonly ComposerMention[]) {
  const values = mentions
    .map((mention) => mention.value)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  const spans: { start: number; end: number }[] = []

  for (let index = 0; index < value.length;) {
    if (index > 0 && !/\s/u.test(value[index - 1] ?? '')) {
      index += 1
      continue
    }
    const matched = values.find((mention) => (
      value.startsWith(mention, index)
      && (index + mention.length === value.length || /\s/u.test(value[index + mention.length] ?? ''))
    ))
    if (!matched) {
      index += 1
      continue
    }
    spans.push({ start: index, end: index + matched.length })
    index += matched.length
  }
  return spans
}

function replaceSelectedSkill(
  current: string,
  nextValue: string,
  mentions: readonly ComposerMention[],
) {
  const spans = knownSkillTokenSpans(current, mentions)
  const trailingMention = /(^|\s)@[^\s@]*$/u.exec(current)
  if (trailingMention) {
    const start = trailingMention.index + trailingMention[1].length
    const isAlreadyKnown = spans.some((span) => start >= span.start && current.length <= span.end)
    if (!isAlreadyKnown) spans.push({ start, end: current.length })
  }
  spans.sort((left, right) => left.start - right.start)
  if (spans.length) {
    let output = ''
    let cursor = 0
    let insertionIndex = 0
    spans.forEach((span, index) => {
      output += current.slice(cursor, span.start)
      if (index === 0) insertionIndex = output.length
      const trailingWhitespace = current[span.end] === ' ' ? 1 : 0
      cursor = span.end + trailingWhitespace
    })
    output += current.slice(cursor)
    return `${output.slice(0, insertionIndex)}${nextValue} ${output.slice(insertionIndex)}`
  }

  // If the menu was opened while the user was typing an incomplete @ token,
  // replace that token in place and leave the rest of the request untouched.
  const replaced = current.replace(
    /(^|\s)@[^\s@]*$/u,
    (_match, prefix: string) => `${prefix}${nextValue} `,
  )
  return replaced === current ? `${current}${current ? ' ' : ''}${nextValue} ` : replaced
}

const traceStageKeys = new Set<ProductAnswerProgress['stage']>([
  'UNDERSTANDING',
  'REQUIREMENTS_ANALYSIS',
  'CAPABILITY_MATCHING',
  'RETRIEVING',
  'ARCHITECTURE_DESIGN',
  'VERIFYING',
  'EVIDENCE_CHECK',
  'QUALITY_REVIEW',
  'COMPOSING',
  'WAITING_FOR_INPUT',
])

function traceToProgressTrail(trace: unknown, runId?: string): ProductAnswerProgress[] {
  if (!trace || typeof trace !== 'object') return []
  const value = trace as Partial<SolutionExecutionTrace> & { steps?: unknown }
  if (!Array.isArray(value.steps)) return []
  const trail: ProductAnswerProgress[] = []
  for (const rawStep of value.steps) {
    if (!rawStep || typeof rawStep !== 'object') continue
    const step = rawStep as unknown as Record<string, unknown>
    const stage = typeof step.stage === 'string' && traceStageKeys.has(step.stage as ProductAnswerProgress['stage'])
      ? step.stage as ProductAnswerProgress['stage']
      : undefined
    if (!stage) continue
    const message = typeof step.message === 'string' && step.message.trim()
      ? step.message
      : typeof step.label === 'string' && step.label.trim() ? step.label : '正在处理'
    const status = typeof step.status === 'string' ? step.status : undefined
    const elapsedMs = typeof step.elapsedMs === 'number' && Number.isFinite(step.elapsedMs) ? step.elapsedMs : undefined
    const progress = { stage, message, ...(runId ? { runId } : {}), ...(status ? { status } : {}), ...(elapsedMs !== undefined ? { elapsedMs } : {}) }
    const previous = trail.at(-1)
    if (previous?.stage === stage) trail[trail.length - 1] = progress
    else trail.push(progress)
  }
  return trail
}

interface ActiveRunResponse {
  run?: {
    runId: string
    skillId?: string
    status?: string
    streamUrl?: string
    inputContent?: string
    executionTrace?: unknown
    interrupt?: unknown
  } | null
}

export function ChatPage() {
  const { reload: reloadSession, user: sessionUser } = useSession()
  const [conversations, setConversations] = useState<ProductConversation[]>([])
  const [conversation, setConversation] = useState<ProductConversation>()
  const [messages, setMessages] = useState<ProductMessage[]>([])
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string>()
  const [answerMode, setAnswerMode] = useState<AnswerMode>('CONCISE')
  const [pendingAnswerMode, setPendingAnswerMode] = useState<AnswerMode>()
  const [pendingQuestion, setPendingQuestion] = useState<string>()
  const [agentInterruptQuestion, setAgentInterruptQuestion] = useState<ProductAgentInterrupt>()
  const [answerProgress, setAnswerProgress] = useState<ProductAnswerProgress>()
  const [answerProgressTrail, setAnswerProgressTrail] = useState<ProductAnswerProgress[]>([])
  const [streamedAnswer, setStreamedAnswer] = useState('')
  const [loadingWorkspace, setLoadingWorkspace] = useState(true)
  const [loadingConversation, setLoadingConversation] = useState(false)
  const [sending, setSending] = useState(false)
  const [currentRunId, setCurrentRunId] = useState<string>()
  const [meetingActivityTasks, setMeetingActivityTasks] = useState<MeetingActivityTask[]>([])
  const [meetingNavigationTarget, setMeetingNavigationTarget] = useState<Pick<MeetingActivityTask, 'id' | 'conversationId'>>()
  const [archiving, setArchiving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [feedbackPendingIds, setFeedbackPendingIds] = useState<Set<string>>(() => new Set())
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [activePairId, setActivePairId] = useState<string>()
  const [highlightedPairId, setHighlightedPairId] = useState<string>()
  const [errorText, setErrorText] = useState<string>()
  const [conversationListOpen, setConversationListOpen] = useState(false)
  const [sidebarPanel, setSidebarPanel] = useState<'archived' | 'activity' | null>(null)
  const showArchived = sidebarPanel === 'archived'
  const [conversationSearch, setConversationSearch] = useState('')
  const [businessTask, setBusinessTask] = useState<BusinessTask>('QA')
  const [businessTaskExplicit, setBusinessTaskExplicit] = useState(false)
  const [dirtyMeetingIds, setDirtyMeetingIds] = useState<Set<string>>(new Set())
  const meetingDirtyChanged = useCallback((id: string, dirty: boolean) => {
    setDirtyMeetingIds(previous => {
      if (previous.has(id) === dirty) return previous
      const next = new Set(previous)
      if (dirty) next.add(id); else next.delete(id)
      return next
    })
  }, [])
  const [meetingTargetId, setMeetingTargetId] = useState<string>()
  const [historyMeetingIds, setHistoryMeetingIds] = useState<string[]>([])
  const [selectedCitation, setSelectedCitation] = useState<ProductCitation>()
  const [sourceDrawerModal, setSourceDrawerModal] = useState(false)
  const [distributionMaterial, setDistributionMaterial] = useState<ProductMaterial>()
  const [distributionBusy, setDistributionBusy] = useState(false)
  const [distributionFeedback, setDistributionFeedback] = useState<string>()
  const [toastText, setToastText] = useState<string>()
  const contextVersionRef = useRef(0)
  const citationVersionRef = useRef(0)
  const answerProgressTrailRef = useRef<ProductAnswerProgress[]>([])
  const streamedAnswerRef = useRef('')
  const streamedDeltaBufferRef = useRef('')
  const streamedDeltaTimerRef = useRef<number>()
  const citationTriggerRef = useRef<HTMLButtonElement>()
  const messageScrollRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)
  const conversationSidebarRef = useRef<HTMLElement>(null)
  const conversationTriggerRef = useRef<HTMLButtonElement>(null)
  const conversationCloseRef = useRef<HTMLButtonElement>(null)
  const archivedConversationTriggerRef = useRef<HTMLButtonElement>(null)
  const restoreArchiveTriggerFocusRef = useRef(false)
  const archivedConversationCloseRef = useRef<HTMLButtonElement>(null)
  const toastTimerRef = useRef<number>()
  const sendAbortControllerRef = useRef<AbortController>()
  const currentRunIdRef = useRef<string>()
  const restoredConversationIdsRef = useRef(new Set<string>())
  const lastEventIdRef = useRef<string>()

  function flushStreamedAnswer() {
    if (streamedDeltaTimerRef.current !== undefined) {
      window.clearTimeout(streamedDeltaTimerRef.current)
      streamedDeltaTimerRef.current = undefined
    }
    const buffered = streamedDeltaBufferRef.current
    if (!buffered) return
    streamedDeltaBufferRef.current = ''
    streamedAnswerRef.current += buffered
    setStreamedAnswer(streamedAnswerRef.current)
  }

  function appendStreamedDelta(delta: string) {
    if (!delta) return
    streamedDeltaBufferRef.current += delta
    if (streamedDeltaTimerRef.current !== undefined) return
    streamedDeltaTimerRef.current = window.setTimeout(() => {
      flushStreamedAnswer()
    }, 32)
  }

  function resetStreamedAnswer() {
    if (streamedDeltaTimerRef.current !== undefined) {
      window.clearTimeout(streamedDeltaTimerRef.current)
      streamedDeltaTimerRef.current = undefined
    }
    streamedDeltaBufferRef.current = ''
    streamedAnswerRef.current = ''
    setStreamedAnswer('')
  }

  function streamRequestInit(signal: AbortSignal): RequestInit {
    const headers = new Headers()
    if (lastEventIdRef.current) headers.set('Last-Event-ID', lastEventIdRef.current)
    return { method: 'GET', signal, headers }
  }

  const recoverExpiredSession = useCallback(async (error: unknown) => {
    if (!(error instanceof ApiError) || error.status !== 401) return false
    await reloadSession()
    return true
  }, [reloadSession])

  const loadWorkspace = useCallback(async () => {
    const version = ++contextVersionRef.current
    setLoadingWorkspace(true)
    setErrorText(undefined)
    try {
      const result = await api<{ conversations: ProductConversation[] }>('/api/chat/conversations')
      if (contextVersionRef.current !== version) return
      const items = sortConversations(result.conversations)
      setConversations(items)
      const destination = safeReturnPath(window.location.pathname + window.location.search)
      const destinationQuery = destination.includes('?') ? destination.slice(destination.indexOf('?') + 1) : ''
      const destinationParams = new URLSearchParams(destinationQuery)
      const requestedConversationId = destinationParams.get('conversationId')
      const requestedMeetingId = destinationParams.get('meetingId')
      const initialConversation = requestedConversationId
        ? items.find(item => item.id === requestedConversationId)
        : items.find((item) => item.status === 'ACTIVE') ?? items[0]
      if (requestedConversationId && !initialConversation) {
        setErrorText('该会话不存在或当前账号无权查看，请从左侧选择其他会话')
      }
      setSidebarPanel(initialConversation?.status === 'ARCHIVED' ? 'archived' : null)
      if (initialConversation) {
        const detail = await api<ConversationDetail>(`/api/chat/conversations/${initialConversation.id}`)
        if (contextVersionRef.current !== version) return
        const historicalMessages = normalizeHistoricalMessages(detail.messages)
        setConversation(normalizeConversation(detail.conversation))
        setMessages(historicalMessages)
        setBusinessTask(businessTaskFromMessages(historicalMessages))
        setBusinessTaskExplicit(false)
        const historicalInterrupt = historicalSolutionInterrupt(historicalMessages)
        setAgentInterruptQuestion(historicalInterrupt)
        currentRunIdRef.current = historicalInterrupt?.runId
        setCurrentRunId(historicalInterrupt?.runId)
        if (requestedMeetingId) {
          if (historicalMessages.some(message => message.meeting?.id === requestedMeetingId)) {
            setMeetingNavigationTarget({ id: requestedMeetingId, conversationId: initialConversation.id })
          } else {
            setErrorText('当前会话中未找到该会议，会议可能已删除')
          }
        }
      } else {
        setConversation(undefined)
        setMessages([])
      }
    } catch (error) {
      if (contextVersionRef.current !== version) return
      if (await recoverExpiredSession(error)) return
      setErrorText('会话加载失败，请重试')
    } finally {
      if (contextVersionRef.current === version) setLoadingWorkspace(false)
    }
  }, [recoverExpiredSession])

  useEffect(() => {
    void loadWorkspace()
    return () => {
      sendAbortControllerRef.current?.abort()
      sendAbortControllerRef.current = undefined
      contextVersionRef.current += 1
      citationVersionRef.current += 1
      if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    }
  }, [loadWorkspace])

  useEffect(() => {
    if (conversationListOpen) conversationCloseRef.current?.focus()
  }, [conversationListOpen])

  useEffect(() => {
    if (showArchived) archivedConversationCloseRef.current?.focus()
    else if (restoreArchiveTriggerFocusRef.current) {
      archivedConversationTriggerRef.current?.focus()
      restoreArchiveTriggerFocusRef.current = false
    }
  }, [showArchived])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mediaQuery = window.matchMedia('(max-width: 1024px)')
    const syncModalState = () => setSourceDrawerModal(mediaQuery.matches)
    syncModalState()
    mediaQuery.addEventListener('change', syncModalState)
    return () => mediaQuery.removeEventListener('change', syncModalState)
  }, [])

  useEffect(() => {
    if (selectedCitation || !citationTriggerRef.current) return
    const trigger = citationTriggerRef.current
    citationTriggerRef.current = undefined
    trigger.focus()
  }, [selectedCitation])

  const lastMessageId = messages.at(-1)?.id

  useEffect(() => {
    const element = messageScrollRef.current
    if (!element) return

    const syncScrollButton = () => {
      const distanceFromBottom = element.scrollHeight - element.clientHeight - element.scrollTop
      followLatestRef.current = distanceFromBottom <= 24
      setShowScrollToBottom(element.scrollHeight > element.clientHeight + 24 && distanceFromBottom > 24)
    }

    syncScrollButton()
    element.addEventListener('scroll', syncScrollButton, { passive: true })
    window.addEventListener('resize', syncScrollButton)
    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(syncScrollButton)
      resizeObserver.observe(element)
    }
    return () => {
      element.removeEventListener('scroll', syncScrollButton)
      window.removeEventListener('resize', syncScrollButton)
      resizeObserver?.disconnect()
    }
  }, [lastMessageId, loadingConversation, loadingWorkspace, messages.length, pendingQuestion])

  useEffect(() => {
    const element = messageScrollRef.current
    if (!element) return

    const syncActivePair = () => {
      const anchors = Array.from(element.querySelectorAll<HTMLElement>('[data-message-pair]'))
      if (!anchors.length) {
        setActivePairId(undefined)
        return
      }
      const threshold = element.getBoundingClientRect().top + Math.min(180, element.clientHeight * 0.28)
      const current = anchors.reduce((candidate, anchor) => (
        anchor.getBoundingClientRect().top <= threshold ? anchor : candidate
      ), anchors[0])
      setActivePairId(current.dataset.messagePair)
    }

    syncActivePair()
    element.addEventListener('scroll', syncActivePair, { passive: true })
    window.addEventListener('resize', syncActivePair)
    return () => {
      element.removeEventListener('scroll', syncActivePair)
      window.removeEventListener('resize', syncActivePair)
    }
  }, [loadingConversation, loadingWorkspace, messages.length])

  useEffect(() => {
    if (!streamedAnswer) return
    const element = messageScrollRef.current
    if (!element) return
    if (followLatestRef.current) {
      element.scrollTop = element.scrollHeight
      setShowScrollToBottom(false)
      return
    }
    setShowScrollToBottom(element.scrollHeight > element.clientHeight + 24)
  }, [streamedAnswer])

  const recordProgress = useCallback((progress: ProductAnswerProgress) => {
    if (progress.resetAnswer) {
      resetStreamedAnswer()
    }
    const normalized = {
      ...progress,
      ...(progress.runId || !currentRunIdRef.current ? {} : { runId: currentRunIdRef.current }),
      ...(progress.status ? {} : { status: 'ACTIVE' }),
    }
    const next = nextProgressTrail(answerProgressTrailRef.current, normalized)
    if (next === answerProgressTrailRef.current) return
    answerProgressTrailRef.current = next
    setAnswerProgress(next.at(-1))
    setAnswerProgressTrail(next)
  }, [])

  const markProgressFailed = useCallback((message: string) => {
    const latest = answerProgressTrailRef.current.at(-1)
    recordProgress({
      ...latest,
      stage: latest?.stage ?? 'UNDERSTANDING',
      message: latest?.message ?? message,
      status: 'FAILED',
    })
  }, [recordProgress])

  const scrollToLatest = useCallback(() => {
    const element = messageScrollRef.current
    if (!element) return
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    followLatestRef.current = true
    setShowScrollToBottom(false)
  }, [])

  const visibleConversations = useMemo(() => sortConversations(conversations), [conversations])
  const archivedConversations = visibleConversations.filter((item) => item.status === 'ARCHIVED')
  const listedConversations = visibleConversations.filter((item) => item.status === 'ACTIVE')
  const filteredConversations = useMemo(() => {
    const query = conversationSearch.trim().toLocaleLowerCase()
    if (!query) return listedConversations
    return listedConversations.filter((item) => item.title.toLocaleLowerCase().includes(query))
  }, [conversationSearch, listedConversations])
  const filteredArchivedConversations = useMemo(() => {
    const query = conversationSearch.trim().toLocaleLowerCase()
    if (!query) return archivedConversations
    return archivedConversations.filter((item) => item.title.toLocaleLowerCase().includes(query))
  }, [conversationSearch, archivedConversations])
  const backgroundMeeting = sending && currentRunId?.startsWith('MT-')
  const switchLocked = (sending && !backgroundMeeting) || archiving || restoring || dirtyMeetingIds.size > 0
  const mutationLocked = sending || switchLocked || loadingWorkspace || loadingConversation
  const archived = conversation?.status === 'ARCHIVED'

  const applyAnswer = useCallback((
    result: SendResponse,
    userMessageContent?: string,
    answeredIds: ReadonlySet<string> = new Set<string>(),
    resolvedRunId?: string,
  ) => {
    const conversation = normalizeConversation(result.conversation)
    const originalDraft = result.assistantMessage.solutionDraft
    const remainingClarifications = filterAnsweredClarifications(originalDraft?.clarificationQuestions, answeredIds)
    // A continuation can be resumed in more than one batch by older/local
    // adapters.  The final result normally has no pending questions (or marks
    // them resolved); in that case clear every question from the historical
    // blocked card, not only the ids included in this last batch.
    const continuationCompleted = Boolean(
      originalDraft
      && (!originalDraft.clarificationQuestions?.length || originalDraft.clarificationQuestionsResolved),
    )
    const assistantMessage = originalDraft && answeredIds.size
      ? {
        ...result.assistantMessage,
        ...(pendingAnswerMode ? { answerMode: pendingAnswerMode } : {}),
        solutionDraft: {
          ...originalDraft,
          clarificationQuestions: continuationCompleted ? [] : remainingClarifications,
          clarificationQuestionsResolved: continuationCompleted || remainingClarifications.length === 0,
        },
      }
      : { ...result.assistantMessage, ...(pendingAnswerMode ? { answerMode: pendingAnswerMode } : {}) }
    const solutionDraft = assistantMessage.solutionDraft
    const firstClarification = solutionDraft?.clarificationQuestions?.[0]
    const continuationRunId = currentRunIdRef.current ?? solutionDraft?.sourceRunId
    const userMessage = userMessageContent === undefined
      ? result.userMessage
      : { ...result.userMessage, content: userMessageContent }
    setConversation(conversation)
    setConversations((current) => upsertConversation(current, conversation))
    setMessages((current) => {
      if (!answeredIds.size) {
        const ids = new Set([userMessage.id, assistantMessage.id])
        return [...current.filter(message => !ids.has(message.id)), userMessage, assistantMessage]
      }

      // The blocked draft that produced the interrupt remains in the
      // transcript while a resume run is executing.  Once that batch has
      // been answered, mark the old draft's questions as resolved before
      // appending the continuation result; otherwise the historical card
      // would render the same questions a second time below the new answer.
      let targetIndex = -1
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const candidate = current[index]
        const draft = candidate.role === 'ASSISTANT' ? candidate.solutionDraft : undefined
        if (!draft || draft.clarificationQuestionsResolved || !draft.clarificationQuestions?.length) continue
        if (resolvedRunId && draft.sourceRunId !== resolvedRunId) continue
        targetIndex = index
        break
      }
      if (targetIndex < 0 && resolvedRunId) {
        for (let index = current.length - 1; index >= 0; index -= 1) {
          const candidate = current[index]
          const draft = candidate.role === 'ASSISTANT' ? candidate.solutionDraft : undefined
          if (draft && !draft.clarificationQuestionsResolved && draft.clarificationQuestions?.length) {
            targetIndex = index
            break
          }
        }
      }
      const resolvedMessages = targetIndex < 0
        ? current
        : current.map((message, index) => {
          if (index !== targetIndex || !message.solutionDraft) return message
          const remaining = continuationCompleted
            ? []
            : filterAnsweredClarifications(message.solutionDraft.clarificationQuestions, answeredIds)
          return {
            ...message,
            solutionDraft: {
              ...message.solutionDraft,
              clarificationQuestions: remaining,
              clarificationQuestionsResolved: continuationCompleted || remaining.length === 0,
            },
          }
        })
      return [...resolvedMessages, userMessage, assistantMessage]
    })
    setPendingQuestion(undefined)
    setPendingAnswerMode(undefined)
    if (firstClarification && continuationRunId) {
      setAgentInterruptQuestion({
        ...firstClarification,
        questions: solutionDraft?.clarificationQuestions,
        runId: continuationRunId,
        status: 'INTERRUPTED',
      })
      currentRunIdRef.current = continuationRunId
      setCurrentRunId(continuationRunId)
    } else {
      setAgentInterruptQuestion(undefined)
      currentRunIdRef.current = undefined
      setCurrentRunId(undefined)
    }
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    resetStreamedAnswer()
    lastEventIdRef.current = undefined
    setDraft('')
    setAttachments([])
    setAttachmentError(undefined)
  }, [pendingAnswerMode])

  const restoreActiveRun = useCallback(async (conversationId: string, version: number) => {
    if (restoredConversationIdsRef.current.has(conversationId) || sending) return
    restoredConversationIdsRef.current.add(conversationId)
    let active: ActiveRunResponse
    try {
      active = await api<ActiveRunResponse>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/active-run`)
    } catch {
      // The historical draft fallback is intentionally independent from the
      // active-run endpoint.  A transient Yuxi/product outage must not erase
      // a still-actionable clarification card (and a refresh would otherwise
      // be required just to get the question back).  Leave the current
      // fallback/trace untouched; a later conversation reload can retry the
      // active-run lookup and replace it with the authoritative run state.
      return
    }
    if (contextVersionRef.current !== version) return
    const run = active.run
    if (!run) {
      // Keep a validated historical fallback interrupt when the run endpoint
      // has no active record.  `historicalSolutionInterrupt()` only creates
      // this fallback when the blocked draft has no later user reply, so it
      // remains resumable for older completed runs while answered questions
      // are not resurrected.
      setPendingQuestion(undefined)
      setAnswerProgress(undefined)
      setAnswerProgressTrail([])
      answerProgressTrailRef.current = []
      resetStreamedAnswer()
      return
    }
    const terminal = String(run.status ?? '').toLowerCase()
    if (['completed', 'succeeded', 'success', 'failed', 'cancelled'].includes(terminal)) {
      return
    }
    const trail = traceToProgressTrail(run.executionTrace, run.runId)
    answerProgressTrailRef.current = trail
    setAnswerProgressTrail(trail)
    setAnswerProgress(trail.at(-1))
    setBusinessTask(run.skillId === 'MEETING_ANALYSIS' ? 'MEETING_ANALYSIS' : 'SOLUTION_DRAFT')
    setBusinessTaskExplicit(false)
    setPendingQuestion(run.inputContent?.trim() || '正在恢复后台任务…')
    setAgentInterruptQuestion(normalizeInterrupt(run.interrupt, run.runId))
    resetStreamedAnswer()
    currentRunIdRef.current = run.runId
    setCurrentRunId(run.runId)
    setSending(true)
    const abortController = new AbortController()
    sendAbortControllerRef.current = abortController
    try {
      const baseUrl = run.streamUrl || `/api/chat/runs/${encodeURIComponent(run.runId)}/events`
      const streamUrl = baseUrl.includes('?') ? `${baseUrl}&afterSeq=0` : `${baseUrl}?afterSeq=0`
      const result = await streamApi<SendResponse, ProductAnswerProgress>(
        streamUrl,
        streamRequestInit(abortController.signal),
        {
          onProgress: (progress) => {
            if (contextVersionRef.current === version) recordProgress({ ...progress, runId: progress.runId ?? run.runId })
          },
          onEventId: (eventId) => { if (contextVersionRef.current === version) lastEventIdRef.current = eventId },
          onRunStarted: (value) => {
            if (contextVersionRef.current !== version) return
            const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}
            const nextRunId = typeof payload.runId === 'string' ? payload.runId : run.runId
            currentRunIdRef.current = nextRunId
            setCurrentRunId(nextRunId)
          },
          onDelta: async (delta) => {
            if (contextVersionRef.current !== version) return
            appendStreamedDelta(delta)
          },
          onDraft: () => {
            if (contextVersionRef.current === version) recordProgress({ stage: 'COMPOSING', message: '方案草稿已生成，正在整理结果', runId: run.runId })
          },
          onInterrupt: (value) => {
            if (contextVersionRef.current !== version) return
            const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}
            setAgentInterruptQuestion(normalizeInterrupt(payload, run.runId))
            recordProgress({ stage: 'WAITING_FOR_INPUT', message: '等待补充方案所需信息', runId: run.runId, status: 'INTERRUPTED' })
          },
        },
      )
      flushStreamedAnswer()
      if (contextVersionRef.current === version && result) applyAnswer(result)
    } catch (error) {
      if (contextVersionRef.current === version && !isAbortError(error)) {
        const message = error instanceof ApiError ? error.message : '方案运行恢复失败，请重试'
        markProgressFailed(message)
        setErrorText(message)
      }
    } finally {
      if (sendAbortControllerRef.current === abortController) sendAbortControllerRef.current = undefined
      if (contextVersionRef.current === version) setSending(false)
    }
  }, [applyAnswer, markProgressFailed, recordProgress, sending])

  useEffect(() => {
    const conversationId = conversation?.id
    if (!conversationId || loadingWorkspace || loadingConversation) return
    void restoreActiveRun(conversationId, contextVersionRef.current)
  }, [conversation?.id, loadingConversation, loadingWorkspace, restoreActiveRun])

  useEffect(() => {
    setMeetingTargetId(undefined)
    setHistoryMeetingIds([])
  }, [conversation?.id])

  useEffect(() => {
    if (!meetingNavigationTarget || loadingConversation || loadingWorkspace) return
    if (conversation?.id !== meetingNavigationTarget.conversationId) return
    const target = Array.from(messageScrollRef.current?.querySelectorAll<HTMLElement>('[data-meeting-id]') ?? [])
      .find(element => element.dataset.meetingId === meetingNavigationTarget.id)
    if (!target) return
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setMeetingNavigationTarget(undefined)
  }, [meetingNavigationTarget, conversation?.id, loadingConversation, loadingWorkspace, messages, pendingQuestion])

  async function handleMeetingAction(action: 'revise' | 'retry', id: string) {
    if (mutationLocked || archived) return
    if (action === 'revise') {
      setMeetingTargetId(id)
      setBusinessTask('MEETING_ANALYSIS')
      setBusinessTaskExplicit(true)
      setDraft(MEETING_REVISION_PROMPT)
      return
    }
    try {
      const response = await api<{ runId: string; conversationId: string }>(`/api/chat/meetings/${id}/retry`, { method: 'POST' })
      restoredConversationIdsRef.current.delete(response.conversationId)
      await restoreActiveRun(response.conversationId, contextVersionRef.current)
    } catch (error) { setErrorText(error instanceof Error ? error.message : '重试失败') }
  }

  function exitMeetingRevision() {
    setMeetingTargetId(undefined)
    setBusinessTask('QA')
    setBusinessTaskExplicit(false)
    setDraft(current => current.startsWith(MEETING_REVISION_PROMPT)
      ? current.slice(MEETING_REVISION_PROMPT.length).trimStart()
      : current)
  }

  function closeConversationList() {
    setConversationListOpen(false)
    if (conversationListOpen) conversationTriggerRef.current?.focus()
  }

  function closeArchivedDrawer() {
    restoreArchiveTriggerFocusRef.current = true
    setSidebarPanel(null)
  }

  function handleConversationDrawerKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (showArchived && event.key === 'Escape') {
      event.preventDefault()
      closeArchivedDrawer()
      return
    }
    if (!conversationListOpen) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeConversationList()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(conversationSidebarRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
    ) ?? [])
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function startConversation() {
    if (switchLocked) return
    contextVersionRef.current += 1
    sendAbortControllerRef.current?.abort()
    sendAbortControllerRef.current = undefined
    setSending(false)
    citationVersionRef.current += 1
    setConversation(undefined)
    setMessages([])
    setAnswerMode('CONCISE')
    setPendingAnswerMode(undefined)
    setPendingQuestion(undefined)
    setAgentInterruptQuestion(undefined)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    resetStreamedAnswer()
    lastEventIdRef.current = undefined
    currentRunIdRef.current = undefined
    setCurrentRunId(undefined)
    setActivePairId(undefined)
    setHighlightedPairId(undefined)
    setSidebarPanel(null)
    setConversationSearch('')
    setBusinessTask('QA')
    setBusinessTaskExplicit(false)
    setDraft('')
    setAttachments([])
    setAttachmentError(undefined)
    setErrorText(undefined)
    setLoadingWorkspace(false)
    setLoadingConversation(false)
    setSelectedCitation(undefined)
    setFeedbackPendingIds(new Set())
    closeConversationList()
  }

  async function selectConversation(item: ProductConversation) {
    if (switchLocked) return false
    // Opening the current conversation is navigation, not a stream restart.
    if (item.id === conversation?.id && !loadingConversation) {
      closeConversationList()
      return true
    }
    restoredConversationIdsRef.current.delete(item.id)
    const version = ++contextVersionRef.current
    sendAbortControllerRef.current?.abort()
    sendAbortControllerRef.current = undefined
    setSending(false)
    citationVersionRef.current += 1
    setDraft('')
    setAnswerMode('CONCISE')
    setPendingAnswerMode(undefined)
    setErrorText(undefined)
    setPendingQuestion(undefined)
    setAgentInterruptQuestion(undefined)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    resetStreamedAnswer()
    lastEventIdRef.current = undefined
    currentRunIdRef.current = undefined
    setCurrentRunId(undefined)
    setActivePairId(undefined)
    setHighlightedPairId(undefined)
    setSidebarPanel(item.status === 'ARCHIVED' ? 'archived' : null)
    setBusinessTask('QA')
    setBusinessTaskExplicit(false)
    setSelectedCitation(undefined)
    setAttachments([])
    setAttachmentError(undefined)
    setFeedbackPendingIds(new Set())
    setLoadingWorkspace(false)
    setLoadingConversation(true)
    closeConversationList()
    try {
      const detail = await api<ConversationDetail>(`/api/chat/conversations/${item.id}`)
      if (contextVersionRef.current !== version) return false
      const historicalMessages = normalizeHistoricalMessages(detail.messages)
      setConversation(normalizeConversation(detail.conversation))
      setMessages(historicalMessages)
      setBusinessTask(businessTaskFromMessages(historicalMessages))
      setBusinessTaskExplicit(false)
      const historicalInterrupt = historicalSolutionInterrupt(historicalMessages)
      setAgentInterruptQuestion(historicalInterrupt)
      currentRunIdRef.current = historicalInterrupt?.runId
      setCurrentRunId(historicalInterrupt?.runId)
      return true
    } catch (error) {
      if (contextVersionRef.current !== version) return false
      if (await recoverExpiredSession(error)) return
      setErrorText('会话加载失败，请重试')
      return false
    } finally {
      if (contextVersionRef.current === version) setLoadingConversation(false)
    }
  }

  async function send() {
    const content = draft.trim()
    if (!content || mutationLocked || archived) return
    const lastMeeting = messages.filter(m => m.meeting?.result).at(-1)?.meeting
    const inferred = inferBusinessTask(content)
    const meetingFollowup = !attachments.length && !/https?:\/\//u.test(content)
      && Boolean(meetingTargetId || (lastMeeting && /修改|改成|补充|调整|重写/u.test(content)))
    const resolvedBusinessTask = businessTaskExplicit ? businessTask : meetingFollowup ? 'MEETING_ANALYSIS' : inferred
    const requestedSkillId = resolvedBusinessTask === 'QA' ? undefined : resolvedBusinessTask
    setBusinessTask(resolvedBusinessTask)
    setBusinessTaskExplicit(false)
    const mode = answerMode
    const version = contextVersionRef.current
    const abortController = new AbortController()
    sendAbortControllerRef.current = abortController
    let attachmentUploadFailed = false
    setSending(true)
    setDraft('')
    setPendingQuestion(content)
    setPendingAnswerMode(resolvedBusinessTask === 'QA' ? mode : undefined)
    setAgentInterruptQuestion(undefined)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    resetStreamedAnswer()
    lastEventIdRef.current = undefined
    currentRunIdRef.current = undefined
    setCurrentRunId(undefined)
    setAttachmentError(undefined)
    followLatestRef.current = true
    setErrorText(undefined)
    try {
      let target = conversation
      if (!target) {
        const created = await api<{ conversation: ProductConversation }>('/api/chat/conversations', {
          method: 'POST',
          body: JSON.stringify({}),
          signal: abortController.signal,
        })
        if (contextVersionRef.current !== version) return
        target = normalizeConversation(created.conversation)
        setConversation(target)
        setConversations((current) => upsertConversation(current, target!))
      }
      const attachmentIds: string[] = []
      if (attachments.length) {
        setAttachments((current) => current.map((attachment) => ({ ...attachment, status: 'UPLOADING', error: undefined })))
        try {
          for (const attachment of attachments) {
            const formData = new FormData()
            formData.append('file', attachment.file, attachment.file.name)
            const uploaded = await api<{ attachment: ProductAttachment }>(
              `/api/chat/conversations/${target.id}/attachments`,
              { method: 'POST', body: formData, signal: abortController.signal },
            )
            attachmentIds.push(uploaded.attachment.id)
          }
        } catch (error) {
          attachmentUploadFailed = true
          const message = attachmentUploadMessage(error)
          setAttachments((current) => current.map((attachment) => ({
            ...attachment,
            status: 'FAILED',
            error: message,
          })))
          setAttachmentError(message)
          throw error
        }
      }

      const messageBody = JSON.stringify({
        content,
        mode,
        requestId: globalThis.crypto?.randomUUID?.() ?? `request-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ...(requestedSkillId ? { skillId: requestedSkillId } : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(requestedSkillId === 'MEETING_ANALYSIS' ? {
          ...(meetingFollowup ? { meetingId: meetingTargetId || lastMeeting?.id } : {}),
          historyMeetingIds,
        } : {}),
      })
      const result = await streamApi<SendResponse, ProductAnswerProgress>(
        `/api/chat/conversations/${target.id}/messages/stream`,
        {
          method: 'POST',
          body: messageBody,
          signal: abortController.signal,
        },
        {
          onProgress: (progress) => {
            if (contextVersionRef.current !== version) return
            recordProgress(progress)
          },
          onDelta: async (delta) => {
            if (contextVersionRef.current !== version) return
            appendStreamedDelta(delta)
          },
          onRunStarted: (run) => {
            if (contextVersionRef.current !== version || !run || typeof run !== 'object') return
            const payload = run as Record<string, unknown>
            const runId = typeof payload.runId === 'string'
              ? payload.runId
              : typeof payload.run_id === 'string'
                ? payload.run_id
                : undefined
            if (!runId) return
            currentRunIdRef.current = runId
            setCurrentRunId(runId)
          },
          onEventId: (eventId) => { if (contextVersionRef.current === version) lastEventIdRef.current = eventId },
          onDraft: (value) => {
            if (contextVersionRef.current !== version) return
            if (value && typeof value === 'object') {
              recordProgress({ stage: 'COMPOSING', message: '方案草稿已生成，正在整理结果' })
            }
          },
          onInterrupt: (value) => {
            if (contextVersionRef.current !== version) return
            const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}
            const interruptedRunId = typeof payload.runId === 'string' ? payload.runId : currentRunIdRef.current
            setAgentInterruptQuestion(normalizeInterrupt(payload, interruptedRunId))
            if (interruptedRunId) {
              currentRunIdRef.current = interruptedRunId
              setCurrentRunId(interruptedRunId)
            }
            recordProgress({
              stage: 'WAITING_FOR_INPUT',
              message: '等待补充方案所需信息',
              runId: interruptedRunId,
              status: 'INTERRUPTED',
            })
          },
        },
      )
      flushStreamedAnswer()
      if (contextVersionRef.current !== version) return
      if (!result) return
      applyAnswer(result)
      setAnswerMode('CONCISE')
      setMeetingTargetId(undefined)
      setHistoryMeetingIds([])
    } catch (error) {
      if (contextVersionRef.current !== version) return
      setAgentInterruptQuestion(undefined)
      const preserveSolutionProgress = ['SOLUTION_DRAFT', 'MEETING_ANALYSIS'].includes(requestedSkillId || '')
        && !attachmentUploadFailed && !isAbortError(error)
      if (preserveSolutionProgress) {
        markProgressFailed(error instanceof ApiError ? error.message : '发送失败，请重试')
      } else {
        setPendingQuestion(undefined)
        resetStreamedAnswer()
        currentRunIdRef.current = undefined
        setCurrentRunId(undefined)
      }
      // Upload errors already have a specific inline message next to the
      // attachment. Avoid replacing it with a generic send failure banner.
      if (!isAbortError(error)) {
        setDraft(content)
        if (!attachmentUploadFailed) {
          const specificAnswerFailure = error instanceof ApiError
            && ['ANSWER_GENERATION_FAILED', 'ANSWER_CITATION_INVALID'].includes(error.code)
          setErrorText((preserveSolutionProgress || specificAnswerFailure) && error instanceof ApiError ? error.message : '发送失败，请重试')
        }
      }
    } finally {
      if (sendAbortControllerRef.current === abortController) {
        sendAbortControllerRef.current = undefined
      }
      if (contextVersionRef.current === version) setSending(false)
    }
  }

  async function resumeAgentRun(answerOverride?: ClarificationAnswer, action: 'answer' | 'skip' = 'answer') {
    const answer = answerOverride ?? draft.trim()
    // A historical draft may be rendered before the active-run lookup has
    // completed (or the lookup may be unavailable).  Recover the same
    // interrupt from the loaded transcript instead of relying solely on the
    // in-memory state set by the live SSE stream.
    const questionForDisplay = agentInterruptQuestion ?? historicalSolutionInterrupt(messages)
    const parentRunId = currentRunIdRef.current ?? questionForDisplay?.runId
    const hasAnswer = answer && typeof answer === 'object' && !Array.isArray(answer)
      ? Object.keys(answer).length > 0
      : Array.isArray(answer) ? answer.length > 0 : Boolean(answer.trim())
    if (action === 'answer' && !hasAnswer) return
    if (mutationLocked || archived) return
    if (!parentRunId || !questionForDisplay) {
      // Do not fail silently when a stale historical card has no resumable
      // run.  The user needs an actionable explanation rather than a button
      // that appears to do nothing.
      setErrorText('待确认问题已失效，请重新生成方案后再继续')
      return
    }
    // Keep the question/options before clearing the interrupt state.  The
    // runtime receives ids, while the user-facing message must use labels.
    const answeredIds = clarificationAnswerIds(answer, questionForDisplay)
    const displayAnswer = action === 'skip'
      ? '暂时跳过，继续生成方案'
      : displayClarificationAnswer(answer, questionForDisplay)
    const version = contextVersionRef.current
    const abortController = new AbortController()
    sendAbortControllerRef.current = abortController
    setSending(true)
    setDraft('')
    setPendingQuestion(displayAnswer)
    followLatestRef.current = true
    resetStreamedAnswer()
    // A resumed run has a new run id; do not send the parent cursor to it.
    lastEventIdRef.current = undefined
    setAgentInterruptQuestion(undefined)
    setErrorText(undefined)
    // Give immediate feedback while the resume request is being created. In
    // particular, the network round trip can take a moment before the first
    // SSE progress event arrives.
    recordProgress({
      stage: 'REQUIREMENTS_ANALYSIS',
      message: '正在吸收补充信息，重新分析需求',
      runId: parentRunId,
      status: 'ACTIVE',
    })
    showToast('已提交，正在继续生成方案…')
    try {
      const resumed = await api<{ run: { runId: string; streamUrl?: string } }>(`/api/chat/runs/${encodeURIComponent(parentRunId)}/resume`, {
        method: 'POST',
        body: JSON.stringify({
          answer,
          action,
          ...(typeof answer === 'object' && !Array.isArray(answer)
            ? {}
            : questionForDisplay.questionId ? { questionId: questionForDisplay.questionId } : {}),
          requestId: globalThis.crypto?.randomUUID?.() ?? `resume-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        }),
        signal: abortController.signal,
      })
      if (contextVersionRef.current !== version) return
      currentRunIdRef.current = resumed.run.runId
      setCurrentRunId(resumed.run.runId)
      const result = await streamApi<SendResponse, ProductAnswerProgress>(
        resumed.run.streamUrl || `/api/chat/runs/${encodeURIComponent(resumed.run.runId)}/events`,
        streamRequestInit(abortController.signal),
        {
          onProgress: (progress) => {
            if (contextVersionRef.current !== version) return
            recordProgress(progress)
          },
          onRunStarted: (run) => {
            const payload = run && typeof run === 'object' ? run as Record<string, unknown> : {}
            const nextRunId = typeof payload.runId === 'string' ? payload.runId : undefined
            if (nextRunId) {
              currentRunIdRef.current = nextRunId
              setCurrentRunId(nextRunId)
            }
          },
          onEventId: (eventId) => { if (contextVersionRef.current === version) lastEventIdRef.current = eventId },
          onDelta: async (delta) => {
            if (contextVersionRef.current !== version) return
            appendStreamedDelta(delta)
          },
          onDraft: () => recordProgress({ stage: 'COMPOSING', message: '方案草稿已生成，正在整理结果' }),
          onInterrupt: (value) => {
            if (contextVersionRef.current !== version) return
            const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}
            setAgentInterruptQuestion(normalizeInterrupt(payload, currentRunIdRef.current) ?? {
              question: typeof payload.question === 'string' ? payload.question : '请补充方案所需信息',
              status: 'INTERRUPTED',
              runId: currentRunIdRef.current,
            })
            recordProgress({
              stage: 'WAITING_FOR_INPUT',
              message: '等待补充方案所需信息',
              runId: currentRunIdRef.current,
              status: 'INTERRUPTED',
            })
          },
        },
      )
      flushStreamedAnswer()
      if (contextVersionRef.current !== version || !result) return
      // Some Agent adapters persist the raw answer id in userMessage.content
      // (for example, "confirmed").  Replace it at the product boundary so
      // both the just-completed run and the historical transcript stay human
      // readable without changing the id sent to the runtime.
      applyAnswer(result, displayAnswer, answeredIds, parentRunId)
    } catch (error) {
      if (contextVersionRef.current !== version) return
      if (!isAbortError(error)) {
        const message = error instanceof ApiError ? error.message : '方案继续生成失败，请重试'
        markProgressFailed(message)
        // Keep the clarification card actionable after a failed resume. The
        // user should not have to reload the conversation (and lose answers)
        // just to retry the same submission.
        setAgentInterruptQuestion(questionForDisplay)
        setPendingQuestion(undefined)
        setErrorText(message)
      }
    } finally {
      if (sendAbortControllerRef.current === abortController) sendAbortControllerRef.current = undefined
      if (contextVersionRef.current === version) setSending(false)
    }
  }

  function stopSending() {
    if (!sending) return
    const runId = currentRunIdRef.current
    if (runId) {
      void api(`/api/chat/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }).catch(() => undefined)
    }
    sendAbortControllerRef.current?.abort()
    sendAbortControllerRef.current = undefined
    currentRunIdRef.current = undefined
    setCurrentRunId(undefined)
    contextVersionRef.current += 1
    setSending(false)
    setPendingQuestion(undefined)
    setAgentInterruptQuestion(undefined)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    resetStreamedAnswer()
    setAttachments((current) => current.map((attachment) => (
      attachment.status === 'UPLOADING' ? { ...attachment, status: 'PENDING' } : attachment
    )))
    setAttachmentError(undefined)
    setErrorText(undefined)
  }

  function addAttachments(files: File[]) {
    if (mutationLocked || archived) return
    const next: ComposerAttachment[] = []
    let firstError: string | undefined
    const existing = new Set(attachments.map((attachment) => `${attachment.file.name}:${attachment.file.size}:${attachment.file.lastModified}`))
    for (const file of files) {
      const error = getAttachmentError(file)
      if (error) {
        firstError ??= error
        continue
      }
      const key = `${file.name}:${file.size}:${file.lastModified}`
      if (existing.has(key)) continue
      existing.add(key)
      next.push({ id: `attachment-${file.name}-${file.size}-${file.lastModified}`, file, status: 'PENDING' })
    }
    if (attachments.length + next.length > MAX_COMPOSER_ATTACHMENTS) {
      firstError ??= `最多同时添加 ${MAX_COMPOSER_ATTACHMENTS} 个文件`
      next.splice(Math.max(0, MAX_COMPOSER_ATTACHMENTS - attachments.length))
    }
    if (next.length) setAttachments((current) => [...current, ...next])
    setAttachmentError(firstError)
  }

  function removeAttachment(id: string) {
    if (mutationLocked || archived) return
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
    setAttachmentError(undefined)
  }

  async function archiveConversation() {
    if (!conversation || archived || mutationLocked) return
    const version = contextVersionRef.current
    const target = conversation
    setArchiving(true)
    setErrorText(undefined)
    try {
      await api<unknown>(`/api/chat/conversations/${target.id}/archive`, { method: 'POST' })
      if (contextVersionRef.current !== version) return
      const archivedConversation: ProductConversation = { ...target, status: 'ARCHIVED' }
      setConversation(archivedConversation)
      setConversations((current) => current.map((item) => item.id === target.id ? archivedConversation : item))
    } catch {
      if (contextVersionRef.current !== version) return
      setErrorText('归档失败，请重试')
    } finally {
      if (contextVersionRef.current === version) setArchiving(false)
    }
  }

  async function restoreConversation() {
    if (!conversation || !archived || mutationLocked) return
    const version = contextVersionRef.current
    const target = conversation
    setRestoring(true)
    setErrorText(undefined)
    try {
      await api<unknown>(`/api/chat/conversations/${target.id}/restore`, { method: 'POST' })
      if (contextVersionRef.current !== version) return
      const restoredConversation: ProductConversation = { ...target, status: 'ACTIVE' }
      setConversation(restoredConversation)
      setConversations((current) => upsertConversation(current, restoredConversation))
      setSidebarPanel(null)
    } catch {
      if (contextVersionRef.current !== version) return
      setErrorText('恢复会话失败，请重试')
    } finally {
      if (contextVersionRef.current === version) setRestoring(false)
    }
  }

  async function updateFeedback(
    messageId: string,
    rating: FeedbackRating | null,
    reasonType?: FeedbackReasonType,
    reasonText?: string,
  ) {
    if (feedbackPendingIds.has(messageId)) return
    const target = messages.find((message) => message.id === messageId && message.role === 'ASSISTANT')
    if (!target || archived) return
    const version = contextVersionRef.current
    const previousRating = target.feedbackRating ?? null
    setFeedbackPendingIds((current) => new Set(current).add(messageId))
    setErrorText(undefined)
    setMessages((current) => current.map((message) => (
      message.id === messageId
        ? {
            ...message,
            feedbackRating: rating,
            feedbackReasonType: rating === 'DISLIKE' ? reasonType : null,
            feedbackReasonText: rating === 'DISLIKE' ? reasonText : null,
          }
        : message
    )))
    try {
      const response = await api<FeedbackResponse>(`/api/chat/messages/${messageId}/feedback`, {
        method: 'PUT',
        body: JSON.stringify({ rating, reasonType, reasonText }),
      })
      if (contextVersionRef.current !== version) return
      setMessages((current) => current.map((message) => (
        message.id === response.messageId
          ? {
              ...message,
              feedbackRating: response.feedbackRating,
              feedbackReasonType: response.feedbackReasonType,
              feedbackReasonText: response.feedbackReasonText,
            }
          : message
      )))
    } catch {
      if (contextVersionRef.current !== version) return
      setMessages((current) => current.map((message) => (
        message.id === messageId ? { ...message, feedbackRating: previousRating } : message
      )))
      setErrorText('反馈提交失败，请重试')
    } finally {
      if (contextVersionRef.current === version) {
        setFeedbackPendingIds((current) => {
          const next = new Set(current)
          next.delete(messageId)
          return next
        })
      }
    }
  }

  async function updateSolutionDraft(draftId: string, patch: SolutionDraftEditRequest) {
    try {
      const response = await api<{ draft: NonNullable<ProductMessage['solutionDraft']> }>(
        `/api/chat/solution-drafts/${encodeURIComponent(draftId)}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      )
      setMessages((current) => current.map((message) => (
        message.solutionDraft?.id === draftId
          ? { ...message, solutionDraft: response.draft, content: response.draft.executiveSummary }
          : message
      )))
      showToast('方案草稿已保存为新版本')
    } catch {
      setErrorText('方案草稿保存失败，请重试')
      throw new Error('SOLUTION_DRAFT_SAVE_FAILED')
    }
  }

  async function confirmSolutionDraft(draftId: string) {
    try {
      const response = await api<{ draft: NonNullable<ProductMessage['solutionDraft']>; confirmed: boolean }>(
        `/api/chat/solution-drafts/${encodeURIComponent(draftId)}/confirm`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      setMessages((current) => current.map((message) => (
        message.solutionDraft?.id === draftId
          ? { ...message, solutionDraft: response.draft, content: response.draft.executiveSummary }
          : message
      )))
      showToast('已确认并生成正式方案')
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : '方案确认失败，请重试')
      throw new Error('SOLUTION_DRAFT_CONFIRM_FAILED')
    }
  }

  async function openCitation(citation: ProductCitation, trigger: HTMLButtonElement) {
    const version = ++citationVersionRef.current
    citationTriggerRef.current = trigger
    setErrorText(undefined)
    try {
      const detail = await api<ProductCitation>(`/api/citations/${citation.id}`)
      if (citationVersionRef.current !== version) return
      setSelectedCitation(detail)
    } catch {
      if (citationVersionRef.current !== version) return
      setErrorText('来源加载失败，请重试')
    }
  }

  function closeCitation() {
    citationVersionRef.current += 1
    setSelectedCitation(undefined)
  }

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    setToastText(message)
    toastTimerRef.current = window.setTimeout(() => {
      setToastText(undefined)
      toastTimerRef.current = undefined
    }, 3200)
  }, [])

  async function fetchMaterialBlob(material: ProductMaterial, downloadPath?: string) {
    const response = await fetch(downloadPath ?? `/api/chat/materials/${encodeURIComponent(material.id)}/download`, {
      credentials: 'include',
    })
    if (!response.ok) throw new Error('MATERIAL_DOWNLOAD_FAILED')
    return response.blob()
  }

  async function downloadMaterial(material: ProductMaterial) {
    setErrorText(undefined)
    try {
      const blob = await fetchMaterialBlob(material)
      if (!triggerBlobDownload(blob, material.fileName)) throw new Error('BROWSER_DOWNLOAD_UNAVAILABLE')
      showToast(`已下载「${material.fileName}」`)
    } catch {
      setErrorText('资料下载失败，请重试')
    }
  }

  function openMaterialPreview(material: ProductMaterial, trigger: HTMLButtonElement) {
    void openCitation(material.citation, trigger)
  }

  function openMaterialDistribution(material: ProductMaterial) {
    setDistributionMaterial(material)
    setDistributionFeedback(undefined)
    setErrorText(undefined)
  }

  function closeMaterialDistribution() {
    if (distributionBusy) return
    setDistributionMaterial(undefined)
    setDistributionFeedback(undefined)
  }

  async function distributeMaterial(channel: MaterialShareChannel) {
    const material = distributionMaterial
    if (!material || distributionBusy) return
    // Launch the desktop protocol while the click still has user activation.
    // The network request and file preparation below are asynchronous and may
    // otherwise cause browsers to reject a later custom-protocol navigation.
    const earlyWechatOpen: ShareApplicationOpenResult | undefined = channel === 'WECHAT' && !canShareMaterialFiles(undefined, material.mimeType)
      ? openShareApplication('WECHAT')
      : undefined
    setDistributionBusy(true)
    setDistributionFeedback(undefined)
    setErrorText(undefined)
    try {
      const response = await api<MaterialDistributionResponse>(
        `/api/chat/materials/${encodeURIComponent(material.id)}/distributions`,
        {
          method: 'POST',
          body: JSON.stringify({ channel }),
        },
      )
      const blob = await fetchMaterialBlob(material, response.downloadUrl)
      const file = new File([blob], material.fileName, { type: blob.type || material.mimeType })
      const result = await shareMaterialViaDevice({
        title: material.title,
        fileName: material.fileName,
        size: formatMaterialSize(material.sizeBytes),
        summary: response.text,
        sourcePath: material.citation.path,
        shareText: response.text,
      }, channel, undefined, file)
      if (result === 'SHARED') {
        setDistributionFeedback(`已打开${channel === 'FEISHU' ? '飞书' : '微信'}系统分享面板，请选择联系人发送`)
        showToast('已打开手机分享面板')
      } else if (result === 'CANCELLED') {
        setDistributionFeedback('已取消分享，资料未发送')
      } else {
        if (!triggerBlobDownload(blob, material.fileName)) throw new Error('BROWSER_DOWNLOAD_UNAVAILABLE')
        if (channel === 'WECHAT') {
          const openResult = earlyWechatOpen === 'OPENED' ? earlyWechatOpen : openShareApplication('WECHAT')
          if (openResult === 'OPENED') {
            setDistributionFeedback('资料已下载，并已尝试打开微信。请在微信中选择联系人并发送刚下载的文件。')
            showToast(`已下载「${material.fileName}」，正在打开微信`)
          } else {
            setDistributionFeedback('资料已下载，但浏览器无法自动打开微信，请手动打开微信发送。')
            showToast(`已下载「${material.fileName}」`)
          }
        } else {
          setDistributionFeedback('设备不支持直接分享，已下载资料，请使用系统分享')
          showToast(`已下载「${material.fileName}」，可用系统分享`)
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CHANNEL_NOT_AVAILABLE') {
        setDistributionFeedback('钉钉暂未接入，请选择微信或飞书')
      } else {
        setErrorText('分发准备失败，请重试')
      }
    } finally {
      setDistributionBusy(false)
    }
  }

  function activatePair(pairId: string) {
    const target = document.getElementById(messagePairAnchorId(pairId))
    if (!target) return
    setActivePairId(pairId)
    setHighlightedPairId(pairId)
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function prepareDeepResearch(question: string) {
    if (mutationLocked || archived || draft.trim() || attachments.length || meetingTargetId || agentInterruptQuestion) return
    setDraft(question)
    setAnswerMode('DETAILED')
    setBusinessTask('QA')
    setBusinessTaskExplicit(true)
    showToast('已带入原问题，点击发送开始深度查证')
    document.querySelector<HTMLTextAreaElement>('.chat-composer textarea')?.focus()
  }

  function selectExampleQuestion(question: string) {
    setBusinessTask('QA')
    setBusinessTaskExplicit(false)
    setAnswerMode('CONCISE')
    setDraft(question)
  }

  function selectBusinessTask(task: Exclude<BusinessTask, 'QA'>, mentionValue?: string) {
    const definition = businessTasks.find((item) => item.id === task)
    if (!definition) return
    setBusinessTask(task)
    setBusinessTaskExplicit(true)
    setAnswerMode('DETAILED')
    setDraft((current) => {
      const value = mentionValue ?? `@${definition.label}`
      return replaceSelectedSkill(current, value, composerMentions)
    })
  }

  function selectMention(mention: ComposerMention) {
    const task = businessTasks.find((item) => item.label === mention.label)
    if (task) selectBusinessTask(task.id, mention.value)
  }

  function changeDraft(nextDraft: string) {
    setDraft(nextDraft)
    if (!businessTaskExplicit || businessTask === 'QA') return
    const task = businessTasks.find((item) => item.id === businessTask)
    const mention = composerMentions.find((item) => item.label === task?.label)
    if (mention && !nextDraft.includes(mention.value)) {
      setBusinessTask('QA')
      setBusinessTaskExplicit(false)
    }
  }

  const sourceBackgroundInert = Boolean(selectedCitation && sourceDrawerModal)
  const sourceBackgroundProps = sourceBackgroundInert ? { inert: '' } : {}
  const revisionMeetingTitle = messages.find(message => message.meeting?.id === meetingTargetId)?.meeting?.result?.title || '所选会议'
  const showEmptyState = !loadingWorkspace && !loadingConversation && !messages.length && !pendingQuestion

  return (
    <ProductShell headerInert={sourceBackgroundInert}>
      <section className="chat-page" aria-label="企业知识助手工作区">
        <div className={`chat-layout${selectedCitation ? ' source-open' : ''}`}>
          <aside
            ref={conversationSidebarRef}
            {...sourceBackgroundProps}
            id="conversation-sidebar"
            className={`conversation-sidebar${conversationListOpen ? ' mobile-open' : ''}`}
            aria-label="对话列表"
            onKeyDown={handleConversationDrawerKeyDown}
          >
            <div className="sidebar-heading">
              <h2>对话</h2>
              <button
                ref={conversationCloseRef}
                type="button"
                className="icon-button conversation-sidebar-close"
                aria-label="关闭对话列表"
                title="关闭对话列表"
                onClick={closeConversationList}
              >
                <X aria-hidden="true" size={17} />
              </button>
            </div>
            <div className="conversation-sidebar-actions">
              <button type="button" className="new-conversation-button" disabled={switchLocked} onClick={startConversation}>
                <Plus aria-hidden="true" size={17} />
                新对话
              </button>
              <div className="conversation-search">
                <Search aria-hidden="true" size={15} />
                <input
                  type="search"
                  value={conversationSearch}
                  aria-label="搜索历史会话"
                  placeholder="搜索会话"
                  onChange={(event) => setConversationSearch(event.target.value)}
                />
                {conversationSearch ? (
                  <button
                    type="button"
                    className="conversation-search-clear"
                    aria-label="清除会话搜索"
                    title="清除搜索"
                    onClick={() => setConversationSearch('')}
                  >
                    <X aria-hidden="true" size={14} />
                  </button>
                ) : null}
              </div>
            </div>
            <div className="conversation-list-area">
              <ul className="conversation-list">
                {filteredConversations.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`conversation-link${conversation?.id === item.id ? ' active' : ''}`}
                      aria-current={conversation?.id === item.id ? 'page' : undefined}
                      disabled={switchLocked}
                      onClick={() => void selectConversation(item)}
                    >
                      <span className="conversation-link-title" title={item.title || FALLBACK_CONVERSATION_TITLE}>{item.title || FALLBACK_CONVERSATION_TITLE}</span>
                      {(meetingActivityTasks.some(task => task.conversationId === item.id && ['pending', 'running'].includes(task.state))
                        || (sending && conversation?.id === item.id)) ? (
                        <span className="conversation-running" role="status" aria-label="正在运行" title="任务正在运行">
                          <span className="conversation-running-indicator" aria-hidden="true" />
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
                {!filteredConversations.length ? (
                  <li className="conversation-list-empty">
                    {conversationSearch.trim() ? '未找到匹配的会话' : '暂无进行中会话'}
                  </li>
                ) : null}
              </ul>
              <section
                id="archived-conversation-drawer"
                className={`archived-conversation-drawer${showArchived ? ' is-open' : ''}`}
                aria-label="已归档会话抽屉"
                aria-hidden={!showArchived}
              >
                <div className="archived-conversation-drawer-heading">
                  <div className="archived-conversation-drawer-title">
                    <Archive aria-hidden="true" size={15} />
                    <div>
                      <strong>已归档会话</strong>
                      <span>{archivedConversations.length} 个会话 · 仅供查看，可恢复</span>
                    </div>
                  </div>
                  <button
                    ref={archivedConversationCloseRef}
                    type="button"
                    className="archived-conversation-drawer-close"
                    aria-label="收起已归档会话"
                    title="收起已归档会话"
                    disabled={!showArchived}
                    onClick={closeArchivedDrawer}
                  >
                    <ChevronDown aria-hidden="true" size={16} />
                  </button>
                </div>
                <div className="archived-conversation-drawer-body">
                  <ul className="conversation-list archived-conversation-list">
                    {filteredArchivedConversations.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className={`conversation-link${conversation?.id === item.id ? ' active' : ''}`}
                          aria-current={conversation?.id === item.id ? 'page' : undefined}
                          disabled={!showArchived || switchLocked}
                          onClick={() => void selectConversation(item)}
                        >
                          <span className="conversation-link-title" title={item.title || FALLBACK_CONVERSATION_TITLE}>{item.title || FALLBACK_CONVERSATION_TITLE}</span>
                          <span className="conversation-archived-badge" aria-hidden="true">已归档</span>
                        </button>
                      </li>
                    ))}
                    {!filteredArchivedConversations.length ? (
                      <li className="conversation-list-empty">
                        {conversationSearch.trim() ? '未找到匹配的已归档会话' : '暂无已归档会话'}
                      </li>
                    ) : null}
                  </ul>
                </div>
              </section>
            </div>
            <div className="conversation-sidebar-footer">
              <button
                type="button"
                ref={archivedConversationTriggerRef}
                hidden={showArchived}
                aria-controls="archived-conversation-drawer"
                className={`archived-conversations-button${showArchived ? ' active' : ''}`}
                aria-label={showArchived ? '收起已归档会话' : '展开已归档会话'}
                title={showArchived ? '收起已归档会话' : '展开已归档会话'}
                aria-expanded={showArchived}
                aria-pressed={showArchived}
                disabled={switchLocked}
                onClick={() => setSidebarPanel(current => current === 'archived' ? null : 'archived')}
              >
                <ArchiveRestore aria-hidden="true" size={15} />
                <span>已归档</span>
                <span className="archived-conversations-count">{archivedConversations.length}</span>
                {showArchived ? <ChevronDown className="archived-conversations-chevron" aria-hidden="true" size={14} /> : <ChevronUp className="archived-conversations-chevron" aria-hidden="true" size={14} />}
              </button>
              {sessionUser ? <MeetingActivity open={sidebarPanel === 'activity'} onOpenChange={open => setSidebarPanel(current => open ? 'activity' : current === 'activity' ? null : current)} userId={sessionUser.id} disabled={switchLocked} onTasksChange={setMeetingActivityTasks} onOpen={async task => {
                const item = conversations.find(item => item.id === task.conversationId)
                  ?? normalizeConversation((await api<ConversationDetail>(`/api/chat/conversations/${task.conversationId}`)).conversation)
                if (!await selectConversation(item)) throw new Error('会话未打开')
                setMeetingNavigationTarget(task)
              }} /> : null}
            </div>

          </aside>

          <main
            className={`chat-main${showEmptyState ? ' chat-main-empty' : ''}`}
            data-agent-run-id={currentRunId}
            {...sourceBackgroundProps}
          >
            <div className="chat-utility-actions">
              <button
                ref={conversationTriggerRef}
                type="button"
                className="icon-button conversation-drawer-trigger"
                aria-label="打开对话列表"
                title="打开对话列表"
                aria-controls="conversation-sidebar"
                aria-expanded={conversationListOpen}
                disabled={switchLocked}
                onClick={() => setConversationListOpen(true)}
              >
                <PanelLeft aria-hidden="true" size={18} />
              </button>
              {archived ? <span className="archive-label chat-archive-label">已归档</span> : null}
              {conversation ? (
                <button
                  type="button"
                  className="icon-button chat-archive-button"
                  aria-label={archived ? '恢复当前会话' : '归档当前对话'}
                  title={archived ? '恢复当前会话' : '归档当前对话'}
                  disabled={mutationLocked}
                  onClick={() => void (archived ? restoreConversation() : archiveConversation())}
                >
                  {archived ? <ArchiveRestore aria-hidden="true" size={17} /> : <Archive aria-hidden="true" size={17} />}
                </button>
              ) : null}
            </div>

            <ConversationOutline
              messages={messages}
              activePairId={activePairId}
              onActivate={activatePair}
              onHighlight={setHighlightedPairId}
            />

            <div className="chat-message-area">
              <div ref={messageScrollRef} className={`chat-message-scroll${showEmptyState ? ' chat-message-scroll-empty' : ''}`}>
                {loadingWorkspace || loadingConversation ? (
                  <div className="chat-loading" role="status"><span className="spinner" />正在加载</div>
                ) : messages.length || pendingQuestion ? (
                  <MessageThread
                    messages={messages}
                    pendingQuestion={pendingQuestion}
                    pendingAnswerMode={pendingAnswerMode}
                    onDeepResearch={prepareDeepResearch}
                    deepResearchDisabled={mutationLocked || archived || Boolean(draft.trim() || attachments.length || meetingTargetId || agentInterruptQuestion)}
                    activeMeetingRunId={backgroundMeeting ? currentRunId : undefined}
                    agentInterruptQuestion={agentInterruptQuestion}
                    answerProgress={answerProgress}
                    answerProgressTrail={answerProgressTrail}
                    streamedAnswer={streamedAnswer}
                    activeClarificationRunId={agentInterruptQuestion?.runId}
                    highlightedPairId={highlightedPairId}
                    expandedCitationId={selectedCitation?.id}
                    onCitation={(item, trigger) => void openCitation(item, trigger)}
                    feedbackPendingIds={feedbackPendingIds}
                    feedbackDisabled={archived}
                    onFeedback={(messageId, rating, reasonType, reasonText) => (
                      void updateFeedback(messageId, rating, reasonType, reasonText)
                    )}
                    onMaterialPreview={openMaterialPreview}
                    onMaterialDownload={(material) => void downloadMaterial(material)}
                    onMaterialDistribute={openMaterialDistribution}
                    onMeetingAction={(action, id) => void handleMeetingAction(action, id)}
                    onMeetingDirtyChange={meetingDirtyChanged}
                    onDraftSave={updateSolutionDraft}
                    onDraftConfirm={confirmSolutionDraft}
                    onInterruptAnswer={(answer, action) => void resumeAgentRun(answer, action)}
                    interruptDisabled={sending}
                  />
                ) : (
                  <div className="chat-empty prototype-home" aria-label="新对话引导">
                    <div className="prototype-hero">
                      <span className="prototype-eyebrow">统一对话入口 · 企业知识助手</span>
                      <h2>让每一次工作协作，<em>都从一个对话开始。</em></h2>
                    </div>
                    <div className="prototype-default-skill">
                      <span className="prototype-default-skill-icon"><MessageCircle aria-hidden="true" size={17} /></span>
                      <span><strong>默认能力 · 直接问答</strong><small>基于已审核、已发布且你有权限访问的企业资料，回答并保留引用。</small></span>
                    </div>
                    <div className="prototype-skill-strip" aria-label="可调用技能">
                      <span className="prototype-skill-strip-label">可调用技能</span>
                      {businessTasks.map((task) => {
                        const mention = composerMentions.find((item) => item.label === task.label)
                        const Icon = task.icon
                        return (
                          <button
                            key={task.id}
                            type="button"
                            className="prototype-skill-chip"
                            title={task.availability === 'PLANNED' ? `${task.description} · 第 ${task.stage} 阶段开放` : task.description}
                            aria-label={`选择${task.label}`}
                            onClick={() => selectBusinessTask(task.id, mention?.value)}
                          >
                            <Icon aria-hidden="true" size={15} />
                            <span>@{task.label}</span>
                          </button>
                        )
                      })}
                    </div>
                    <p className="prototype-skill-hint">需要查资料、做方案或整理会议纪要时，AI 会自动调用合适技能；也可以输入 @ 手动选择。</p>
                    <div className="prototype-example-prompts" aria-label="示例问题">
                      <span>可以这样问</span>
                      {exampleQuestions.map((question) => (
                        <button key={question} type="button" onClick={() => selectExampleQuestion(question)}>{question}</button>
                      ))}
                    </div>
                    <div className="prototype-home-note"><BookOpen aria-hidden="true" size={15} /><span>资料原文只存放在飞书知识库，助手不会复制到其他位置</span></div>
                  </div>
                )}
              </div>

              {showScrollToBottom ? (
                <button
                  type="button"
                  className="chat-scroll-to-bottom"
                  aria-label="滚动到最新消息"
                  title="滚动到最新消息"
                  onClick={scrollToLatest}
                >
                  <ArrowDown aria-hidden="true" size={19} strokeWidth={1.9} />
                </button>
              ) : null}
            </div>

            {errorText ? (
              <div className="chat-error" role="alert">
                <span>{errorText}</span>
                {errorText === '发送失败，请重试' ? (
                  <button type="button" onClick={() => void send()}>重试</button>
                ) : errorText === '会话加载失败，请重试' ? (
                  <button type="button" onClick={() => void loadWorkspace()}>
                    <RefreshCw aria-hidden="true" size={14} />
                    重试
                  </button>
                ) : errorText === '恢复会话失败，请重试' ? (
                  <button type="button" onClick={() => void restoreConversation()}>
                    <RefreshCw aria-hidden="true" size={14} />
                    重试
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="chat-composer-dock">
              {backgroundMeeting ? <p className="meeting-background-hint" role="status">会议正在后台处理。你可以新建或切换其他会话，完成后会在“后台任务”提醒。</p> : null}
              {businessTask === 'MEETING_ANALYSIS' || /@会议纪要|@分析会议/u.test(draft) ? <MeetingHistoryPicker
                key={conversation?.id ?? 'new'}
                selectedIds={historyMeetingIds}
                onChange={setHistoryMeetingIds}
                disabled={mutationLocked}
              /> : null}
              {meetingTargetId ? (
                <section className="meeting-revision-context" aria-label="AI 修改纪要">
                  <PencilLine size={17} aria-hidden="true" />
                  <div className="meeting-revision-copy">
                    <strong>AI 修改纪要</strong>
                    <span title={revisionMeetingTitle}>{revisionMeetingTitle}</span>
                    <small>在下方填写修改要求，发送后生效</small>
                  </div>
                  <button type="button" onClick={exitMeetingRevision} title="退出本次修改，保留已输入的要求，原纪要不变">
                    <X size={14} aria-hidden="true" />退出修改
                  </button>
                </section>
              ) : null}
              {dirtyMeetingIds.size > 0 ? (
                <p className="meeting-unsaved-hint" role="status">
                  <Info size={16} aria-hidden="true" />
                  <span>纪要修改尚未保存，保存完成后可继续发送或切换会话。</span>
                </p>
              ) : null}
              <ChatComposer
                value={draft}
                mode={answerMode}
                disabled={mutationLocked || archived}
                onChange={changeDraft}
                onModeChange={setAnswerMode}
                attachments={attachments}
                attachmentError={attachmentError}
                onFiles={addAttachments}
                onRemoveAttachment={removeAttachment}
                mentions={composerMentions}
                onMentionSelect={selectMention}
                showModeSwitch={!agentInterruptQuestion && !meetingTargetId && (businessTaskExplicit ? businessTask === 'QA' : !['MEETING_ANALYSIS', 'SOLUTION_DRAFT'].includes(inferBusinessTask(draft)))}
                sending={sending}
                onStop={stopSending}
                onSubmit={() => void (agentInterruptQuestion ? resumeAgentRun() : send())}
              />
            </div>
            {toastText ? <div className="chat-toast" role="status">{toastText}</div> : null}
          </main>

          <SourceDrawer citation={selectedCitation} modal={sourceDrawerModal} onClose={closeCitation} />
        </div>
        <MaterialDistributionDialog
          material={distributionMaterial}
          busy={distributionBusy}
          feedback={distributionFeedback}
          onSelectChannel={(channel) => void distributeMaterial(channel)}
          onClose={closeMaterialDistribution}
        />
        <button
          type="button"
          className={`conversation-backdrop${conversationListOpen ? ' is-open' : ''}`}
          aria-label="关闭对话列表"
          onClick={closeConversationList}
        />
      </section>
    </ProductShell>
  )
}
