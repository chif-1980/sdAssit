import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import type { Review } from '../../shared/domain/models.js'
import { api, ApiError } from '../api/client'
import { AsyncState, type AsyncStatus } from '../components/ui/AsyncState'

type ReviewListItem = Review & { allowedActions: string[] }

const reviewTypeLabels: Record<Review['reviewType'], string> = {
  NEW: '新增', UPDATE: '更新', CONFLICT: '冲突', STALE: '待复核',
}

export function ReviewListPage() {
  const [status, setStatus] = useState<AsyncStatus>('loading')
  const [reviews, setReviews] = useState<ReviewListItem[]>([])

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const result = await api<{ reviews: ReviewListItem[] }>('/api/reviews')
      setReviews(result.reviews)
      setStatus(result.reviews.length ? 'ready' : 'empty')
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <section className="workspace-page">
      <h1>审核</h1>
      <AsyncState status={status} emptyTitle="暂无待审核事项" errorTitle="审核列表加载失败" onRetry={() => void load()}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>事项</th><th>类型</th><th>风险</th><th>状态</th><th>创建时间</th></tr></thead>
            <tbody>{reviews.map((review) => (
              <tr key={review.id}>
                <td><Link className="primary-link" to={`/factory/reviews/${review.id}`}>{review.title}</Link></td>
                <td>{reviewTypeLabels[review.reviewType]}</td>
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
