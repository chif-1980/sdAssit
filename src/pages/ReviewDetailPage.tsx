import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import type { ApplicabilityScope, Asset, Candidate, CrossDocumentRelation, Knowledge, Review } from '../../shared/domain/models.js'
import type { ProblemTag, ResolutionAction, ReviewDecision } from '../../shared/domain/enums.js'
import { api, ApiError } from '../api/client'
import { AsyncState, type AsyncStatus } from '../components/ui/AsyncState'

interface ReviewDetail {
  review: Review
  candidate?: Candidate
  knowledge?: Knowledge
  sourceAsset?: Asset
  allowedActions: ResolutionAction[]
  problemActions?: ResolutionAction[]
  comparisons?: CrossDocumentRelation[]
  assignees?: Array<{ id: string; name: string; role: 'OWNER' | 'ADMIN' }>
}

interface ResolutionResult { review: Review; candidate?: Candidate; knowledge?: Knowledge }

const actionLabels: Record<ResolutionAction, string> = {
  CREATE_KNOWLEDGE: '创建新知识', UPDATE_KNOWLEDGE: '更新知识', KEEP_CURRENT: '保留现状',
  REJECT_CANDIDATE: '拒绝候选', ARCHIVE_KNOWLEDGE: '归档知识', CONFIRM_VALID: '确认有效',
  MARK_DUPLICATE: '标记重复', SPLIT_BY_SCOPE: '按范围拆分', MARK_INSUFFICIENT: '标记证据不足',
}

const decisionLabels: Record<ReviewDecision, string> = {
  PUBLISH: '发布', REQUEST_CHANGES: '需要修改', REJECT: '驳回', TRANSFER: '转交',
}

const problemLabels: Record<ProblemTag, string> = {
  DUPLICATE: '重复', OVERLAP: '内容重叠', CONFLICT: '内容冲突',
  INSUFFICIENT_EVIDENCE: '证据不足', MISSING_SCOPE: '缺少适用范围', OUTDATED: '内容过期',
  OCR_ERROR: '解析/OCR 异常', SOURCE_UNCLEAR: '来源不明确',
}

const relationLabels: Record<CrossDocumentRelation['relationType'], string> = {
  EXACT_DUPLICATE: '完全重复', OVERLAP: '高度重叠', COMPLEMENTARY: '互补内容',
  CONDITIONAL_VARIANT: '条件变体', CONFLICT: '相同条件冲突', INSUFFICIENT: '证据不足',
}

