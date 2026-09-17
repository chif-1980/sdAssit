import { ulid } from 'ulid'

import type {
  CapabilityMatch,
  CapabilityIndexEntry,
  ClarificationQuestion,
  ConfidenceSummary,
  DraftCitation,
  DraftEvidenceItem,
  DraftRequirement,
  DraftSection,
  ConflictItem,
  SolutionDraft,
  SolutionReviewState,
} from '../../shared/domain/models.js'
import type { SolutionDraftEditRequest } from '../../shared/api/product.js'
import type { Asset, PlatformSnapshot } from '../../shared/domain/models.js'

const requiredSections = ['执行摘要', '需求与范围', '方案设计', '实施计划', '风险与待确认']
const blueprintKeys = new Set([
  'title', 'customer', 'customerContext', 'customer_context', 'executiveSummary', 'executive_summary',
  'requirements', 'sections', 'citations', 'risks', 'conflicts', 'evidenceGaps', 'evidence_gaps',
])

export class SolutionDraftExtractionError extends Error {
  constructor(
    readonly code: 'AGENT_EMPTY_RESULT' | 'AGENT_MALFORMED_RESULT',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'SolutionDraftExtractionError'
  }
}

/** Build a permission-filtered capability index from governed enterprise knowledge.
 *
 * The repository is the source of truth in the local product. Only active,
 * indexed and AI-enabled knowledge participates, so an unapproved document
 * can never be presented as an enterprise capability.
 */
export function buildCapabilityIndex(snapshot: PlatformSnapshot): CapabilityIndexEntry[] {
  const grouped = new Map<string, CapabilityIndexEntry>()
  for (const knowledge of snapshot.knowledge) {
    if (knowledge.status !== 'ACTIVE' || !knowledge.aiEnabled || knowledge.indexStatus !== 'INDEXED') continue
    const id = knowledge.logicalFactKey ?? `capability:${knowledge.title.trim().toLocaleLowerCase()}`
    const existing = grouped.get(id)
    const citation = citationId(knowledge.id, knowledge.primaryAssetId, knowledge.sourceLocator)
    const deliveryStatus = knowledge.category === 'PRODUCT_CAPABILITY' || knowledge.category === 'PRODUCT_PARAMETER'
      ? 'PRODUCTIZED'
      : knowledge.category === 'PROJECT'
        ? 'DELIVERED'
        : 'UNKNOWN'
    if (existing) {
      existing.sourceKnowledgeIds.push(knowledge.id)
      existing.citationIds.push(citation)
      existing.confidence = Math.max(existing.confidence, knowledge.authority === 'L0' ? 0.55 : 0.85)
      if (knowledge.updatedAt > existing.updatedAt) existing.updatedAt = knowledge.updatedAt
      continue
    }
    grouped.set(id, {
      id,
      name: knowledge.title,
      description: knowledge.content.slice(0, 500),
      deliveryStatus,
      sourceKnowledgeIds: [knowledge.id],
      citationIds: [citation],
      confidence: knowledge.authority === 'L0' ? 0.55 : 0.85,
      updatedAt: knowledge.updatedAt,
    })
  }
  return [...grouped.values()].sort((left, right) => right.confidence - left.confidence || right.updatedAt.localeCompare(left.updatedAt))
}

/**
 * Return the one deterministic question used by the local compatibility
 * adapter, unless the request already contains a clear decision for that
 * dimension.  The local adapter is intentionally conservative: it should
 * ask only for information that is genuinely absent, never repeat a choice
 * that is already present in the user's request (for example "微信小程序"
 * or "私有化部署").
 */
export function clarificationQuestionForRequest(request: string): ClarificationQuestion | undefined {
  const normalized = request.trim()
  const hasCustomerContext = /客户|甲方|集团|公司|医院|学校|政府|轨道|行业/iu.test(normalized)
  const hasDeploymentDecision = /(?:私有化|本地(?:化)?|混合|公有云|云上|云部署|部署在|部署于).{0,12}部署|部署.{0,12}(?:私有化|本地|混合|公有云|云上)/iu.test(normalized)
  const hasCustomerDecision = /(?:面向|服务|针对|属于|客户(?:类型|主体)?(?:是|为)?)[^。！？\n]{0,20}(?:企业|政府|事业单位|行业|集团|公司|医院|学校)/iu.test(normalized)

  // A deployment question is redundant when the request already states the
  // deployment mode. Likewise, do not ask for customer type when it is
  // explicitly stated. Other missing dimensions remain in the draft's
  // openQuestions and can be handled by the full Agent.
  if (hasCustomerContext && hasDeploymentDecision) return undefined
  if (!hasCustomerContext && hasCustomerDecision) return undefined

  const options = hasCustomerContext
    ? [
      { id: 'PRIVATE_DEPLOYMENT', label: '私有化部署' },
      { id: 'HYBRID_DEPLOYMENT', label: '混合部署' },
      { id: 'PUBLIC_CLOUD', label: '公有云部署' },
    ]
    : [
      { id: 'ENTERPRISE', label: '企业客户' },
      { id: 'GOVERNMENT', label: '政府/事业单位' },
      { id: 'INDUSTRY', label: '行业客户' },
    ]
  return {
    id: hasCustomerContext ? 'DEPLOYMENT_MODE' : 'CUSTOMER_TYPE',
    question: hasCustomerContext ? '方案预计采用哪种部署方式？' : '这份方案主要面向哪类客户？',
    type: 'SINGLE_CHOICE',
    options,
    required: true,
    allowSkip: true,
    position: 1,
    total: 1,
  }
}

/**
 * Keep clarification batches deterministic across Agent projections and
 * legacy drafts.  A question can be repeated with the same id, or with a
 * slightly different whitespace-only rendering; retain the first occurrence
 * and expose a contiguous position/total pair to the product UI.
 */
export function dedupeClarificationQuestions(
  questions: ClarificationQuestion[],
): ClarificationQuestion[] {
  const seenIds = new Set<string>()
  const seenTexts = new Set<string>()
  const unique: ClarificationQuestion[] = []

  for (const question of questions) {
    const id = question.id.trim()
    const text = question.question.trim()
    const textKey = text.replace(/\s+/gu, ' ')
    if (!text || seenIds.has(id) || seenTexts.has(textKey)) continue
    seenIds.add(id)
    seenTexts.add(textKey)
    unique.push({ ...question, id, question: text })
  }

  return unique.map((question, index, all) => ({
    ...question,
    position: index + 1,
    total: all.length,
  }))
}

/**
 * Option ids are useful to LangGraph and to the resume API, but they are an
 * implementation detail from a user's point of view.  Older product runs
 * persisted the id (for example `confirmed`) in the conversation transcript
 * and in the request used to build the next draft.  Keep the conversion at
 * the product boundary so runtime payloads can continue to use stable ids
 * while historical messages remain readable.
 *
 * This helper is deliberately conservative: only an exact scalar, a
 * structured answer, or the explicit `补充信息` section is translated.  A
 * normal prose prompt containing a word such as `admin` is left untouched.
 */
const legacySolutionOptionLabels: Record<string, string> = {
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

// A few question ids are emitted by older solution runs without the question
// text.  Keep their display names local to the compatibility boundary; new
// runs should always carry the question metadata and take precedence.
const legacySolutionQuestionLabels: Record<string, string> = {
  customer_type: '客户类型',
  customer_subject: '客户主体',
  deployment_mode: '部署方式',
  operating_mode: '运营模式',
  payment: '在线支付',
  product_form: '产品形态',
  scope: '首期范围',
  sku_count: '商品数量',
}

type SolutionAnswerQuestion = Pick<ClarificationQuestion, 'id' | 'options'> & {
  question?: string
}

function answerQuestionForKey(key: string, questions: readonly SolutionAnswerQuestion[]) {
  const normalized = key.trim().toLocaleLowerCase()
  return questions.find((question) => question.id.trim().toLocaleLowerCase() === normalized)
}

function answerKeyLabel(key: string, questions: readonly SolutionAnswerQuestion[]) {
  return answerQuestionForKey(key, questions)?.question?.trim()
    || legacySolutionQuestionLabels[key.trim().toLocaleLowerCase()]
    || key.trim()
}

function answerRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Parse the explicit answer-map forms used by local and remote resume APIs. */
function answerEntriesFromText(value: string): Array<[string, unknown]> {
  const trimmed = value.trim()
  if (!trimmed) return []
  if ((trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      const parsed = answerRecord(JSON.parse(trimmed))
      if (parsed) return Object.entries(parsed)
    } catch {
      // Fall through to line parsing for malformed/legacy text.
    }
  }
  return value.split('\n').flatMap((line): Array<[string, unknown]> => {
    const match = /^\s*([^：:]{1,120})[：:]\s*(.*?)\s*$/u.exec(line)
    return match?.[1]?.trim() && match[2]?.trim() ? [[match[1].trim(), match[2].trim()]] : []
  })
}

function answerValuePresent(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.some((item) => answerValuePresent(item))
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('value' in record || 'answer' in record) return answerValuePresent(record.value ?? record.answer)
    return Object.keys(record).length > 0
  }
  return true
}

