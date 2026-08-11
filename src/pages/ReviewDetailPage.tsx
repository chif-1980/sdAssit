import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import type { Asset, Candidate, Knowledge, Review } from '../../shared/domain/models.js'
import type { ResolutionAction } from '../../shared/domain/enums.js'
import { api, ApiError } from '../api/client'
import { AsyncState, type AsyncStatus } from '../components/ui/AsyncState'

interface ReviewDetail {
  review: Review
  candidate?: Candidate
  knowledge?: Knowledge
  sourceAsset?: Asset
  allowedActions: ResolutionAction[]
}

interface ResolutionResult { review: Review; candidate?: Candidate; knowledge?: Knowledge }

const actionLabels: Record<ResolutionAction, string> = {
  CREATE_KNOWLEDGE: '创建新知识', UPDATE_KNOWLEDGE: '更新知识', KEEP_CURRENT: '保留现状',
  REJECT_CANDIDATE: '拒绝候选', ARCHIVE_KNOWLEDGE: '归档知识', CONFIRM_VALID: '确认有效',
}

export function ReviewDetailPage() {
  const { reviewId } = useParams()
  const navigate = useNavigate()
  const [status, setStatus] = useState<AsyncStatus>('loading')
  const [detail, setDetail] = useState<ReviewDetail>()
  const [selectedAction, setSelectedAction] = useState<ResolutionAction>()
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
      setStatus('ready')
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
  }, [reviewId])

  useEffect(() => { void load() }, [load])

  const requiresContent = selectedAction === 'CREATE_KNOWLEDGE' || selectedAction === 'UPDATE_KNOWLEDGE'
  const canSubmit = useMemo(() => selectedAction !== undefined
    && decisionComment.trim().length > 0
    && (!requiresContent || finalContent.trim().length > 0), [decisionComment, finalContent, requiresContent, selectedAction])

  async function submitResolution() {
    if (!reviewId || !selectedAction || !canSubmit) return
    setSubmitting(true)
    setSubmitError(false)
    try {
      const result = await api<ResolutionResult>(`/api/reviews/${reviewId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          action: selectedAction,
          ...(requiresContent ? { finalContent } : {}),
          decisionComment,
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
            </section>
            <section className="decision-panel" aria-label="审核裁决">
              <h2>审核裁决</h2>
              <div className="action-set" role="group" aria-label="可用动作">
                {detail.allowedActions.map((action) => (
                  <button key={action} type="button" aria-pressed={selectedAction === action} onClick={() => setSelectedAction(action)} disabled={submitting}>
                    {actionLabels[action]}
                  </button>
                ))}
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