export function ReviewDetailPage() {
  const { reviewId } = useParams()
  const navigate = useNavigate()
  const [status, setStatus] = useState<AsyncStatus>('loading')
  const [detail, setDetail] = useState<ReviewDetail>()
  const [selectedAction, setSelectedAction] = useState<ResolutionAction>()
  const [selectedDecision, setSelectedDecision] = useState<ReviewDecision>()
  const [selectedProblems, setSelectedProblems] = useState<ProblemTag[]>([])
  const [assigneeId, setAssigneeId] = useState('')
  const [applicability, setApplicability] = useState<ApplicabilityScope>({})
  const [finalContent, setFinalContent] = useState('')
  const [decisionComment, setDecisionComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(false)

  const load = useCallback(async () => {
    if (!reviewId) return
    setStatus('loading')
    try {
      const result = await api<ReviewDetail>(`/api/reviews/${reviewId}`)
      setDetail(result)
      setFinalContent(result.review.proposedContent ?? result.candidate?.content ?? result.knowledge?.content ?? '')
      setApplicability(result.review.applicability ?? result.candidate?.applicability ?? {})
      setSelectedProblems(result.review.problemTags ?? [])
      setStatus('ready')
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
  }, [reviewId])

  useEffect(() => { void load() }, [load])

  const requiresContent = selectedDecision !== 'REQUEST_CHANGES' && selectedDecision !== 'REJECT'
    && selectedDecision !== 'TRANSFER'
    && (selectedAction === 'CREATE_KNOWLEDGE' || selectedAction === 'UPDATE_KNOWLEDGE' || selectedAction === 'SPLIT_BY_SCOPE')
  const canSubmit = useMemo(() => selectedAction !== undefined
    && selectedDecision !== undefined
    && decisionComment.trim().length > 0
    && (selectedDecision !== 'TRANSFER' || Boolean(assigneeId))
    && (!requiresContent || finalContent.trim().length > 0), [assigneeId, decisionComment, finalContent, requiresContent, selectedAction, selectedDecision])

  function selectAction(action: ResolutionAction) {
    setSelectedAction(action)
    if (!selectedDecision) {
      if (action === 'REJECT_CANDIDATE') setSelectedDecision('REJECT')
      else if (action === 'MARK_INSUFFICIENT') setSelectedDecision('REQUEST_CHANGES')
      else setSelectedDecision('PUBLISH')
    }
  }

  function selectDecision(decision: ReviewDecision) {
    setSelectedDecision(decision)
    if (decision === 'REJECT') setSelectedAction('REJECT_CANDIDATE')
    else if (decision === 'REQUEST_CHANGES') setSelectedAction('MARK_INSUFFICIENT')
    else if (decision === 'PUBLISH' && !selectedAction) {
      setSelectedAction(detail?.review.reviewType === 'NEW' ? 'CREATE_KNOWLEDGE' : 'UPDATE_KNOWLEDGE')
    }
  }

  function toggleProblem(problem: ProblemTag) {
    setSelectedProblems((current) => current.includes(problem)
      ? current.filter((item) => item !== problem)
      : [...current, problem])
  }

  async function submitResolution() {
    if (!reviewId || !selectedAction || !canSubmit) return
    setSubmitting(true)
    setSubmitError(false)
    try {
      const result = await api<ResolutionResult>(`/api/reviews/${reviewId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          action: selectedAction,
          decision: selectedDecision,
          ...(requiresContent ? { finalContent } : {}),
          decisionComment,
          problemTags: selectedProblems,
          applicability,
          ...(selectedDecision === 'TRANSFER' ? { assigneeId } : {}),
        }),
      })
      navigate(result.knowledge ? `/factory/knowledge/${result.knowledge.id}` : '/factory/reviews')
    } catch {
      setSubmitError(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="workspace-page">
      <h1>审核详情</h1>
      <AsyncState status={status} errorTitle="审核详情加载失败" onRetry={() => void load()}>
        {detail ? (
          <div className="review-layout">
            <section className="review-context">
              <div className="detail-heading"><h2>{detail.review.title}</h2><span className={`status-chip risk-${detail.review.risk.toLowerCase()}`}>{detail.review.risk}</span></div>
              {detail.knowledge ? <div className="content-block"><h3>当前正式内容</h3><p>{detail.knowledge.content}</p></div> : null}
              <div className="content-block"><h3>新证据</h3><p>{detail.candidate?.sourceExcerpt ?? detail.review.proposedContent}</p></div>
              {detail.sourceAsset ? <p className="source-line">来源：<Link to={`/factory/assets/${detail.sourceAsset.id}`}>{detail.sourceAsset.title}</Link> · {detail.sourceAsset.authority}</p> : null}
              {detail.review.aiSuggestion ? <div className="content-block"><h3>AI 分析</h3><p>{detail.review.aiSuggestion}</p></div> : null}
              {detail.comparisons?.length ? <div className="comparison-panel" aria-label="跨文档比较">
                <div className="comparison-heading"><h3>跨文档比较</h3><span>{detail.comparisons.length} 条关系</span></div>
                {detail.comparisons.map((comparison) => <article className={`comparison-card relation-${comparison.relationType.toLowerCase()}`} key={comparison.id}>
                  <div className="comparison-card-heading"><strong>{relationLabels[comparison.relationType]}</strong><span>{Math.round(comparison.confidence * 100)}% 置信度</span></div>
                  <p>{comparison.aiReason}</p>
                  {comparison.scopeDiffs.length ? <small>范围差异：{comparison.scopeDiffs.join('；')}</small> : null}
                  <div className="comparison-diff"><blockquote>{comparison.leftExcerpt}</blockquote><span aria-hidden="true">↕</span><blockquote>{comparison.rightExcerpt}</blockquote></div>
                </article>)}
              </div> : null}
            </section>
            <section className="decision-panel" aria-label="审核裁决">
              <h2>审核裁决</h2>
              <div className="decision-set" role="group" aria-label="审核结果">
                {(Object.keys(decisionLabels) as ReviewDecision[]).map((decision) => <button key={decision} type="button" aria-pressed={selectedDecision === decision} onClick={() => selectDecision(decision)} disabled={submitting}>{decisionLabels[decision]}</button>)}
              </div>
              <div className="problem-tags" aria-label="问题标签">
                <span>问题标签</span>
                <div>{(Object.keys(problemLabels) as ProblemTag[]).map((problem) => <button key={problem} type="button" aria-pressed={selectedProblems.includes(problem)} onClick={() => toggleProblem(problem)}>{problemLabels[problem]}</button>)}</div>
              </div>
              <div className="action-set" role="group" aria-label="可用动作">
                {[...detail.allowedActions, ...(detail.problemActions ?? [])].map((action) => (
                  <button key={action} type="button" aria-pressed={selectedAction === action} onClick={() => selectAction(action)} disabled={submitting}>
                    {actionLabels[action]}
                  </button>
                ))}
              </div>
              {selectedDecision === 'TRANSFER' ? <label className="field"><span>转交给</span><select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}><option value="">请选择负责人</option>{(detail.assignees ?? []).map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.name} · {assignee.role}</option>)}</select></label> : null}
              <div className="scope-fields" aria-label="适用范围">
                <span>适用范围（可修改）</span>
                <div className="scope-grid">
                  {(['industry', 'product', 'productVersion', 'deploymentMode', 'customerType'] as const).map((key) => <label className="field compact" key={key}><span>{{ industry: '行业', product: '产品', productVersion: '产品版本', deploymentMode: '部署模式', customerType: '客户类型' }[key]}</span><input value={applicability[key] ?? ''} onChange={(event) => setApplicability((current) => ({ ...current, [key]: event.target.value || undefined }))} /></label>)}
                </div>
              </div>
              {requiresContent ? (
                <label className="field"><span>正式内容</span><textarea value={finalContent} onChange={(event) => setFinalContent(event.target.value)} rows={8} /></label>
              ) : null}
              <label className="field"><span>审核意见</span><textarea value={decisionComment} onChange={(event) => setDecisionComment(event.target.value)} rows={4} /></label>
              {submitError ? <p className="form-error">提交失败，内容已保留</p> : null}
              <button type="button" className="primary-button" disabled={!canSubmit || submitting} onClick={() => void submitResolution()}>
                {submitting ? '提交中' : '确认裁决'}
              </button>
            </section>
          </div>
        ) : null}
      </AsyncState>
    </section>
  )
}