function answerMapMatchesQuestions(value: string, questions: readonly SolutionAnswerQuestion[]) {
  const entries = answerEntriesFromText(value)
  if (!entries.length || !questions.length) return false
  return entries.every(([key, item]) => {
    const question = answerQuestionForKey(key, questions)
    if (!question) return false
    const record = answerRecord(item)
    const action = record?.action
    return action === 'skip' || answerValuePresent(record?.value ?? record?.answer ?? item)
  })
}

function solutionAnswerLabels(questions: readonly SolutionAnswerQuestion[]) {
  const labels = new Map<string, string>()
  for (const question of questions) {
    for (const option of question.options ?? []) {
      const id = option.id.trim()
      const label = option.label.trim()
      if (id && label) labels.set(id.toLocaleLowerCase(), label)
    }
  }
  // Legacy runs sometimes have no question options in the persisted payload.
  // The dictionary is only used for exact tokens in an explicit answer
  // context, so it cannot rewrite arbitrary prose.
  for (const [id, label] of Object.entries(legacySolutionOptionLabels)) {
    if (!labels.has(id)) labels.set(id, label)
  }
  return labels
}

function solutionAnswerToken(value: string, labels: ReadonlyMap<string, string>) {
  const normalized = value.trim()
  if (!normalized) return ''
  if (/^其他[：:]/u.test(normalized)) return normalized
  return labels.get(normalized.toLocaleLowerCase()) ?? normalized
}

function solutionAnswerValue(value: unknown, labels: ReadonlyMap<string, string>, questions: readonly SolutionAnswerQuestion[]): string {
  if (Array.isArray(value)) return value.map((item) => solutionAnswerValue(item, labels, questions)).filter(Boolean).join('、')
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('value' in record || 'answer' in record) return solutionAnswerValue(record.value ?? record.answer, labels, questions)
    return Object.entries(record)
      .filter(([key]) => !['action', 'questionId', 'question_id'].includes(key))
      .map(([key, item]) => {
        const question = answerQuestionForKey(key, questions)
        const rendered: string = solutionAnswerValue(item, labels, questions)
        return rendered ? `${answerKeyLabel(key, questions)}：${rendered}` : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (value === undefined || value === null) return ''
  const text = String(value).trim()
  if (!text) return ''
  if (/^（用户暂不确定）$|^\(用户暂不确定\)$/u.test(text)) return '暂不确定'
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      const parsed = JSON.parse(text) as unknown
      const rendered: string = solutionAnswerValue(parsed, labels, questions)
      if (rendered) return rendered
    } catch {
      // Preserve free-form text when a legacy adapter emitted JSON-like text.
    }
  }
  const parts = text.split(/[、,，;；]/u).map((item) => item.trim()).filter(Boolean)
  if (parts.length > 1 && parts.every((part) => labels.has(part.toLocaleLowerCase()) || /^其他[：:]/u.test(part))) {
    return parts.map((part) => solutionAnswerToken(part, labels)).join('、')
  }
  return solutionAnswerToken(text, labels)
}

/**
 * Normalize a solution request/answer for display and for draft projection.
 * `questions` should be supplied whenever the persisted payload contains
 * option metadata; the legacy labels cover old payloads without metadata.
 */
export function normalizeSolutionAnswerForDisplay(
  content: string,
  questions: readonly SolutionAnswerQuestion[] = [],
) {
  if (!content.trim()) return content
  const labels = solutionAnswerLabels(questions)
  const marker = /(^|\n)补充信息：?/u.exec(content)
  if (marker) {
    const markerEnd = marker.index + marker[0].length
    const prefix = content.slice(0, markerEnd)
    const supplement = content.slice(markerEnd)
    const parsedEntries = answerEntriesFromText(supplement)
    // Resume payloads from the local compatibility path are serialized as a
    // JSON question-id map. Render the map as labelled Chinese answers before
    // applying token-level replacement, otherwise the UI leaks ids such as
    // `CUSTOMER_TYPE` and `ENTERPRISE` into the transcript.
    if (parsedEntries.length && answerMapMatchesQuestions(supplement, questions)) {
      const rendered = solutionAnswerValue(Object.fromEntries(parsedEntries), labels, questions)
      if (rendered) return `${prefix}\n${rendered}`
    }
    const ids = [...labels.keys()]
      .filter((id) => id.length > 1)
      .sort((left, right) => right.length - left.length)
      .map((id) => id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    if (ids.length) {
      const translated = supplement.replace(
        new RegExp(`(?<![A-Za-z0-9_-])(${ids.join('|')})(?![A-Za-z0-9_-])`, 'giu'),
        (match) => solutionAnswerToken(match, labels),
      )
      return `${prefix}${translated}`
    }
    return content
  }

  const trimmed = content.trim()
  // A whole JSON value is an answer map in older adapters.  Do not attempt
  // this parse on ordinary solution prose.
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const rendered = solutionAnswerValue(parsed, labels, questions)
      if (rendered) return rendered
    } catch {
      // Fall through to exact-token handling.
    }
  }

  const segments = trimmed.split(/[、,，;；]/u).map((item) => item.trim()).filter(Boolean)
  if (segments.length > 1 && segments.every((segment) => labels.has(segment.toLocaleLowerCase()) || /^其他[：:]/u.test(segment))) {
    return segments.map((segment) => solutionAnswerToken(segment, labels)).join('、')
  }
  if (labels.has(trimmed.toLocaleLowerCase()) || /^（用户暂不确定）$|^\(用户暂不确定\)$/u.test(trimmed)) {
    return solutionAnswerValue(trimmed, labels, questions)
  }

  // Handle a compact `QUESTION_ID: option_id` form without touching normal
  // prose.  This is common in historical batch answers.
  const lines = content.split('\n')
  let changed = false
  const renderedLines = lines.map((line) => {
    const match = /^(\s*[^：:]{1,120}[：:])\s*(\S.*)\s*$/u.exec(line)
    if (!match || !labels.has(match[2].trim().toLocaleLowerCase())) return line
    changed = true
    const rawKey = match[1].replace(/[：:]\s*$/u, '').trim()
    const renderedKey = answerQuestionForKey(rawKey, questions) || legacySolutionQuestionLabels[rawKey.toLocaleLowerCase()]
      ? answerKeyLabel(rawKey, questions)
      : rawKey
    return `${renderedKey}：${solutionAnswerToken(match[2], labels)}`
  })
  return changed ? renderedLines.join('\n') : content
}

function hasExplicitDeploymentDecision(text: string) {
  return /(?:私有化(?:部署|方案)?|本地(?:化)?部署|混合部署|公有云(?:部署)?|私有云(?:部署)?|云上部署|部署在|部署于|部署模式|部署方式)/iu.test(text)
}

function isAnsweredByRequest(question: ClarificationQuestion, request: string) {
  const normalizedRequest = request.trim()
  if (!normalizedRequest) return false
  const questionText = question.question.trim()

  // Do not ask whether to build/use a mini program when the original request
  // already names it. Feature-level questions (for example, which mini
  // program functions are needed) remain valid and are intentionally not
  // filtered by this predicate.
  if (/微信小程序/iu.test(normalizedRequest)
    && /(?:是否|明确|确定|要不要|需不需要).{0,24}微信小程序|(?:建设|使用|采用).{0,24}微信小程序|微信小程序.{0,24}(?:是否|明确|确定|待确认|用户端)/iu.test(questionText)) {
    return true
  }

  if (/部署|部署方式|部署模式/iu.test(questionText) && hasExplicitDeploymentDecision(normalizedRequest)) return true

  if (/(?:客户|甲方|主体|面向|服务对象).{0,18}(?:类型|主体|是谁|哪类|哪种)/iu.test(questionText)
    && /(?:客户|甲方|主体).{0,18}(?:企业|政府|事业单位|行业|集团|公司|医院|学校)/iu.test(normalizedRequest)) {
    return true
  }

  // A resumed local/remote request contains a clearly delimited supplement.
  // If one of the question's option ids or labels occurs there, that
  // question has already been decided and must not reappear in the next
  // draft. Match complete tokens for ids and phrases for Chinese labels.
  const supplement = /(?:^|\n)补充信息：?([\s\S]*)$/u.exec(normalizedRequest)?.[1] ?? ''
  if (!supplement.trim()) return false
  // Batch resumes may be serialized as `{QUESTION_ID: value}` or as one
  // `QUESTION_ID: value` line. A matching key is conclusive even when the
  // option value is a free-form “其他” description.
  const answerEntries = answerEntriesFromText(supplement)
  if (answerEntries.some(([key, value]) => {
    const normalizedKey = key.trim().toLocaleLowerCase()
    const matchesId = normalizedKey === question.id.trim().toLocaleLowerCase()
    const matchesText = Boolean(question.question?.trim()) && normalizedKey === question.question.trim().toLocaleLowerCase()
    if (!matchesId && !matchesText) return false
    const record = answerRecord(value)
    return record?.action === 'skip' || answerValuePresent(record?.value ?? record?.answer ?? value)
  })) return true
  // “其他：…” and an explicit skip are valid decisions even though their
  // free-form text does not equal an option id/label. They must not cause the
  // same clarification to be asked again on the resumed projection.
  if (answerEntries.length === 0 && /其他[：:]/u.test(supplement)
    && (question.options ?? []).some((option) => option.id.toLocaleLowerCase() === 'other' || /其他/u.test(option.label))) return true
  if (answerEntries.length === 0 && /^(?:\s*（用户暂不确定）\s*|\s*\(用户暂不确定\)\s*|\s*暂不确定\s*|\s*跳过\s*)$/u.test(supplement)) return true
  const values = [question.id, ...(question.options ?? []).flatMap((option) => [option.id, option.label])]
    .map((value) => value.trim())
    .filter(Boolean)
  return values.some((value) => {
    if (/[\p{Script=Han}]/u.test(value)) return supplement.includes(value)
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'iu').test(supplement)
  })
}

