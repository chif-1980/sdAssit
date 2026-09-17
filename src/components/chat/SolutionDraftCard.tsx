import { AlertTriangle, CheckCircle2, CircleAlert, Clock3, FileCheck2, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { ProductAgentInterrupt, SolutionDraft, SolutionDraftEditRequest } from '../../../shared/api/product.js'
import type { ClarificationQuestion, DraftRequirement } from '../../../shared/domain/models.js'
import { mermaidMarkdownComponents } from './MermaidBlock'
import { ClarificationCard, enrichClarificationQuestion, type ClarificationAnswer } from './ClarificationCard'

interface SolutionDraftCardProps {
  draft: SolutionDraft
  onSave?: (patch: SolutionDraftEditRequest) => Promise<void>
  onConfirm?: () => Promise<void>
  onClarificationAnswer?: (answer: ClarificationAnswer, action: 'answer' | 'skip') => void
  clarificationDisabled?: boolean
  /** Hide stale draft questions while the live interrupt is rendered below. */
  hideClarificationQuestions?: boolean
}

const statusLabels: Record<SolutionDraft['status'], string> = {
  GENERATING: '生成中',
  READY: '待确认',
  NEEDS_REVIEW: '需要复核',
  BLOCKED: '证据不足，暂不可确认',
  CONFIRMED: '已确认正式方案',
  SUPERSEDED: '已有新版本',
}

const capabilityLabels: Record<string, string> = {
  EXISTING: '企业已有能力',
  CUSTOM: '可定制',
  CUSTOMIZABLE: '可定制',
  R_AND_D: '研发储备',
  UNKNOWN: '待确认',
}

const evidenceLabels: Record<string, string> = {
  ENTERPRISE_FORMAL: '企业正式资料',
  PROJECT_CASE: '项目案例',
  INDUSTRY_REFERENCE: '行业参考',
  INNOVATION_HYPOTHESIS: '创新假设',
}

function percent(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0%'
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

function capabilityLabel(matchType: string, deliveryStatus: string) {
  const normalizedType = matchType.toUpperCase()
  const normalizedDelivery = deliveryStatus.toUpperCase()
  return capabilityLabels[normalizedType]
    ?? (['PRODUCTIZED', 'DELIVERED'].includes(normalizedDelivery) ? '企业已有能力' : '待确认')
}

const executionStatusLabels: Record<string, string> = {
  ACTIVE: '进行中',
  COMPLETED: '已完成',
  FAILED: '失败',
  INTERRUPTED: '已暂停',
}

const executionStageLabels: Record<string, string> = {
  UNDERSTANDING: '理解问题',
  REQUIREMENTS_ANALYSIS: '拆解需求',
  CAPABILITY_MATCHING: '匹配企业能力',
  RETRIEVING: '检索资料',
  ARCHITECTURE_DESIGN: '设计方案架构',
  VERIFYING: '核对高风险事实',
  EVIDENCE_CHECK: '检查证据覆盖',
  QUALITY_REVIEW: '质量审核',
  COMPOSING: '整理方案草稿',
  WAITING_FOR_INPUT: '等待补充信息',
}

const fallbackSectionTitles = ['执行摘要', '需求与范围', '方案设计', '实施计划', '风险与待确认']

/**
 * Older product projections persisted unresolved dimensions only in
 * `openQuestions`.  Keep the card backwards compatible by turning those
 * plain strings into the same interactive question shape used by current
 * Agent runs.  This is deliberately a display-only fallback; the server
 * remains responsible for validating the answer before resuming a run.
 */
export function clarificationQuestionsForDraft(draft: SolutionDraft): ClarificationQuestion[] {
  const explicit = draft.clarificationQuestions?.length
    ? draft.clarificationQuestions
    : (draft.openQuestions ?? []).flatMap((value, index) => {
      const text = typeof value === 'string'
        ? value.trim()
        : value && typeof value === 'object' && typeof (value as { question?: unknown }).question === 'string'
          ? String((value as { question: string }).question).trim()
          : ''
      return text
        ? [{
          id: `OPEN_QUESTION_${index + 1}`,
          question: text,
          type: 'TEXT' as const,
          options: [],
          required: true,
          allowSkip: true,
          position: index + 1,
          total: draft.openQuestions.length,
        }]
        : []
    })
  // A few early projections persisted the useful requirement analysis but
  // dropped both `openQuestions` and `clarificationQuestions`.  Recover a
  // deterministic choice batch on the client so those historical drafts do
  // not dead-end.  Newer payloads always win; this path is only used when both
  // explicit fields are absent.
  const candidates = explicit.length ? explicit : clarificationQuestionsFromRequirements(draft)
  return candidates
    .map((question) => enrichClarificationQuestion(question))
    .filter((question, index, questions) => questions.findIndex((candidate) => (
      candidate.id === question.id || candidate.question.trim() === question.question.trim()
    )) === index)
}

const unresolvedRequirementPattern = /待确认|待补充|需要确认|尚未(?:明确|确定)|未(?:明确|确定)|建议纳入(?:首期)?范围|建议(?:纳入|考虑)|(?:产品|能力|范围)推断/iu
const scopeRequirementPattern = /首期|范围|功能模块|用户端|管理端|建议纳入/iu
const productFormPattern = /(?:是否|明确|确认|确定|要不要|需不需要|采用|建设).{0,28}(?:微信小程序|小程序|移动端|Web端|网页端|APP|App)/iu

function requirementRecordText(requirement: DraftRequirement) {
  return `${requirement.source ?? ''} ${requirement.text}`.replace(/\s+/gu, ' ').trim()
}

function hasExplicitProductForm(text: string) {
  // The original request/customer context is often copied into
  // `customerContext`; a non-question mention there is enough to consider a
  // product-form question answered.  Do not count the unresolved requirement
  // itself as evidence.
  return /(?:建设|采用|使用|开发|上线|基于).{0,24}(?:微信小程序|小程序|移动端|Web端|网页端|APP|App)/iu.test(text)
    || /(?:微信小程序|小程序|移动端|Web端|网页端|APP|App).{0,24}(?:商城|用户端|客户端|入口)/iu.test(text)
}

function scopeLabels(requirements: readonly DraftRequirement[]) {
  return [...new Set(requirements.flatMap((requirement) => {
    const cleaned = requirement.text
      .replace(/^\s*(?:建议|推荐)?纳入首期范围\s*[:：]?\s*/iu, '')
      .replace(/^\s*(?:首期范围|范围)\s*[:：]?\s*/iu, '')
      .trim()
    if (!cleaned) return []
    // Preserve explicit bullets/clauses, but do not attempt to split an
    // arbitrary sentence where the model did not provide a boundary.
    const parts = cleaned.split(/\n+|[；;]+/u).map((item) => item.trim()).filter(Boolean)
    return parts.length ? parts : [cleaned]
  }))]
}

function requirementQuestion(requirement: DraftRequirement, index: number): ClarificationQuestion {
  const text = requirement.text.trim()
  const id = requirement.id.trim() || `REQUIREMENT_${index + 1}`
  if (/(?:微信小程序|小程序|移动端|Web端|网页端|APP|App)/iu.test(text)) {
    return {
      id,
      question: /[？?]$/u.test(text) ? text : `请确认：${text}`,
      type: 'SINGLE_CHOICE',
      options: [
        { id: 'ADOPT', label: '采用该产品形态' },
        { id: 'NOT_ADOPT', label: '暂不采用该产品形态' },
        { id: 'OTHER', label: '其他（请说明）' },
      ],
      required: true,
      allowSkip: true,
      position: index + 1,
      total: 1,
    }
  }
  const enriched = enrichClarificationQuestion({
    id,
    question: /[？?]$/u.test(text) ? text : `请确认：${text}`,
    type: 'TEXT' as const,
    options: [],
    required: true,
    allowSkip: true,
    position: index + 1,
    total: 1,
  }) as ClarificationQuestion
  // `enrichClarificationQuestion` has useful canonical choices for known
  // dimensions (deployment, operation mode, etc.).  For an unknown legacy
  // requirement keep a real text field instead of presenting vague,
  // overlapping “已有候选/其他” choices.
  const generic = new Set(['已确定', '已有候选，尚未最终确认', '尚未确定', '其他（请说明）'])
  if (enriched.options.length && enriched.options.some((option) => !generic.has(option.label))) return enriched
  return {
    id,
    question: /[？?]$/u.test(text) ? text : `请确认：${text}`,
    type: 'TEXT',
    options: [],
    required: true,
    allowSkip: true,
    position: index + 1,
    total: 1,
  }
}

function clarificationQuestionsFromRequirements(draft: SolutionDraft): ClarificationQuestion[] {
  const requirements = Array.isArray(draft.requirements) ? draft.requirements : []
  const unresolved = requirements.filter((requirement) => unresolvedRequirementPattern.test(requirementRecordText(requirement)))
  if (!unresolved.length) return []

  const nonPendingText = [draft.title, draft.customerContext, ...requirements
    .filter((requirement) => !unresolved.includes(requirement))
    .map((requirement) => requirement.text)].join(' ')
  const pending = unresolved.filter((requirement) => {
    const text = requirementRecordText(requirement)
    // Do not ask again whether to use a product form that the original
    // request already states explicitly (for example, “建设微信小程序”).
    return !(productFormPattern.test(text) && hasExplicitProductForm(nonPendingText))
  })
  if (!pending.length) return []

  const scope = pending.filter((requirement) => !productFormPattern.test(requirement.text) && scopeRequirementPattern.test(requirementRecordText(requirement)))
  const other = pending.filter((requirement) => !scope.includes(requirement))
  const questions: ClarificationQuestion[] = []
  if (scope.length) {
    const labels = scopeLabels(scope)
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
  other.forEach((requirement, index) => questions.push(requirementQuestion(requirement, index)))
  return questions.map((question, index, all) => ({ ...question, position: index + 1, total: all.length }))
}

function questionText(value: unknown) {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && typeof (value as { question?: unknown }).question === 'string') {
    return String((value as { question: string }).question).trim()
  }
  return ''
}

function questionKey(value: string) {
  return value
    .replace(/\s+/gu, ' ')
    .replace(/[？?。．。]+$/gu, '')
    .trim()
    .toLocaleLowerCase()
}

function fallbackSectionContent(title: string, request: string) {
  if (title === '执行摘要') return '当前证据不足，先保留可编辑的方案骨架；完成待确认问题后再生成正式结论。'
  if (title === '需求与范围') return `客户需求：${request}\n\n待确认客户行业、目标、范围和交付物。`
  if (title === '方案设计') return '待根据已确认需求匹配企业能力，并补充总体架构、功能模块与能力边界。'
  if (title === '实施计划') return '待确认范围后，按需求确认、方案评审、实施验证和交付复盘分阶段推进。'
  return '待确认适用范围、版本、生效时间及未解决的资料冲突。'
}

function elapsedLabel(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '—'
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

type ArchitectureLayer = { name: string; components: string[] }

function architectureView(draft: SolutionDraft) {
  const raw = draft.architecture && typeof draft.architecture === 'object' ? draft.architecture : {}
  const overviewValue = raw.overview ?? raw.summary
  const overview = typeof overviewValue === 'string' ? overviewValue : ''
  const layers: ArchitectureLayer[] = Array.isArray(raw.layers)
    ? raw.layers.flatMap((layer, index) => {
      if (typeof layer === 'string' && layer.trim()) return [{ name: layer.trim(), components: [] }]
      if (!layer || typeof layer !== 'object') return []
      const record = layer as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name.trim() : `架构层 ${index + 1}`
      const components = Array.isArray(record.components)
        ? record.components.flatMap((component) => {
          if (typeof component === 'string' && component.trim()) return [component.trim()]
          if (component && typeof component === 'object' && typeof (component as Record<string, unknown>).name === 'string') {
            return [String((component as Record<string, unknown>).name)]
          }
          return []
        })
        : []
      return [{ name, components }]
    })
    : []
  if (overview || layers.length) return { overview, layers }
  const section = draft.sections.find((item) => item.title.includes('架构'))
  return section ? { overview: section.contentMarkdown, layers: [] } : undefined
}

export function SolutionDraftCard({ draft, onSave, onConfirm, onClarificationAnswer, clarificationDisabled = false, hideClarificationQuestions = false }: SolutionDraftCardProps) {
  const sparseBlocked = draft.status === 'BLOCKED'
    && (draft.sections.length < fallbackSectionTitles.length || draft.sections.some((section) => !section.contentMarkdown.trim()))
  const request = draft.customerContext?.trim() || '待补充客户需求与交付目标'
  const displayRequirements = draft.requirements.length
    ? draft.requirements
    : sparseBlocked && !draft.clarificationQuestionsResolved
      ? [{ id: 'REQ-1', text: request, source: '待确认' }]
      : []
  const displaySections = sparseBlocked
    ? fallbackSectionTitles.map((title, index) => ({
      id: `fallback-${index + 1}`,
      title,
      contentMarkdown: fallbackSectionContent(title, request),
      requirementIds: title === '需求与范围' ? ['REQ-1'] : [],
      citationIds: [],
    }))
    : draft.sections
  const draftClarificationQuestions = !draft.clarificationQuestionsResolved
    ? clarificationQuestionsForDraft(draft)
      .map((question, index, questions) => ({ ...question, position: index + 1, total: questions.length }))
    : []
  const displayClarificationQuestions = hideClarificationQuestions ? [] : draftClarificationQuestions
  // A legacy projection can contain the same unresolved item in both
  // `openQuestions` and `clarificationQuestions`.  Keep it in the interactive
  // card only; showing it again under “待补充” is confusing and makes the
  // user answer the same question twice.
  const interactiveQuestionKeys = new Set(draftClarificationQuestions.map((question) => questionKey(question.question)))
  const remainingOpenQuestions = (Array.isArray(draft.openQuestions) ? draft.openQuestions : [])
    .map((item) => questionText(item))
    .filter((item) => item && !interactiveQuestionKeys.has(questionKey(item)))
  const fallbackSummary = sparseBlocked
    ? '当前证据不足，已生成可继续确认和编辑的方案骨架。'
    : draft.quality?.notes?.[0]
    || draft.evidenceGaps?.[0]
    || (draft.sourceRunId ? `方案结果未形成结构化草稿，请重试。运行编号：${draft.sourceRunId}` : '方案结果未形成结构化草稿，请重试。')
  const initialSummary = draft.executiveSummary?.trim() || fallbackSummary
  const [summary, setSummary] = useState(initialSummary)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => setSummary(draft.executiveSummary?.trim() || fallbackSummary), [draft.executiveSummary, draft.currentVersion, fallbackSummary])

  async function save() {
    if (!onSave || summary === (draft.executiveSummary?.trim() || fallbackSummary)) return
    setSaving(true)
    setSaved(false)
    try {
      await onSave({ executiveSummary: summary })
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  async function confirm() {
    if (!onConfirm || draft.status === 'BLOCKED' || draft.status === 'CONFIRMED') return
    setConfirming(true)
    try {
      await onConfirm()
    } finally {
      setConfirming(false)
    }
  }

  const StatusIcon = draft.status === 'READY' || draft.status === 'CONFIRMED' ? CheckCircle2 : draft.status === 'BLOCKED' ? CircleAlert : AlertTriangle
  const architecture = architectureView(draft)
  const blockedReason = draft.evidenceGaps?.[0] || draft.quality?.notes?.[0] || 'Agent 未返回完整结构化方案。'
  const firstClarification = displayClarificationQuestions[0]
  const clarificationInterrupt: ProductAgentInterrupt | undefined = firstClarification
    ? {
      ...firstClarification,
      questions: displayClarificationQuestions,
      runId: draft.sourceRunId,
      status: 'INTERRUPTED',
    }
    : undefined
  return (
    <section className={`solution-draft-card solution-draft-${draft.status.toLowerCase()}`} aria-label="方案草稿">
      <header className="solution-draft-header">
        <div>
          <span className="solution-draft-eyebrow">方案草稿 · v{draft.currentVersion}</span>
          <h3>{draft.title}</h3>
        </div>
        <span className="solution-draft-status"><StatusIcon aria-hidden="true" size={15} />{statusLabels[draft.status]}</span>
      </header>
      {draft.executionTrace?.steps.length ? (
        <div role="status" aria-label="执行过程">
        <details className="solution-draft-trace">
          <summary>
            <span>执行过程</span>
            <small>{draft.executionTrace.steps.length} 个阶段 · {elapsedLabel(draft.executionTrace.elapsedMs)}</small>
          </summary>
          <ol className="solution-draft-trace-list">
            {draft.executionTrace.steps.map((step, index) => (
              <li key={`${step.stage}-${index}`} className={`solution-draft-trace-step is-${step.status.toLowerCase()}`}>
                <span className="solution-draft-trace-marker" aria-hidden="true">{index + 1}</span>
                <div>
                  <div className="solution-draft-trace-heading">
                    <strong>{executionStageLabels[step.stage] ?? step.label ?? step.stage}</strong>
                    <span>{executionStatusLabels[step.status] ?? step.status}</span>
                  </div>
                  <p>{step.message}</p>
                  <small><Clock3 aria-hidden="true" size={12} />{elapsedLabel(step.elapsedMs)}</small>
                </div>
              </li>
            ))}
          </ol>
        </details>
        </div>
      ) : null}
      <label className="solution-draft-summary">
        <span>执行摘要</span>
        <textarea value={summary} rows={3} disabled={!onSave || saving} onChange={(event) => setSummary(event.target.value)} />
      </label>
      {draft.status === 'BLOCKED' ? (
        <div className="solution-draft-callout solution-draft-blocked-diagnostic" role="status" aria-live="polite">
          <strong>证据不足，以下内容是可继续确认的方案骨架</strong>
          <p>{blockedReason}</p>
          {draft.sourceRunId ? <small>运行编号：{draft.sourceRunId}</small> : null}
          <p>{displayClarificationQuestions.length && onClarificationAnswer && draft.sourceRunId
            ? '已确认的内容会保留；请先完成待确认问题，再继续生成正式方案。'
            : displayClarificationQuestions.length
              ? '该方案运行已失效，暂时无法提交待确认内容。请重新生成方案后继续。'
            : '当前运行没有返回可交互的待确认问题。请重试生成，或编辑方案骨架补充信息后再继续。'}</p>
        </div>
      ) : null}
      {displayRequirements.length ? (
        <div className="solution-draft-requirements">
          <h4>需求清单</h4>
          <ul>
            {displayRequirements.map((requirement) => (
              <li key={requirement.id}>
                <span>{requirement.text}</span>
                {requirement.source ? <small>{requirement.source}</small> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {draft.confidenceSummary ? (
        <div className="solution-draft-confidence" aria-label="方案可信度摘要">
          <div><span>企业能力覆盖</span><strong>{percent(draft.confidenceSummary.enterpriseCoverage)}</strong></div>
          <div><span>证据覆盖</span><strong>{percent(draft.confidenceSummary.evidenceCoverage)}</strong></div>
          <div><span>行业参考占比</span><strong>{percent(draft.confidenceSummary.industryReferenceRatio)}</strong></div>
          <div><span>创新探索占比</span><strong>{percent(draft.confidenceSummary.innovationRatio)}</strong></div>
          {draft.confidenceSummary.notes.map((note) => <small key={note}>{note}</small>)}
        </div>
      ) : null}
      {draft.capabilityMatches?.length ? (
        <div className="solution-draft-capabilities">
          <h4>企业能力匹配</h4>
          <div className="solution-draft-capability-list">
            {draft.capabilityMatches.map((match, index) => (
              <div className="solution-draft-capability" key={`${match.requirementId}-${match.capabilityId || index}`}>
                <div>
                  <strong>{match.capabilityName || '未命名能力'}</strong>
                  <span>{capabilityLabel(match.matchType, match.deliveryStatus)}</span>
                </div>
                {match.limitations.length ? <small>{match.limitations.join('；')}</small> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {architecture ? (
        <div className="solution-draft-architecture">
          <h4>方案架构骨架</h4>
          {architecture.overview.trim() ? (
            <div className="solution-draft-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mermaidMarkdownComponents}>{architecture.overview}</ReactMarkdown>
            </div>
          ) : null}
          {architecture.layers.length ? (
            <div className="solution-draft-architecture-layers">
              {architecture.layers.map((layer) => <span key={layer.name}>{layer.components.length ? `${layer.name}：${layer.components.join('、')}` : layer.name}</span>)}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="solution-draft-sections">
        {displaySections.map((section) => (
          <article key={section.id}>
            <h4>{section.title}</h4>
            <div className="solution-draft-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mermaidMarkdownComponents}>{section.contentMarkdown}</ReactMarkdown>
            </div>
            {section.citationIds.length ? <small>引用 {section.citationIds.map((id) => draft.citations.findIndex((citation) => citation.id === id) + 1).filter((index) => index > 0).map((index) => `[${index}]`).join(' ')}</small> : null}
          </article>
        ))}
      </div>
      {/* When interactive clarification is available, its questions are the
          single source of truth for unresolved items. Repeating the same
          content in risk/gap callouts creates noise and suggests two flows. */}
      {!displayClarificationQuestions.length && draft.risks.length ? (
        <div className="solution-draft-callout solution-draft-risks"><strong>能力边界与风险</strong>{draft.risks.map((risk) => <p key={risk}>{risk}</p>)}</div>
      ) : null}
      {draft.conflicts.length ? (
        <div className="solution-draft-callout solution-draft-conflicts"><strong>需要人工确认的冲突</strong>{draft.conflicts.map((conflict) => <div key={conflict.claim}><p>{conflict.claim}：{conflict.alternatives.map((item) => item.statement).join(' / ')}</p>{conflict.applicability ? <small>适用范围：{conflict.applicability}</small> : null}</div>)}</div>
      ) : null}
      {!displayClarificationQuestions.length && (remainingOpenQuestions.length || draft.evidenceGaps.length) ? (
        <div className="solution-draft-callout">
          <strong>待补充</strong>
          <p className="solution-draft-callout-hint">以下是当前资料中缺失的信息，仅作提醒；不会阻塞方案继续生成。</p>
          {[...remainingOpenQuestions, ...draft.evidenceGaps].map((item, index) => <p key={`${item}-${index}`}>{item}</p>)}
        </div>
      ) : null}
      {draft.review?.status === 'REQUIRED' && draft.review.pendingItems.length ? (
        <div className="solution-draft-callout solution-draft-review"><strong>人工审核节点</strong><span>{draft.review.requiredRoles.length ? `请由${draft.review.requiredRoles.join('、')}确认` : '请完成方案复核'}</span>{draft.review.pendingItems.map((item) => <p key={item}>{item}</p>)}</div>
      ) : null}
      {displayClarificationQuestions.length ? (
        <div className="solution-draft-callout solution-draft-review">
          <strong>待确认问题</strong>
          {displayClarificationQuestions.map((question) => <p key={question.id}>{question.position}. {question.question}</p>)}
          {clarificationInterrupt && onClarificationAnswer ? (
            <ClarificationCard
              interrupt={clarificationInterrupt}
              disabled={clarificationDisabled}
              onSubmit={onClarificationAnswer}
            />
          ) : null}
        </div>
      ) : null}
      {draft.evidence?.length ? (
        <div className="solution-draft-evidence"><strong>依据与来源</strong>{draft.evidence.map((item) => <span key={item.id}><em>{evidenceLabels[item.sourceType.toUpperCase()] ?? item.sourceType}</em>{item.title || '未命名来源'}{item.locator ? ` · ${item.locator}` : ''} · 置信度 {percent(item.confidence)}</span>)}</div>
      ) : null}
      {draft.citations.length ? <div className="solution-draft-citations"><strong>证据</strong>{draft.citations.map((citation, index) => <span key={citation.id}>[{index + 1}] {citation.title} · {citation.locator}</span>)}</div> : null}
      <div className="solution-draft-actions">
        {onSave ? <button type="button" className="solution-draft-save" disabled={saving || summary === (draft.executiveSummary?.trim() || fallbackSummary)} onClick={() => void save()}><Save aria-hidden="true" size={14} />{saved ? '已保存' : saving ? '保存中…' : '保存草稿'}</button> : null}
        {onConfirm && draft.status !== 'BLOCKED' && draft.status !== 'CONFIRMED' ? <button type="button" className="solution-draft-confirm" disabled={confirming} onClick={() => void confirm()}><FileCheck2 aria-hidden="true" size={14} />{confirming ? '确认中…' : '确认并生成正式方案'}</button> : null}
      </div>
    </section>
  )
}
