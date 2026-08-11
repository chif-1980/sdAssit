import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import type { Asset, Knowledge, Review } from '../../shared/domain/models.js'
import { api, ApiError } from '../api/client'
import { AsyncState, type AsyncStatus } from '../components/ui/AsyncState'
import { useSession } from '../session/SessionProvider'

interface KnowledgeDetail { knowledge: Knowledge; primaryAsset: Asset; supportingAssets: Asset[]; history: Review[] }
type RequestMode = 'UPDATE' | 'ARCHIVE'

export function KnowledgeDetailPage() {
  const { knowledgeId } = useParams()
  const { user, users } = useSession()
  const [status, setStatus] = useState<AsyncStatus>('loading')
  const [detail, setDetail] = useState<KnowledgeDetail>()
  const [mode, setMode] = useState<RequestMode>()
  const [proposedContent, setProposedContent] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [requestError, setRequestError] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const [updateReviewId, setUpdateReviewId] = useState<string>()
  const [archiveReviewId, setArchiveReviewId] = useState<string>()
  const ownerNames = useMemo(() => new Map(users.map((item) => [item.id, item.name])), [users])

  const load = useCallback(async () => {
    if (!knowledgeId) return
    setStatus('loading')
    try {
      const result = await api<KnowledgeDetail>(`/api/knowledge/${knowledgeId}`)
      setDetail(result)
      setProposedContent(result.knowledge.content)
      setStatus('ready')
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
  }, [knowledgeId])

  useEffect(() => { void load() }, [load])

  async function createReview() {
    if (!knowledgeId || !mode || !reason.trim()) return
    if (mode === 'UPDATE' && !proposedContent.trim()) return
    setSubmitting(true)
    setRequestError(false)
    try {
      const result = await api<{ review: Review }>(`/api/knowledge/${knowledgeId}/request-update`, {
        method: 'POST',
        body: JSON.stringify(mode === 'ARCHIVE'
          ? { intent: 'ARCHIVE', decisionComment: reason }
          : { proposedContent, decisionComment: reason }),
      })
      if (mode === 'ARCHIVE') setArchiveReviewId(result.review.id); else setUpdateReviewId(result.review.id)
      setMode(undefined)
      setReason('')
    } catch {
      setRequestError(true)
    } finally {
      setSubmitting(false)
    }
  }

  async function reindex() {
    if (!knowledgeId) return
    setReindexing(true)
    try {
      setDetail(await api<KnowledgeDetail>(`/api/knowledge/${knowledgeId}/reindex`, { method: 'POST' }))
    } finally {
      setReindexing(false)
    }
  }

  return (
    <section className="workspace-page">
      <div className="page-title-row"><h1>知识详情</h1><div className="page-actions"><button type="button" className="secondary-button" onClick={() => setMode('UPDATE')}>申请更新</button><button type="button" className="secondary-button" onClick={() => setMode('ARCHIVE')}>申请归档</button></div></div>
      <AsyncState status={status} errorTitle="知识详情加载失败" onRetry={() => void load()}>
        {detail ? <>
          <article className="knowledge-content">
            <div className="detail-heading"><h2>{detail.knowledge.title}</h2><span className="status-chip">{detail.knowledge.status}</span></div>
            <p>{detail.knowledge.content}</p>
            <dl className="metadata-grid">
              <div><dt>Authority</dt><dd>{detail.knowledge.authority}</dd></div>
              <div><dt>Owner</dt><dd>{ownerNames.get(detail.knowledge.ownerId) ?? detail.knowledge.ownerId}</dd></div>
              <div><dt>版本</dt><dd>版本 {detail.knowledge.version}</dd></div>
              <div><dt>索引</dt><dd>{detail.knowledge.indexStatus}</dd></div>
            </dl>
          </article>
          {mode ? <section className="request-form" aria-label={mode === 'UPDATE' ? '更新申请' : '归档申请'}>
            <h2>{mode === 'UPDATE' ? '申请更新' : '申请归档'}</h2>
            {mode === 'UPDATE' ? <label className="field"><span>正式内容</span><textarea rows={7} value={proposedContent} onChange={(event) => setProposedContent(event.target.value)} /></label> : null}
            <label className="field"><span>{mode === 'UPDATE' ? '申请原因' : '归档原因'}</span><textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
            {requestError ? <p className="form-error">创建审核失败，编辑内容已保留</p> : null}
            <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setMode(undefined)}>取消</button><button type="button" className="primary-button" disabled={submitting || !reason.trim() || (mode === 'UPDATE' && !proposedContent.trim())} onClick={() => void createReview()}>{mode === 'UPDATE' ? '创建审核' : '创建归档审核'}</button></div>
          </section> : null}
          {updateReviewId ? <p className="success-message"><Link to={`/factory/reviews/${updateReviewId}`}>查看更新审核</Link></p> : null}
          {archiveReviewId ? <p className="success-message"><Link to={`/factory/reviews/${archiveReviewId}`}>查看归档审核</Link></p> : null}
          <div className="knowledge-columns">
            <section className="data-section"><h2>来源</h2><ul className="plain-list"><li><Link to={`/factory/assets/${detail.primaryAsset.id}`}>{detail.primaryAsset.title}</Link></li>{detail.supportingAssets.map((asset) => <li key={asset.id}><Link to={`/factory/assets/${asset.id}`}>{asset.title}</Link></li>)}</ul></section>
            <section className="data-section"><h2>审核历史</h2><ul className="plain-list">{detail.history.map((review) => <li key={review.id}><Link to={`/factory/reviews/${review.id}`}>{review.title}</Link><span>{review.resolutionAction ?? review.status}</span></li>)}</ul></section>
          </div>
          {user?.role === 'ADMIN' && detail.knowledge.indexStatus === 'FAILED' ? <button type="button" className="secondary-button" disabled={reindexing} onClick={() => void reindex()}>{reindexing ? '重建中' : '重建索引'}</button> : null}
        </> : null}
      </AsyncState>
    </section>
  )
}