function filterAnsweredClarificationQuestions(questions: ClarificationQuestion[], request: string) {
  return questions.filter((question) => !isAnsweredByRequest(question, request))
}

/** Keep legacy blocked runs useful when their original payload was sparse. */
export function normalizeSolutionDraftForDisplay(draft: SolutionDraft, request = ''): SolutionDraft {
  const requestedText = normalizeSolutionAnswerForDisplay(request, draft.clarificationQuestions ?? []).trim()
    || normalizeSolutionAnswerForDisplay(draft.customerContext, draft.clarificationQuestions ?? []).trim()
    || '待补充客户需求与交付目标'
  const filteredRequirements = draft.requirements.length
    ? draft.requirements.filter((requirement) => !(/微信小程序/iu.test(requestedText)
      && /(?:是否|明确|确定|要不要|需不需要|建设|使用|采用).{0,24}微信小程序|微信小程序.{0,24}(?:是否|明确|确定|待确认|用户端)/iu.test(requirement.text)))
    : []
  const requirements = filteredRequirements.length
    ? filteredRequirements
    : [{ id: 'REQ-1', text: requestedText, source: '待确认' }]
  const existingSections = draft.sections
  const primaryCitation = draft.citations[0]
  const sections = requiredSections.map((title, index) => {
    const existing = existingSections.find((section) => section.title.trim() === title) ?? existingSections[index]
    if (existing) {
      return {
        ...existing,
        title: existing.title.trim() || title,
        contentMarkdown: existing.contentMarkdown.trim() || `待补充“${title}”的具体内容。`,
      }
    }
    const contentMarkdown = index === 0
      ? '当前证据不足，先保留可编辑的方案骨架；完成待确认问题后再生成正式结论。'
      : index === 1
        ? `客户需求：${requestedText}\n\n待确认客户行业、目标、范围和交付物。`
        : index === 2
          ? '待根据已确认需求匹配企业能力，并补充总体架构、功能模块与能力边界。'
          : index === 3
            ? '待确认范围后，按需求确认、方案评审、实施验证和交付复盘分阶段推进。'
            : '待确认适用范围、版本、生效时间及未解决的资料冲突。'
    return {
      id: `SEC-${index + 1}`,
      title,
      contentMarkdown,
      requirementIds: index === 1 ? ['REQ-1'] : [],
      citationIds: primaryCitation ? [primaryCitation.id] : [],
    }
  })
  const hasDiagnosticSummary = !draft.executiveSummary.trim()
    || /正文或章节内容为空|未返回完整结构化方案|结构化结果校验失败/iu.test(draft.executiveSummary)
  // Historical drafts may contain only the descriptive openQuestions field
  // (the original projection did not persist clarificationQuestions).  Build
  // an interactive batch on read so old conversations gain the same dialog
  // without requiring a new Agent run.
  const sourceClarificationQuestions = draft.clarificationQuestions?.length
    ? draft.clarificationQuestions
    : clarificationQuestionsFromOpenQuestions(draft.openQuestions).length
      ? clarificationQuestionsFromOpenQuestions(draft.openQuestions)
      : clarificationQuestionsFromRequirements(draft.requirements)
  const filteredClarificationQuestions = sourceClarificationQuestions.length
    ? filterAnsweredClarificationQuestions(sourceClarificationQuestions, requestedText)
    : []
  const clarificationQuestions = filteredClarificationQuestions.length
    ? dedupeClarificationQuestions(filteredClarificationQuestions)
    : []
  const displayText = (value: string) => normalizeSolutionAnswerForDisplay(value, draft.clarificationQuestions ?? [])
  return {
    ...draft,
    customerContext: displayText(draft.customerContext),
    executiveSummary: hasDiagnosticSummary
      ? '当前证据不足，已生成可继续确认和编辑的方案骨架。'
      : displayText(draft.executiveSummary),
    requirements: requirements.map((requirement) => ({ ...requirement, text: displayText(requirement.text) })),
    sections: sections.map((section) => ({ ...section, contentMarkdown: displayText(section.contentMarkdown) })),
    openQuestions: draft.openQuestions.length ? draft.openQuestions : draft.status === 'BLOCKED' ? ['请补充客户行业、核心目标、范围和部署方式'] : [],
    clarificationQuestions,
    evidenceGaps: draft.evidenceGaps.length ? draft.evidenceGaps : draft.status === 'BLOCKED' ? ['没有匹配到可引用的正式企业知识'] : [],
  }
}

function tokens(value: string) {
  return [...new Set(value.normalize('NFKC').toLocaleLowerCase().match(/[\p{Script=Han}]|[a-z0-9]+/giu) ?? [])]
}

function score(query: string, text: string) {
  const haystack = text.normalize('NFKC').toLocaleLowerCase()
  return tokens(query).reduce((count, token) => count + (haystack.includes(token) ? 1 : 0), 0)
}

function citationId(knowledgeId: string, assetId: string, locator: string) {
  return `DRAFT-${Buffer.from(JSON.stringify({ knowledgeId, assetId, locator }), 'utf8').toString('base64url')}`
}

function decodeCitation(id: string) {
  if (!id.startsWith('DRAFT-')) return undefined
  try {
    const value = JSON.parse(Buffer.from(id.slice(6), 'base64url').toString('utf8')) as Record<string, string>
    if (value.knowledgeId && value.assetId && value.locator) return value
  } catch {
    // Invalid ids are reported by the quality check.
  }
  return undefined
}

function qualityFor(draft: Omit<SolutionDraft, 'quality' | 'status' | 'createdAt' | 'updatedAt' | 'currentVersion' | 'id' | 'conversationId' | 'sourceRunId'>) {
  const citationIds = new Set(draft.citations.map((citation) => citation.id))
  const invalidCitations = draft.sections.flatMap((section) => section.citationIds.filter((id) => !citationIds.has(id)))
  invalidCitations.push(...draft.conflicts.flatMap((conflict) => [
    ...conflict.citationIds,
    ...conflict.alternatives.flatMap((alternative) => alternative.citationIds),
  ].filter((id) => !citationIds.has(id))))
  invalidCitations.push(...draft.citations
    .filter((citation) => !citation.locator.trim() || !citation.excerpt.trim())
    .map((citation) => citation.id))
  const missingSections = requiredSections.filter((title) => !draft.sections.some((section) => section.title === title))
  const unresolvedConflict = draft.conflicts.some((conflict) => conflict.status === 'UNRESOLVED')
  const hasEvidence = draft.citations.length > 0 && draft.sections.length > 0
  const hasEmptyContent = !draft.executiveSummary.trim() || draft.sections.some((section) => !section.contentMarkdown.trim())
  const linkedSections = draft.sections.filter((section) => section.citationIds.length > 0).length
  const evidenceCoverage = hasEvidence ? linkedSections / draft.sections.length : 0
  const capabilities = draft.capabilityMatches ?? []
  const capabilityNeedsReview = draft.requirements.length > 0 && (
    capabilities.length === 0
    || capabilities.some((item) => item.reviewRequired || ['UNKNOWN', 'R_AND_D', 'CUSTOM'].includes(item.matchType.toUpperCase()))
  )
  const status = invalidCitations.length || !hasEvidence || hasEmptyContent || unresolvedConflict
    ? 'BLOCKED'
    : missingSections.length || draft.assumptions.length || draft.openQuestions.length || draft.risks.length || draft.evidenceGaps.length
      || capabilityNeedsReview
      ? 'NEEDS_REVIEW'
      : 'READY'
  const enterpriseMatches = capabilities.filter((item) => item.matchType.toUpperCase() === 'EXISTING'
    && ['PRODUCTIZED', 'DELIVERED'].includes(item.deliveryStatus.toUpperCase()))
  const evidence = draft.evidence ?? []
  const evidenceCount = Math.max(evidence.length, 1)
  const confidenceSummary: ConfidenceSummary = {
    enterpriseCoverage: capabilities.length ? enterpriseMatches.length / capabilities.length : 0,
    evidenceCoverage,
    industryReferenceRatio: evidence.filter((item) => item.sourceType.toUpperCase() === 'INDUSTRY_REFERENCE').length / evidenceCount,
    innovationRatio: evidence.filter((item) => item.sourceType.toUpperCase() === 'INNOVATION_HYPOTHESIS').length / evidenceCount,
    notes: draft.requirements.length > 0 && !enterpriseMatches.length ? ['能力目录为空或未匹配到已登记能力'] : [],
  }
  return {
    quality: {
      status: status as SolutionDraft['status'],
      evidenceCoverage,
      missingSections,
      invalidCitations: [...new Set(invalidCitations)],
      notes: [
        ...(unresolvedConflict ? ['存在未解决冲突，不能输出确定结论'] : []),
        ...(hasEmptyContent ? ['正文或章节内容为空'] : []),
        ...(evidenceCoverage < 1 && hasEvidence ? ['部分章节缺少引用'] : []),
      ],
    },
    confidenceSummary,
  }
}

