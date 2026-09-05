import { ulid } from 'ulid'

import type {
  CapabilityMatch,
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
  const sections: DraftSection[] = readArray(raw, 'sections').flatMap((item, index) => {
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
  const requirements: DraftRequirement[] = readArray(raw, 'requirements').flatMap((item, index) => {
    if (typeof item === 'string' && item.trim()) return [{ id: `REQ-${index + 1}`, text: item }]
    const record = asRecord(item)
    if (!record || !stringValue(readField(record, 'text')).trim()) return []
    const source = readField(record, 'source')
    return [{ id: stringValue(readField(record, 'id'), `REQ-${index + 1}`), text: stringValue(readField(record, 'text')), ...(typeof source === 'string' ? { source } : {}) }]
  })
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
    const section = sections.find((item) => item.title.includes('架构'))
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
  const base = {
    title: stringValue(readField(raw, 'title'), '方案草稿'),
    customer: stringValue(readField(raw, 'customer')),
    customerContext: stringValue(readField(raw, 'customerContext', 'customer_context')),
    executiveSummary: stringValue(readField(raw, 'executiveSummary', 'executive_summary')),
    requirements,
    sections,
    assumptions: stringList(readField(raw, 'assumptions')),
    openQuestions: stringList(readField(raw, 'openQuestions', 'open_questions')),
    risks: riskList(readField(raw, 'risks')),
    conflicts,
    evidenceGaps: stringList(readField(raw, 'evidenceGaps', 'evidence_gaps')),
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
  const capabilityMatches: CapabilityMatch[] = [{
    requirementId: 'REQ-1',
    capabilityId: '',
    capabilityName: '待从企业能力目录确认',
    deliveryStatus: 'UNKNOWN',
    matchType: 'UNKNOWN',
    matchScore: 0,
    confidence: 0,
    citationIds: [],
    limitations: ['当前运行模式未连接企业能力目录'],
    reviewRequired: true,
  }]
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
  const base = {
    title: `${request.slice(0, 48) || '方案'}方案草稿`,
    customerContext: request,
    executiveSummary: citations.length ? '已从正式企业知识中找到相关证据，以下内容可继续编辑确认。' : '未找到足够可靠的正式资料，当前仅生成待补充草稿。',
    requirements,
    sections,
    assumptions: citations.length ? [] : ['客户场景、预算和交付边界尚未明确'],
    openQuestions: citations.length ? [] : ['请补充客户行业、产品版本和部署方式'],
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
    executionTrace: {
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
  const next = { ...draft, ...patch, quality, confidenceSummary, status: quality.status, currentVersion, updatedAt: now }
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
      },
    ],
  }
}

export function renderLocalSolutionDraft(draft: SolutionDraft) {
  return [`## ${draft.title}`, '', draft.executiveSummary, ...draft.sections.flatMap((section) => ['', `### ${section.title}`, section.contentMarkdown]), '', `> 草稿状态：${draft.status}`].join('\n').trim()
}
