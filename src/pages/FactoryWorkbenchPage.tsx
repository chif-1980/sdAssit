import { AlertTriangle, BookOpenCheck, ClipboardCheck, FileCheck2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, ApiError } from '../api/client'
import { AsyncState, type AsyncStatus } from '../components/ui/AsyncState'

interface ReviewItem {
  id: string
  title: string
  reviewType: 'NEW' | 'UPDATE' | 'CONFLICT' | 'STALE'
  risk: 'LOW' | 'MEDIUM' | 'HIGH'
  status: string
  createdAt: string
}

interface KnowledgeItem { id: string; title: string; status: string }
interface AssetItem { id: string; title: string; processStatus: string; updatedAt: string }

export function FactoryWorkbenchPage() {
  const [status, setStatus] = useState<AsyncStatus>('loading')
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [staleKnowledge, setStaleKnowledge] = useState<KnowledgeItem[]>([])
  const [recentAssets, setRecentAssets] = useState<AssetItem[]>([])

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const [reviewData, knowledgeData, assetData] = await Promise.all([
        api<{ reviews: ReviewItem[] }>('/api/reviews'),
        api<{ knowledge: KnowledgeItem[] }>('/api/knowledge?status=STALE'),
        api<{ assets: AssetItem[] }>('/api/assets'),
      ])
      setReviews(reviewData.reviews)
      setStaleKnowledge(knowledgeData.knowledge)
      setRecentAssets(assetData.assets
        .filter((asset) => asset.processStatus === 'PROCESSED')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 5))
      setStatus('ready')
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const conflicts = reviews.filter((review) => review.reviewType === 'CONFLICT')
  const signals = [
    { label: '待审核', value: reviews.length, icon: ClipboardCheck, tone: 'teal' },
    { label: '冲突', value: conflicts.length, icon: AlertTriangle, tone: 'red' },
    { label: '待复核知识', value: staleKnowledge.length, icon: BookOpenCheck, tone: 'amber' },
    { label: '最近处理资料', value: recentAssets.length, icon: FileCheck2, tone: 'neutral' },
  ]

  return (
    <section className="workspace-page">
      <h1>工作台</h1>
      <AsyncState status={status} errorTitle="工作台加载失败" onRetry={() => void load()}>
        <section className="signal-grid" aria-label="运营信号">
          {signals.map(({ label, value, icon: Icon, tone }) => (
            <div key={label} className={`signal-item signal-${tone}`}>
              <Icon aria-hidden="true" size={18} />
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </section>
        <div className="workbench-columns">
          <section className="data-section">
            <div className="section-heading"><h2>优先审核</h2><Link to="/factory/reviews">查看全部</Link></div>
            {reviews.length ? (
              <ul className="priority-list">
                {reviews.slice(0, 6).map((review) => (
                  <li key={review.id}>
                    <Link to={`/factory/reviews/${review.id}`}>{review.title}</Link>
                    <span className={`status-chip risk-${review.risk.toLowerCase()}`}>{review.risk}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="inline-empty">暂无待审核事项</p>}
          </section>
          <section className="data-section">
            <div className="section-heading"><h2>最近处理资料</h2><Link to="/factory/assets">查看全部</Link></div>
            {recentAssets.length ? (
              <ul className="plain-list">
                {recentAssets.map((asset) => <li key={asset.id}><Link to={`/factory/assets/${asset.id}`}>{asset.title}</Link></li>)}
              </ul>
            ) : <p className="inline-empty">暂无已处理资料</p>}
          </section>
        </div>
      </AsyncState>
    </section>
  )
}