function readField(record: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!record) return undefined
  for (const key of keys) {
    if (record[key] !== undefined) return record[key]
  }
  return undefined
}

function readArray(record: Record<string, unknown> | undefined, ...keys: string[]) {
  const value = readField(record, ...keys)
  return Array.isArray(value) ? value : []
}

function balancedJsonCandidates(text: string) {
  const candidates: string[] = []
  let start: number | undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (start === undefined) {
      if (character === '{') {
        start = index
        depth = 1
      }
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\' && inString) {
      escaped = true
      continue
    }
    if (character === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0) {
        candidates.push(text.slice(start, index + 1))
        start = undefined
      }
    }
  }
  return candidates
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    const candidates = [
      text.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''),
      ...balancedJsonCandidates(text),
    ]
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      } catch {
        // Try the next candidate; malformed model output is handled by the
        // deterministic quality check below.
      }
    }
    return undefined
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function looksLikeBlueprint(value: Record<string, unknown>) {
  return [...blueprintKeys].some((key) => value[key] !== undefined)
}

function extractBlueprintRecord(value: unknown, depth = 0): { status: 'EMPTY' | 'MALFORMED' | 'VALID'; record?: Record<string, unknown>; reason?: string } {
  if (depth > 8 || value === null || value === undefined) return { status: 'EMPTY' }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return { status: 'EMPTY' }
    // Ordinary assistant prose is not a malformed Blueprint. Treat it as an
    // empty structured result so the caller can offer a retry instead of
    // presenting a misleading blocked draft. JSON-looking output, however,
    // carries a concrete structural failure worth diagnosing.
    const looksLikeJson = text.startsWith('{') || text.startsWith('[') || text.startsWith('```')
    if (!looksLikeJson && !/"(?:title|sections|requirements|executive_summary)"\s*:/iu.test(text)) return { status: 'EMPTY' }
  }
  if (Array.isArray(value)) {
    let sawMalformed = false
    for (const item of value) {
      const result = extractBlueprintRecord(item, depth + 1)
      if (result.status === 'VALID') return result
      if (result.status === 'MALFORMED') sawMalformed = true
    }
    return sawMalformed ? { status: 'MALFORMED', reason: '未找到可校验的方案草稿结构' } : { status: 'EMPTY' }
  }
  const record = asRecord(value)
  if (!record) return { status: 'MALFORMED', reason: '方案结果不是有效的 JSON 对象' }
  if (looksLikeBlueprint(record)) return { status: 'VALID', record }
  let sawMalformed = false
  for (const key of ['output', 'result', 'payload', 'data', 'message', 'content', 'text', 'messages', 'structured_response', 'additional_kwargs', 'response_metadata']) {
    if (record[key] === undefined) continue
    const result = extractBlueprintRecord(record[key], depth + 1)
    if (result.status === 'VALID') return result
    if (result.status === 'MALFORMED') sawMalformed = true
  }
  return sawMalformed ? { status: 'MALFORMED', reason: '未找到可校验的方案草稿结构' } : { status: 'EMPTY' }
}

function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}

type OpenQuestionInput = {
  text: string
  record?: Record<string, unknown>
}

/**
 * Read the semantic question forms emitted by different Agent versions.
 * `open_questions` is allowed to contain either strings or objects with
 * question/prompt/text plus optional type/options metadata.
 */
function openQuestionInputs(value: unknown): OpenQuestionInput[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): OpenQuestionInput[] => {
    if (typeof item === 'string' && item.trim()) return [{ text: item.trim() }]
    const record = asRecord(item)
    if (!record) return []
    const text = ['question', 'prompt', 'text', 'description']
      .map((key) => readField(record, key))
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    return text ? [{ text: text.trim(), record }] : []
  })
}

function safeQuestionOptions(text: string): { type: ClarificationQuestion['type']; options: ClarificationQuestion['options'] } {
  // These are stable product dimensions, not model claims.  They provide a
  // useful choice list when an Agent only emitted a prose open question.
  if (/部署|私有化|公有云|混合部署|云上/iu.test(text)) {
    return {
      type: 'SINGLE_CHOICE',
      options: [
        { id: 'PRIVATE_DEPLOYMENT', label: '私有化部署' },
        { id: 'HYBRID_DEPLOYMENT', label: '混合部署' },
        { id: 'PUBLIC_CLOUD', label: '公有云部署' },
        { id: 'OTHER', label: '其他（请说明）' },
      ],
    }
  }
  if (/运营模式|自营|多商户|分销/iu.test(text)) {
    return {
      type: 'SINGLE_CHOICE',
      options: [
        { id: 'SELF_OPERATED', label: '自营' },
        { id: 'PLATFORM', label: '平台入驻 / 多商户' },
        { id: 'DISTRIBUTION', label: '分销' },
        { id: 'STORE_DELIVERY', label: '门店配送' },
        { id: 'OTHER', label: '其他（请说明）' },
      ],
    }
  }
  if (/展示型|完整线上销售|购物车|下单|支付|产品形态|小程序/iu.test(text)) {
    return {
      type: 'SINGLE_CHOICE',
      options: [
        { id: 'SHOWCASE', label: '展示型小程序（浏览、咨询为主）' },
        { id: 'FULL_COMMERCE', label: '完整交易小程序（购物车、下单和支付）' },
        { id: 'OTHER', label: '其他（请说明）' },
      ],
    }
  }
  if (/首期|范围|必须包含|功能模块|用户端|管理端/iu.test(text)) {
    return {
      type: 'MULTIPLE_CHOICE',
      options: [
        { id: 'USER_APP', label: '用户端' },
        { id: 'ADMIN', label: '运营管理端' },
        { id: 'CATALOG', label: '商品管理与上下架' },
        { id: 'TRANSACTION', label: '购物车、下单和支付' },
        { id: 'OTHER', label: '其他（请说明）' },
      ],
    }
  }
  if (/SKU|商品数量|规模/iu.test(text)) {
    return {
      type: 'SINGLE_CHOICE',
      options: [
        { id: 'SMALL', label: '少于 100 个 SKU' },
        { id: 'MEDIUM', label: '100–1000 个 SKU' },
        { id: 'LARGE', label: '超过 1000 个 SKU' },
        { id: 'OTHER', label: '其他（请说明）' },
      ],
    }
  }
  if (/ERP|库存|物流|客服|系统对接|接口/iu.test(text)) {
    return {
      type: 'MULTIPLE_CHOICE',
      options: [
        { id: 'ERP', label: 'ERP / 业务系统' },
        { id: 'INVENTORY', label: '库存系统' },
        { id: 'LOGISTICS', label: '物流 / 配送系统' },
        { id: 'SERVICE', label: '客服 / 会员系统' },
        { id: 'OTHER', label: '其他（请说明）' },
      ],
    }
  }
  if (/退款|优惠券|会员|营销|促销/iu.test(text)) {
    return {
      type: 'MULTIPLE_CHOICE',
      options: [
        { id: 'REFUND', label: '退款与售后' },
        { id: 'COUPON', label: '优惠券 / 促销' },
        { id: 'MEMBERSHIP', label: '会员 / 积分' },
        { id: 'GROUP_BUY', label: '拼团 / 秒杀' },
        { id: 'OTHER', label: '其他（请说明）' },
      ],
    }
  }
  return { type: 'TEXT', options: [] }
}

