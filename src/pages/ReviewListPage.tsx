import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import type { Review } from '../../shared/domain/models.js'
import { api, ApiError } from '../api/client'
import { AsyncState, type AsyncStatus } from '../components/ui/AsyncState'

type ReviewListItem = Review & { allowedActions: string[] }

const reviewTypeLabels: Record<Review['reviewType'], string> = {
  NEW: '新增', UPDATE: '更新', CONFLICT: '冲突', STALE: '待复核',
}

const problemLabels: Record<string, string> = {
  DUPLICATE: '重复', OVERLAP: '重叠', CONFLICT: '冲突', INSUFFICIENT_EVIDENCE: '证据不足',
  MISSING_SCOPE: '缺少范围', OUTDATED: '过期', OCR_ERROR: '解析异常', SOURCE_UNCLEAR: '来源不明',
}

export function ReviewListPage() {
  const [status, setStatus] = useState<AsyncStatus>('loading')
  const [reviews, setReviews] = useState<ReviewListItem[]>([])
  const [statusFilter, setStatusFilter] = useState('OPEN')
  const [problemFilter, setProblemFilter] = useState('')

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const params = new URLSearchParams({ status: statusFilter })
      if (problemFilter) params.set('problemTag', problemFilter)
      const result = await api<{ reviews: ReviewListItem[] }>(`/api/reviews?${params.toString()}`)
      setReviews(result.reviews)
      setStatus(result.reviews.length ? 'ready' : 'empty')
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
  }, [problemFilter, statusFilter])

  useEffect(() => { void load() }, [load])

  return (
    <section className="workspace-page">
      <h1>审核</h1>
      <div className="filter-bar" aria-label="审核筛选">
        <label className="field compact"><span>状态</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="OPEN">待处理</option><option value="PENDING">待审核</option><option value="CHANGES_REQUESTED">待修改</option><option value="RESOLVED">已完成</option></select></label>
        <label className="field compact"><span>问题类型</span><select value={problemFilter} onChange={(event) => setProblemFilter(event.target.value)}><option value="">全部问题</option>{Object.entries(problemLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <AsyncState status={status} emptyTitle="暂无待审核事项" errorTitle="审核列表加载失败" onRetry={() => void load()}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>事项</th><th>类型</th><th>问题</th><th>风险</th><th>状态</th><th>创建时间</th></tr></thead>
            <tbody>{reviews.map((review) => (
              <tr key={review.id}>
                <td><Link className="primary-link" to={`/factory/reviews/${review.id}`}>{review.title}</Link></td>
                <td>{reviewTypeLabels[review.reviewType]}</td>
                <td><div className="table-tags">{(review.problemTags ?? []).slice(0, 2).map((tag) => <span key={tag} className="status-chip">{problemLabels[tag] ?? tag}</span>)}</div></td>
                <td><span className={`status-chip risk-${review.risk.toLowerCase()}`}>{review.risk}</span></td>
                <td>{review.status}</td>
                <td><time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleDateString('zh-CN')}</time></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </AsyncState>
    </section>
  )
}
