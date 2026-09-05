import { AlertTriangle, CheckCircle2, CircleAlert, Clock3, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { SolutionDraft, SolutionDraftEditRequest } from '../../../shared/api/product.js'
import { mermaidMarkdownComponents } from './MermaidBlock'

interface SolutionDraftCardProps {
  draft: SolutionDraft
  onSave?: (patch: SolutionDraftEditRequest) => Promise<void>
}

const statusLabels: Record<SolutionDraft['status'], string> = {
  GENERATING: '生成中',
  READY: '待确认',
  NEEDS_REVIEW: '需要复核',
  BLOCKED: '证据不足，暂不可确认',
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

export function SolutionDraftCard({ draft, onSave }: SolutionDraftCardProps) {
  const fallbackSummary = draft.quality?.notes?.[0]
    || draft.evidenceGaps?.[0]
    || (draft.sourceRunId ? `方案结果未形成结构化草稿，请重试。运行编号：${draft.sourceRunId}` : '方案结果未形成结构化草稿，请重试。')
  const initialSummary = draft.executiveSummary?.trim() || fallbackSummary
  const [summary, setSummary] = useState(initialSummary)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
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

  const StatusIcon = draft.status === 'READY' ? CheckCircle2 : draft.status === 'BLOCKED' ? CircleAlert : AlertTriangle
  const architecture = architectureView(draft)
  const blockedWithoutContent = draft.status === 'BLOCKED' && !draft.sections.length && !draft.executiveSummary?.trim()
  const blockedReason = draft.quality?.notes?.[0] || draft.evidenceGaps?.[0] || 'Agent 未返回完整结构化方案。'
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
      ) : null}
      <label className="solution-draft-summary">
        <span>执行摘要</span>
        <textarea value={summary} rows={3} disabled={!onSave || saving} onChange={(event) => setSummary(event.target.value)} />
      </label>
      {blockedWithoutContent ? (
        <div className="solution-draft-callout solution-draft-blocked-diagnostic" role="alert">
          <strong>Agent 未返回完整结构化方案</strong>
          <p>{blockedReason}</p>
          {draft.sourceRunId ? <small>运行编号：{draft.sourceRunId}</small> : null}
          <p>请重试，或补充客户资料后再次生成。</p>
        </div>
      ) : null}
      {draft.requirements.length ? (
        <div className="solution-draft-requirements">
          <h4>需求清单</h4>
          <ul>
            {draft.requirements.map((requirement) => (
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
          {architecture.overview.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={mermaidMarkdownComponents}>{architecture.overview}</ReactMarkdown> : null}
          {architecture.layers.length ? (
            <div className="solution-draft-architecture-layers">
              {architecture.layers.map((layer) => <span key={layer.name}>{layer.components.length ? `${layer.name}：${layer.components.join('、')}` : layer.name}</span>)}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="solution-draft-sections">
        {draft.sections.map((section) => (
          <article key={section.id}>
            <h4>{section.title}</h4>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mermaidMarkdownComponents}>{section.contentMarkdown}</ReactMarkdown>
            {section.citationIds.length ? <small>引用 {section.citationIds.map((id) => draft.citations.findIndex((citation) => citation.id === id) + 1).filter((index) => index > 0).map((index) => `[${index}]`).join(' ')}</small> : null}
          </article>
        ))}
      </div>
      {draft.risks.length ? (
        <div className="solution-draft-callout solution-draft-risks"><strong>能力边界与风险</strong>{draft.risks.map((risk) => <p key={risk}>{risk}</p>)}</div>
      ) : null}
      {draft.conflicts.length ? (
        <div className="solution-draft-callout solution-draft-conflicts"><strong>需要人工确认的冲突</strong>{draft.conflicts.map((conflict) => <div key={conflict.claim}><p>{conflict.claim}：{conflict.alternatives.map((item) => item.statement).join(' / ')}</p>{conflict.applicability ? <small>适用范围：{conflict.applicability}</small> : null}</div>)}</div>
      ) : null}
      {draft.openQuestions.length || draft.evidenceGaps.length ? (
        <div className="solution-draft-callout"><strong>待补充</strong>{[...draft.openQuestions, ...draft.evidenceGaps].map((item) => <p key={item}>{item}</p>)}</div>
      ) : null}
      {draft.review?.status === 'REQUIRED' && draft.review.pendingItems.length ? (
        <div className="solution-draft-callout solution-draft-review"><strong>人工审核节点</strong><span>{draft.review.requiredRoles.length ? `请由${draft.review.requiredRoles.join('、')}确认` : '请完成方案复核'}</span>{draft.review.pendingItems.map((item) => <p key={item}>{item}</p>)}</div>
      ) : null}
      {draft.evidence?.length ? (
        <div className="solution-draft-evidence"><strong>依据与来源</strong>{draft.evidence.map((item) => <span key={item.id}><em>{evidenceLabels[item.sourceType.toUpperCase()] ?? item.sourceType}</em>{item.title || '未命名来源'}{item.locator ? ` · ${item.locator}` : ''} · 置信度 {percent(item.confidence)}</span>)}</div>
      ) : null}
      {draft.citations.length ? <div className="solution-draft-citations"><strong>证据</strong>{draft.citations.map((citation, index) => <span key={citation.id}>[{index + 1}] {citation.title} · {citation.locator}</span>)}</div> : null}
      {onSave ? <button type="button" className="solution-draft-save" disabled={saving || summary === (draft.executiveSummary?.trim() || fallbackSummary)} onClick={() => void save()}><Save aria-hidden="true" size={14} />{saved ? '已保存' : saving ? '保存中…' : '保存草稿'}</button> : null}
    </section>
  )
}