function clarificationQuestionsFromOpenQuestions(value: unknown): ClarificationQuestion[] {
  const inputs = openQuestionInputs(value)
  const total = inputs.length
  return inputs.flatMap(({ text, record }, index) => {
    const rawOptions = readArray(record, 'options').flatMap((option, optionIndex) => {
      if (typeof option === 'string' && option.trim()) return [{ id: option.trim(), label: option.trim() }]
      const optionRecord = asRecord(option)
      if (!optionRecord) return []
      const id = stringValue(readField(optionRecord, 'id', 'value'), `OPTION_${optionIndex + 1}`).trim()
      const label = stringValue(readField(optionRecord, 'label', 'text', 'name'), id).trim()
      if (!id || !label) return []
      const description = readField(optionRecord, 'description')
      return [{ id, label, ...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {}) }]
    })
    const inferred = safeQuestionOptions(text)
    const options = rawOptions.length ? rawOptions : inferred.options
    const rawType = stringValue(readField(record, 'type')).trim().toUpperCase()
    const type: ClarificationQuestion['type'] = options.length
      ? (rawType === 'MULTIPLE_CHOICE' ? 'MULTIPLE_CHOICE' : 'SINGLE_CHOICE')
      : rawType === 'SINGLE_CHOICE' || rawType === 'MULTIPLE_CHOICE' || rawType === 'TEXT'
        ? rawType
        : inferred.type
    const id = stringValue(readField(record, 'id', 'questionId', 'question_id'), `OPEN_QUESTION_${index + 1}`).trim()
    return [{
      id,
      question: text,
      type,
      options,
      required: readField(record, 'required') !== false,
      allowSkip: readField(record, 'allowSkip', 'allow_skip') !== false,
      position: index + 1,
      total: Math.max(1, total),
    }]
  })
}

/**
 * Recover an interactive confirmation batch from a legacy requirement list.
 *
 * Some Agent versions produced a useful requirement analysis but omitted both
 * `open_questions` and `clarification_questions`.  We only derive questions
 * when the requirement (or its source label) explicitly signals an unresolved
 * decision.  Ordinary requirements are intentionally left alone so this
 * compatibility layer cannot turn a completed design into a speculative form.
 */
function clarificationQuestionsFromRequirements(requirements: readonly DraftRequirement[]): ClarificationQuestion[] {
  const pending = requirements.filter((requirement) => {
    const text = `${requirement.source ?? ''} ${requirement.text}`.trim()
    return /待确认|待补充|需要确认|尚未(?:明确|确定)|未(?:明确|确定)|建议纳入(?:首期)?范围|建议(?:纳入|考虑)|(?:产品|能力|范围)推断/iu.test(text)
  })
  if (!pending.length) return []

  const scopeRequirements = pending.filter((requirement) => /首期|范围|功能模块|用户端|管理端|建议纳入/iu.test(`${requirement.source ?? ''} ${requirement.text}`))
  const otherRequirements = pending.filter((requirement) => !scopeRequirements.includes(requirement))
  const questions: ClarificationQuestion[] = []

  if (scopeRequirements.length) {
    const labels = [...new Set(scopeRequirements.flatMap((requirement) => {
      const cleaned = requirement.text
        .replace(/^\s*(?:建议|推荐)?纳入首期范围\s*[:：]?\s*/iu, '')
        .replace(/^\s*(?:首期范围|范围)\s*[:：]?\s*/iu, '')
        .trim()
      if (!cleaned) return []
      // Keep explicitly separated bullets as individual choices.  When a
      // legacy payload used one prose sentence, retain it as one option rather
      // than guessing where the product boundary should be split.
      const parts = cleaned.split(/\n+|[；;]+/u).map((item) => item.trim()).filter(Boolean)
      return parts.length ? parts : [cleaned]
    }))]
    const options = labels.length > 1
      ? labels.map((label, index) => ({ id: `SCOPE_${index + 1}`, label }))
      : [
        { id: 'INCLUDE_SUGGESTED', label: '纳入上述建议范围' },
        { id: 'ADJUST_SCOPE', label: '需要调整首期范围' },
      ]
    options.push(
      { id: 'UNDECIDED', label: '暂未确定首期范围' },
      { id: 'OTHER', label: '其他（请说明）' },
    )
    questions.push({
      id: 'REQUIREMENT_SCOPE',
      question: '以下建议内容是否纳入首期建设范围？',
      type: 'MULTIPLE_CHOICE',
      options,
      required: true,
      allowSkip: true,
      position: 1,
      total: 1,
    })
  }

  for (const [index, requirement] of otherRequirements.entries()) {
    const text = requirement.text.trim()
    if (!text) continue
    const inferred = safeQuestionOptions(text)
    const question = /[？?]$/u.test(text)
      ? text
      : /^\s*(?:明确|确认|确定|请确认)/u.test(text)
        ? `请${text.replace(/^\s*(?:明确|确认|确定|请确认)\s*/u, '')}`
        : `请确认：${text}`
    questions.push({
      id: requirement.id.trim() || `REQUIREMENT_${index + 1}`,
      question,
      type: inferred.type,
      options: inferred.options,
      required: true,
      allowSkip: true,
      position: questions.length + 1,
      total: questions.length + 1,
    })
  }

  return dedupeClarificationQuestions(questions)
}

function riskList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [item.trim()]
    const record = asRecord(item)
    if (!record) return []
    const description = ['description', 'risk', 'claim', 'title', 'text']
      .map((key) => readField(record, key))
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    if (!description) return []
    const mitigation = readField(record, 'mitigation')
    return [
      `${description.trim()}${typeof mitigation === 'string' && mitigation.trim() ? `（缓解措施：${mitigation.trim()}）` : ''}`,
    ]
  })
}

/** Normalize untrusted Agent output before it enters the product snapshot. */
export function createAgentSolutionDraft(
  snapshot: PlatformSnapshot,
  conversationId: string,
  sourceRunId: string,
  value: unknown,
  request = '',
): SolutionDraft {
  const extraction = extractBlueprintRecord(value)
  if (extraction.status === 'EMPTY') {
    throw new SolutionDraftExtractionError('AGENT_EMPTY_RESULT', 'Agent 未返回有效方案结果，请重试', true)
  }
  const raw = extraction.record ?? {
    title: '方案草稿（结构化结果异常）',
    executive_summary: `方案结果无法校验：${extraction.reason ?? '未找到符合格式的结构化结果'}（运行编号：${sourceRunId}）`,
    evidence_gaps: [extraction.reason ?? '未找到符合格式的结构化结果'],
    sections: [{ id: 'DIAGNOSTIC', title: '执行诊断', content_markdown: extraction.reason ?? '方案结果无法校验', citation_ids: [] }],
  }
  const requestedText = request.trim()
    || stringValue(readField(raw, 'customerContext', 'customer_context'))
    || stringValue(readField(raw, 'title'), '待补充客户需求')
  const rawCitations = readArray(raw, 'citations')
  const citations: DraftCitation[] = rawCitations.flatMap((item, index) => {
    const record = asRecord(item)
    if (!record) return []
    const id = stringValue(readField(record, 'id'), `CIT-${index + 1}`)
    const title = stringValue(readField(record, 'title'), `来源 ${index + 1}`)
    const locator = stringValue(readField(record, 'locator'), 'document')
    const excerpt = stringValue(readField(record, 'excerpt'))
    const sourceUrl = readField(record, 'sourceUrl', 'source_url')
    return [{ id, title, locator, excerpt, ...(typeof sourceUrl === 'string' ? { sourceUrl } : {}) }]
  })
  const parsedSections: DraftSection[] = readArray(raw, 'sections').flatMap((item, index) => {
    const record = asRecord(item)
    if (!record) return []
    // Preserve unknown ids so the deterministic quality check can surface an
    // invalid citation instead of silently dropping evidence references.
    const idsValue = readField(record, 'citationIds', 'citation_ids')
    const ids = Array.isArray(idsValue)
      ? idsValue.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : []
    return [{
      id: stringValue(readField(record, 'id'), `SEC-${index + 1}`),
      title: stringValue(readField(record, 'title'), `章节 ${index + 1}`),
      contentMarkdown: stringValue(readField(record, 'contentMarkdown', 'content_markdown')),
      requirementIds: stringList(readField(record, 'requirementIds', 'requirement_ids')),
      citationIds: ids,
    }]
  })
  const rawRequirements: DraftRequirement[] = readArray(raw, 'requirements').flatMap((item, index) => {
    if (typeof item === 'string' && item.trim()) return [{ id: `REQ-${index + 1}`, text: item }]
    const record = asRecord(item)
    if (!record || !stringValue(readField(record, 'text')).trim()) return []
    const source = readField(record, 'source')
    return [{ id: stringValue(readField(record, 'id'), `REQ-${index + 1}`), text: stringValue(readField(record, 'text')), ...(typeof source === 'string' ? { source } : {}) }]
  })
  const requirements: DraftRequirement[] = rawRequirements.length
    ? rawRequirements
      .filter((requirement) => !(/微信小程序/iu.test(requestedText)
        && /(?:是否|明确|确定|要不要|需不需要|建设|使用|采用).{0,24}微信小程序|微信小程序.{0,24}(?:是否|明确|确定|待确认|用户端)/iu.test(requirement.text)))
    : [{ id: 'REQ-1', text: requestedText, source: '待确认' }]
  const conflicts: ConflictItem[] = readArray(raw, 'conflicts').flatMap((item) => {
    const record = asRecord(item)
    if (!record) return []
    const alternatives = readArray(record, 'alternatives').flatMap((alternative) => {
      const candidate = asRecord(alternative)
      if (!candidate) return []
      const citationIds = readField(candidate, 'citationIds', 'citation_ids')
      return [{
        statement: stringValue(readField(candidate, 'statement'), stringValue(readField(candidate, 'text'))),
        applicability: asRecord(readField(candidate, 'applicability')) as Record<string, string> ?? {},
        citationIds: Array.isArray(citationIds)
          ? citationIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          : [],
      }]
    })
    const citationIds = readField(record, 'citationIds', 'citation_ids')
    const status = stringValue(readField(record, 'status'), 'UNRESOLVED')
    return [{
      claim: stringValue(readField(record, 'claim'), '未命名冲突'),
      alternatives,
      applicability: stringValue(readField(record, 'applicability')),
      citationIds: Array.isArray(citationIds)
        ? citationIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        : [],
      status: status === 'SCOPED' ? 'SCOPED' : 'UNRESOLVED',
    }]
  })
  const capabilityMatches: CapabilityMatch[] = readArray(raw, 'capabilityMatches', 'capability_matches').flatMap((item) => {
    const record = asRecord(item)
    if (!record) return []
    const readNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
    const citationIds = readField(record, 'citationIds', 'citation_ids')
    const limitations = readField(record, 'limitations')
    return [{
      requirementId: stringValue(readField(record, 'requirementId', 'requirement_id')),
      capabilityId: stringValue(readField(record, 'capabilityId', 'capability_id')),
      capabilityName: stringValue(readField(record, 'capabilityName', 'capability_name')),
      deliveryStatus: stringValue(readField(record, 'deliveryStatus', 'delivery_status'), 'UNKNOWN'),
      matchType: stringValue(readField(record, 'matchType', 'match_type'), 'UNKNOWN'),
      matchScore: readNumber(readField(record, 'matchScore', 'match_score')),
      confidence: readNumber(readField(record, 'confidence')),
      citationIds: Array.isArray(citationIds) ? citationIds.filter((id): id is string => typeof id === 'string') : [],
      limitations: Array.isArray(limitations) ? limitations.filter((item): item is string => typeof item === 'string') : [],
      reviewRequired: readField(record, 'reviewRequired', 'review_required') !== false,
    }]
  })
  const architecture = asRecord(readField(raw, 'architecture')) ?? (() => {
    const section = parsedSections.find((item) => item.title.includes('架构'))
    return section ? {
      overview: section.contentMarkdown,
      layers: [],
      sourceSectionId: section.id,
    } : {}
  })()
  const evidence: DraftEvidenceItem[] = readArray(raw, 'evidence').flatMap((item, index) => {
    const record = asRecord(item)
    if (!record) return []
    const confidence = readField(record, 'confidence')
    const citationId = readField(record, 'citationId', 'citation_id')
    return [{
      id: stringValue(readField(record, 'id'), `EVD-${index + 1}`),
      sourceType: stringValue(readField(record, 'sourceType', 'source_type'), 'ENTERPRISE_FORMAL'),
      title: stringValue(readField(record, 'title')),
      locator: stringValue(readField(record, 'locator')),
      excerpt: stringValue(readField(record, 'excerpt')),
      confidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : 0,
      ...(typeof citationId === 'string' ? { citationId } : {}),
    }]
  })
  const normalizedEvidence = evidence.length ? evidence : citations.map((citation, index) => ({
    id: `EVD-${index + 1}`,
    sourceType: 'ENTERPRISE_FORMAL',
    title: citation.title,
    locator: citation.locator,
    excerpt: citation.excerpt,
    confidence: 0.8,
    citationId: citation.id,
  }))
  const reviewRaw = asRecord(readField(raw, 'review'))
  const review: SolutionReviewState = {
    status: stringValue(readField(reviewRaw, 'status'), requirements.length > 0 && (
      capabilityMatches.length === 0 || capabilityMatches.some((item) => item.reviewRequired)
    ) ? 'REQUIRED' : 'NOT_REQUIRED'),
    pendingItems: stringList(readField(reviewRaw, 'pendingItems', 'pending_items')),
    requiredRoles: stringList(readField(reviewRaw, 'requiredRoles', 'required_roles')),
    decisions: Array.isArray(readField(reviewRaw, 'decisions')) ? (readField(reviewRaw, 'decisions') as Array<Record<string, unknown>>) : [],
  }
  const executionTrace = (() => {
    const value = readField(raw, 'executionTrace', 'execution_trace')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const trace = value as Record<string, unknown>
    const steps = Array.isArray(trace.steps)
      ? trace.steps.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const step = item as Record<string, unknown>
        return [{
          stage: stringValue(step.stage),
          label: stringValue(step.label, stringValue(step.stage)),
          message: stringValue(step.message),
          status: stringValue(step.status, 'COMPLETED'),
          startedAt: typeof step.startedAt === 'string' ? step.startedAt : null,
          finishedAt: typeof step.finishedAt === 'string' ? step.finishedAt : null,
          elapsedMs: typeof step.elapsedMs === 'number' && Number.isFinite(step.elapsedMs) ? Math.max(0, step.elapsedMs) : 0,
        }]
      })
      : []
    return {
      status: stringValue(trace.status, 'COMPLETED'),
      startedAt: typeof trace.startedAt === 'string' ? trace.startedAt : null,
      finishedAt: typeof trace.finishedAt === 'string' ? trace.finishedAt : null,
      elapsedMs: typeof trace.elapsedMs === 'number' && Number.isFinite(trace.elapsedMs) ? Math.max(0, trace.elapsedMs) : 0,
      steps,
    }
  })()
  if (review.status === 'REQUIRED' && !review.pendingItems.length) {
    review.pendingItems = ['请售前或架构师确认企业能力覆盖范围']
  }
  const primaryCitation = citations[0]
  const sections: DraftSection[] = requiredSections.map((title, index) => {
    const existing = parsedSections.find((section) => section.title.trim() === title)
      ?? parsedSections[index]
    if (existing) {
      return {
        ...existing,
        title: existing.title.trim() || title,
        contentMarkdown: existing.contentMarkdown.trim() || `待补充“${title}”的具体内容。`,
      }
    }
    const contentMarkdown = index === 0
      ? '当前证据不足，先保留可编辑的方案骨架；完成待确认问题后再生成正式结论。'
      : index === 1
        ? `客户需求：${requestedText}\n\n待确认客户行业、目标、范围和交付物。`
        : index === 2
          ? '待根据已确认需求匹配企业能力，并补充总体架构、功能模块与能力边界。'
          : index === 3
            ? '待确认范围后，按需求确认、方案评审、实施验证和交付复盘分阶段推进。'
            : '待确认适用范围、版本、生效时间及未解决的资料冲突。'
    return {
      id: `SEC-${index + 1}`,
      title,
      contentMarkdown,
      requirementIds: index === 1 ? ['REQ-1'] : [],
      citationIds: primaryCitation ? [primaryCitation.id] : [],
    }
  })
  const rawOpenQuestionValue = readField(raw, 'openQuestions', 'open_questions')
  const normalizedOpenQuestions = openQuestionInputs(rawOpenQuestionValue)
  const rawOpenQuestions = normalizedOpenQuestions.map((item) => item.text)
  const rawEvidenceGaps = stringList(readField(raw, 'evidenceGaps', 'evidence_gaps'))
  const clarificationQuestions: ClarificationQuestion[] = readArray(raw, 'clarificationQuestions', 'clarification_questions').flatMap((item, index) => {
    const record = asRecord(item)
    if (!record) return []
    const options = readArray(record, 'options').flatMap((option) => {
      const value = asRecord(option)
      if (!value) return []
      const id = stringValue(readField(value, 'id', 'value'))
      const label = stringValue(readField(value, 'label', 'text'), id)
      return id && label ? [{ id, label, ...(typeof readField(value, 'description') === 'string' ? { description: String(readField(value, 'description')) } : {}) }] : []
    })
    const type = stringValue(readField(record, 'type'), 'TEXT')
    return [{
      id: stringValue(readField(record, 'id'), `QUESTION-${index + 1}`),
      question: stringValue(readField(record, 'question', 'prompt'), '请补充方案所需信息'),
      type: ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TEXT'].includes(type) ? type as ClarificationQuestion['type'] : 'TEXT',
      options,
      required: readField(record, 'required') !== false,
      allowSkip: readField(record, 'allowSkip', 'allow_skip') !== false,
      position: typeof readField(record, 'position') === 'number' ? Number(readField(record, 'position')) : index + 1,
      total: typeof readField(record, 'total') === 'number' ? Number(readField(record, 'total')) : Math.max(1, readArray(raw, 'clarificationQuestions', 'clarification_questions').length),
    }]
  })
  // A number of older/remote Agent prompts emitted only open_questions.  Turn
  // those semantic gaps into the same interactive batch used by explicit
  // clarification_questions, but never override a non-empty explicit batch.
  const derivedClarificationQuestions = clarificationQuestions.length
    ? []
    : clarificationQuestionsFromOpenQuestions(rawOpenQuestionValue)
  const candidateClarificationQuestions = clarificationQuestions.length
    ? clarificationQuestions
    : derivedClarificationQuestions.length
      ? derivedClarificationQuestions
      : clarificationQuestionsFromRequirements(requirements)
  const filteredClarificationQuestions = filterAnsweredClarificationQuestions(candidateClarificationQuestions, requestedText)
  const normalizedClarificationQuestions = dedupeClarificationQuestions(filteredClarificationQuestions)
  // A remote Agent owns the clarification set.  Do not invent a generic
  // question when the payload omitted it (or when all of its questions were
  // filtered because the original request already answered them).  The local
  // compatibility path may still provide its explicit deterministic fallback,
  // but a projected Yuxi result must reflect only questions the Agent asked.
  const generatedClarification = normalizedClarificationQuestions
  const base = {
    title: stringValue(readField(raw, 'title'), '方案草稿'),
    customer: stringValue(readField(raw, 'customer')),
    customerContext: stringValue(readField(raw, 'customerContext', 'customer_context')),
    executiveSummary: stringValue(readField(raw, 'executiveSummary', 'executive_summary'))
      || '当前证据不足，已生成可继续确认和编辑的方案骨架。',
    requirements,
    sections,
    assumptions: stringList(readField(raw, 'assumptions')),
    openQuestions: rawOpenQuestions.length
      ? rawOpenQuestions
      : generatedClarification.length
        ? generatedClarification.map((question) => question.question)
        : citations.length ? [] : ['请补充客户行业、目标、范围和部署方式'],
    // Keep an explicit empty array when the Agent has no pending questions.
    // Consumers use this field to distinguish "no clarification needed" from
    // an older payload that never exposed the field; omitting it also makes
    // historical projections unnecessarily fragile.
    clarificationQuestions: generatedClarification,
    risks: riskList(readField(raw, 'risks')),
    conflicts,
    evidenceGaps: rawEvidenceGaps.length ? rawEvidenceGaps : (citations.length ? [] : ['没有匹配到可引用的正式企业知识']),
    citations,
    capabilityMatches: capabilityMatches.length ? capabilityMatches : requirements.map((requirement) => ({
      requirementId: requirement.id,
      capabilityId: '',
      capabilityName: '企业能力目录未返回匹配结果',
      deliveryStatus: 'UNKNOWN',
      matchType: 'UNKNOWN',
      matchScore: 0,
      confidence: 0,
      citationIds: [],
      limitations: [],
      reviewRequired: true,
    })),
    architecture,
    evidence: normalizedEvidence,
    confidenceSummary: undefined as ConfidenceSummary | undefined,
    review,
    ...(executionTrace ? { executionTrace } : {}),
  }
  const { quality, confidenceSummary } = qualityFor(base)
  const now = new Date().toISOString()
  return {
    ...base,
    id: `SD-${ulid()}`,
    conversationId,
    sourceRunId,
    currentVersion: 1,
    status: quality.status,
    quality,
    confidenceSummary,
    createdAt: now,
    updatedAt: now,
    versions: [{ version: 1, payload: { ...base, quality, status: quality.status }, createdAt: now }],
  }
}

function assetForKnowledge(snapshot: PlatformSnapshot, knowledgeId: string) {
  const knowledge = snapshot.knowledge.find((item) => item.id === knowledgeId)
  if (!knowledge) return undefined
  const asset = snapshot.assets.find((item) => item.id === knowledge.primaryAssetId)
  if (!asset) return undefined
  return { knowledge, asset }
}

export function createLocalSolutionDraft(
  snapshot: PlatformSnapshot,
  conversationId: string,
  request: string,
  attachmentIds: string[],
  sourceRunId: string,
  executionTrace?: SolutionDraft['executionTrace'],
  requiresClarification = true,
): SolutionDraft {
  const now = new Date().toISOString()
  const knowledge = snapshot.knowledge
    .filter((item) => item.status === 'ACTIVE' && item.aiEnabled && item.indexStatus === 'INDEXED')
    .map((item) => ({ item, score: score(request, `${item.title}\n${item.content}`) }))
    .filter(({ score: itemScore }) => itemScore > 0)
    .sort((left, right) => right.score - left.score || right.item.updatedAt.localeCompare(left.item.updatedAt))
    .slice(0, 6)
  const citations = knowledge.flatMap(({ item }) => {
    const source = assetForKnowledge(snapshot, item.id)
    if (!source) return []
    return [{
      id: citationId(item.id, source.asset.id, item.sourceLocator),
      title: item.title,
      locator: item.sourceLocator,
      excerpt: item.content,
      ...(source.asset.sourceUrl ? { sourceUrl: source.asset.sourceUrl } : {}),
    }]
  })
  const selectedAssets = new Set(knowledge.map(({ item }) => item.primaryAssetId))
  for (const attachmentId of attachmentIds) {
    const asset = snapshot.assets.find((item) => item.id === attachmentId && item.ownerId === snapshot.session.userId && item.isSessionAsset)
    if (asset?.sections[0]) {
      citations.push({ id: `DRAFT-ASSET-${asset.id}`, title: asset.title, locator: asset.sections[0].locator, excerpt: asset.sections[0].excerpt })
      selectedAssets.add(asset.id)
    }
  }
  const conflicts = (snapshot.crossDocumentRelations ?? [])
    .filter((relation) => relation.relationType === 'CONFLICT' && relation.status !== 'RESOLVED'
      && selectedAssets.has(relation.leftAssetId) && selectedAssets.has(relation.rightAssetId))
    .map((relation) => {
      const leftCitationId = citations.find((citation) => decodeCitation(citation.id)?.assetId === relation.leftAssetId)?.id
      const rightCitationId = citations.find((citation) => decodeCitation(citation.id)?.assetId === relation.rightAssetId)?.id
      const citationIds = [leftCitationId, rightCitationId].filter((id): id is string => Boolean(id))
      return {
        claim: relation.sharedContent || relation.diffContent || '跨文档内容存在冲突',
        alternatives: [
          { statement: relation.leftExcerpt, applicability: {}, citationIds: leftCitationId ? [leftCitationId] : [] },
          { statement: relation.rightExcerpt, applicability: {}, citationIds: rightCitationId ? [rightCitationId] : [] },
        ],
        applicability: relation.scopeDiffs.join('，'),
        citationIds,
        status: 'UNRESOLVED' as const,
      }
    })
  const primaryCitation = citations[0]
  const requirements: DraftRequirement[] = [{
    id: 'REQ-1',
    text: request,
    source: primaryCitation ? `引用 ${primaryCitation.id}` : '待确认',
  }]
  // The local compatibility path does not have access to Yuxi's governed
  // capability catalog. Make that boundary explicit instead of implying that
  // a similarly named document proves an enterprise capability exists.
  const capabilityIndex = buildCapabilityIndex(snapshot)
  const capabilityMatches: CapabilityMatch[] = requirements.map((requirement) => {
    const match = capabilityIndex
      .map((capability) => ({ capability, score: score(requirement.text, `${capability.name}\n${capability.description}`) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.capability
    return match ? {
      requirementId: requirement.id,
      capabilityId: match.id,
      capabilityName: match.name,
      deliveryStatus: match.deliveryStatus,
      matchType: ['PRODUCTIZED', 'DELIVERED'].includes(match.deliveryStatus) ? 'EXISTING' : 'UNKNOWN',
      matchScore: Math.min(1, score(requirement.text, `${match.name}\n${match.description}`) / Math.max(1, tokens(requirement.text).length)),
      confidence: match.confidence,
      citationIds: match.citationIds,
      limitations: ['需结合客户范围和版本进一步确认'],
      reviewRequired: true,
    } : {
      requirementId: requirement.id,
      capabilityId: '',
      capabilityName: '企业能力目录未匹配到结果',
      deliveryStatus: 'UNKNOWN',
      matchType: 'UNKNOWN',
      matchScore: 0,
      confidence: 0,
      citationIds: [],
      limitations: ['需要补充能力边界或新增研发评估'],
      reviewRequired: true,
    }
  })
  const evidence: DraftEvidenceItem[] = citations.map((citation, index) => ({
    id: `EVD-${index + 1}`,
    sourceType: 'ENTERPRISE_FORMAL',
    title: citation.title,
    locator: citation.locator,
    excerpt: citation.excerpt,
    confidence: 0.8,
    citationId: citation.id,
  }))
  const sections = requiredSections.map((title, index) => ({
    id: `SECTION-${index + 1}`,
    title,
    contentMarkdown: index === 0
      ? (citations.length ? '基于当前需求和正式资料形成的方案草稿，待确认客户范围后完善。' : '当前没有检索到可用的正式资料。')
      : index === 1 ? `客户需求：${request}`
        : index === 2 ? '请结合已确认需求选择产品能力、部署方式和交付边界。'
          : index === 3 ? '建议按需求确认、方案评审、实施验证和交付复盘分阶段推进。'
            : '请确认适用范围、版本、生效时间和未解决的资料冲突。',
    requirementIds: index === 1 ? ['REQ-1'] : [],
    citationIds: primaryCitation ? [primaryCitation.id] : [],
  }))
  // A local draft can still have unresolved design dimensions after a
  // successful knowledge lookup.  Citations tell us that we found evidence;
  // they do not tell us that the customer has confirmed deployment, audience,
  // or scope.  Derive the compatibility question from the request first and
  // only use the generic evidence question when no deterministic dimension is
  // available.  This keeps the interactive card visible for requests such as
  // “宠物用品微信小程序” even when the product search returned citations.
  const deterministicClarification = requiresClarification
    ? clarificationQuestionForRequest(request)
    : undefined
  const localOpenQuestions = deterministicClarification
    ? [deterministicClarification.question]
    : citations.length
      ? []
      : ['请补充客户行业、产品版本和部署方式']
  const localClarificationQuestions = (() => {
    if (!requiresClarification) return []
    // Keep the deterministic compatibility question when it is genuinely
    // missing from the request.  If that dimension is already explicit,
    // expose the remaining semantic open question(s) instead of leaving the
    // user with a blocked card that has no way to continue.
    const candidates = deterministicClarification
      ? [deterministicClarification]
      : clarificationQuestionsFromOpenQuestions(localOpenQuestions)
    return dedupeClarificationQuestions(filterAnsweredClarificationQuestions(candidates, request))
  })()
  const base = {
    title: `${request.slice(0, 48) || '方案'}方案草稿`,
    customerContext: request,
    executiveSummary: citations.length ? '已从正式企业知识中找到相关证据，以下内容可继续编辑确认。' : '未找到足够可靠的正式资料，当前仅生成待补充草稿。',
    requirements,
    sections,
    assumptions: citations.length ? [] : ['客户场景、预算和交付边界尚未明确'],
    openQuestions: localOpenQuestions,
    clarificationQuestions: localClarificationQuestions,
    risks: conflicts.length ? ['跨文档存在未解决冲突，不能直接形成确定结论'] : [],
    conflicts,
    evidenceGaps: citations.length ? [] : ['没有匹配到已发布、已索引且有权限的正式知识'],
    citations,
    capabilityMatches,
    architecture: {
      summary: '待结合已确认需求和企业能力匹配结果完善总体架构',
      layers: ['数据与集成层', '能力与服务层', '业务应用层', '交付与运营层'],
    },
    evidence,
    review: {
      status: 'REQUIRED',
      pendingItems: ['请售前或架构师确认企业能力覆盖范围'],
      requiredRoles: ['售前', '方案架构师'],
      decisions: [],
    },
    executionTrace: executionTrace ?? {
      status: 'COMPLETED',
      startedAt: now,
      finishedAt: now,
      elapsedMs: 0,
      // This is only the local compatibility result. Keep its trace honest:
      // detailed stages are emitted by the Yuxi Agent stream, not inferred
      // from the shape of the generated fallback sections.
      steps: [{
        stage: 'COMPOSING',
        label: '生成方案草稿',
        message: '本地兼容模式生成方案草稿',
        status: 'COMPLETED',
        startedAt: now,
        finishedAt: now,
        elapsedMs: 0,
      }],
    },
  }
  const { quality, confidenceSummary } = qualityFor(base)
  return {
    ...base,
    id: `SD-${ulid()}`,
    conversationId,
    sourceRunId,
    currentVersion: 1,
    status: quality.status,
    quality,
    confidenceSummary,
    createdAt: now,
    updatedAt: now,
    versions: [{ version: 1, payload: { ...base, quality, confidenceSummary, status: quality.status }, createdAt: now }],
  }
}

export function editLocalSolutionDraft(draft: SolutionDraft, patch: SolutionDraftEditRequest): SolutionDraft {
  const nextPayload = { ...draft, ...patch }
  const {
    quality: _quality,
    status: _status,
    id: _id,
    conversationId: _conversationId,
    sourceRunId: _sourceRunId,
    currentVersion: _version,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    versions: _versions,
    ...base
  } = nextPayload
  const { quality, confidenceSummary } = qualityFor(base)
  const now = new Date().toISOString()
  const currentVersion = draft.currentVersion + 1
  const next = {
    ...draft,
    ...patch,
    quality,
    confidenceSummary,
    status: quality.status,
    currentVersion,
    versionSource: 'HUMAN_EDIT' as const,
    baseVersionId: `${draft.id}:v${draft.currentVersion}`,
    updatedAt: now,
  }
  return {
    ...next,
    versions: [
      ...(draft.versions ?? [{
        version: draft.currentVersion,
        payload: {
          title: draft.title,
          customerContext: draft.customerContext,
          executiveSummary: draft.executiveSummary,
          requirements: draft.requirements,
          sections: draft.sections,
          assumptions: draft.assumptions,
          openQuestions: draft.openQuestions,
          risks: draft.risks,
          conflicts: draft.conflicts,
          evidenceGaps: draft.evidenceGaps,
          citations: draft.citations,
          customer: draft.customer,
          capabilityMatches: draft.capabilityMatches,
          architecture: draft.architecture,
          evidence: draft.evidence,
          confidenceSummary: draft.confidenceSummary,
          review: draft.review,
          quality: draft.quality,
          status: draft.status,
        },
        createdAt: draft.createdAt,
      }]),
      {
        version: currentVersion,
        payload: { ...base, quality, confidenceSummary, status: quality.status },
        createdAt: now,
        source: 'HUMAN_EDIT',
        baseVersionId: `${draft.id}:v${draft.currentVersion}`,
      },
    ],
  }
}

export function confirmSolutionDraft(draft: SolutionDraft): SolutionDraft {
  if (draft.status === 'BLOCKED') throw new Error('SOLUTION_DRAFT_NOT_READY')
  if (draft.status === 'CONFIRMED') return structuredClone(draft)
  const now = new Date().toISOString()
  const currentVersion = draft.currentVersion + 1
  const payload = {
    title: draft.title,
    customer: draft.customer,
    customerContext: draft.customerContext,
    executiveSummary: draft.executiveSummary,
    requirements: draft.requirements,
    sections: draft.sections,
    assumptions: draft.assumptions,
    openQuestions: draft.openQuestions,
    clarificationQuestions: draft.clarificationQuestions,
    risks: draft.risks,
    conflicts: draft.conflicts,
    evidenceGaps: draft.evidenceGaps,
    citations: draft.citations,
    capabilityMatches: draft.capabilityMatches,
    architecture: draft.architecture,
    evidence: draft.evidence,
    confidenceSummary: draft.confidenceSummary,
    review: { ...(draft.review ?? { status: 'NOT_REQUIRED', pendingItems: [], requiredRoles: [], decisions: [] }), status: 'CONFIRMED', pendingItems: [] },
    quality: { ...draft.quality, status: 'CONFIRMED' as const },
    status: 'CONFIRMED' as const,
  }
  return {
    ...draft,
    status: 'CONFIRMED',
    quality: { ...draft.quality, status: 'CONFIRMED' },
    review: payload.review,
    versionSource: 'CONFIRMED',
    baseVersionId: `${draft.id}:v${draft.currentVersion}`,
    confirmedAt: now,
    currentVersion,
    updatedAt: now,
    versions: [
      ...(draft.versions ?? []),
      { version: currentVersion, payload, createdAt: now, source: 'CONFIRMED', baseVersionId: `${draft.id}:v${draft.currentVersion}` },
    ],
  }
}

export function renderLocalSolutionDraft(draft: SolutionDraft) {
  return [`## ${draft.title}`, '', draft.executiveSummary, ...draft.sections.flatMap((section) => ['', `### ${section.title}`, section.contentMarkdown]), '', `> 草稿状态：${draft.status}`].join('\n').trim()
}
