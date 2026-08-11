import { CheckCircle2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'

import type { Asset, Candidate, Review } from '../../shared/domain/models.js'
import { api, ApiError } from '../api/client'
import { AsyncState, type AsyncStatus } from '../components/ui/AsyncState'
import { useSession } from '../session/SessionProvider'

interface AssetDetail { asset: Asset; candidates: Candidate[]; reviews: Review[] }

const relationLabels: Record<Candidate['relation'], string> = {
  NEW: '新增', DUPLICATE: '重复', UPDATE: '更新', CONFLICT: '冲突',
}

export function AssetDetailPage() {
  const { assetId } = useParams()
  const { user } = useSession()
  const [status, setStatus] = useState<AsyncStatus>('loading')
  const [detail, setDetail] = useState<AssetDetail>()
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>()
  const [processing, setProcessing] = useState(false)
  const [processMessage, setProcessMessage] = useState<string>()

  const load = useCallback(async () => {
    if (!assetId) return
    setStatus('loading')
    try {
      const result = await api<AssetDetail>(`/api/assets/${assetId}`)
      setDetail(result)
      setSelectedCandidateId(result.candidates[0]?.id)
      setStatus('ready')
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
  }, [assetId])

  useEffect(() => { void load() }, [load])

  const selectedCandidate = useMemo(
    () => detail?.candidates.find((candidate) => candidate.id === selectedCandidateId),
    [detail?.candidates, selectedCandidateId],
  )

  useEffect(() => {
    if (!selectedCandidate) return
    const section = detail?.asset.sections.find((item) => item.locator === selectedCandidate.sourceLocator)
    if (section) document.getElementById(`source-${section.id}`)?.scrollIntoView?.({ block: 'center' })
  }, [detail?.asset.sections, selectedCandidate])

  async function processAsset() {
    if (!assetId) return
    setProcessing(true)
    setProcessMessage(undefined)
    try {
      const result = await api<AssetDetail>(`/api/assets/${assetId}/process`, { method: 'POST' })
      setDetail(result)
      setSelectedCandidateId(result.candidates[0]?.id)
      setProcessMessage(result.asset.processStatus === 'PROCESSED' ? '处理完成' : '处理失败')
    } finally {
      setProcessing(false)
    }
  }

  function selectSection(locator: string, excerpt: string) {
    const candidate = detail?.candidates.find((item) => item.sourceLocator === locator && item.sourceExcerpt === excerpt)
    if (candidate) setSelectedCandidateId(candidate.id)
  }

  const canRetry = user?.role === 'ADMIN' && detail?.asset.processStatus === 'FAILED'

  return (
    <section className="workspace-page">
      <div className="page-title-row">
        <h1>资料详情</h1>
        {canRetry ? (
          <button type="button" className="primary-button" disabled={processing} onClick={() => void processAsset()}>
            <RefreshCw aria-hidden="true" size={16} />
            {processing ? '处理中' : '重新处理'}
          </button>
        ) : null}
      </div>
      {processMessage ? <p className="success-message"><CheckCircle2 aria-hidden="true" size={16} />{processMessage}</p> : null}
      <AsyncState status={status} errorTitle="资料详情加载失败" onRetry={() => void load()}>
        {detail ? (
          <>
            <div className="asset-metadata">
              <strong>{detail.asset.title}</strong>
              <span>{detail.asset.authority}</span>
              <span>{detail.asset.processStatus}</span>
            </div>
            {detail.asset.errorMessage ? <p className="error-banner">{detail.asset.errorMessage}</p> : null}
            <div className="evidence-layout">
              <section className="evidence-source" aria-label="来源内容">
                <h2>来源内容</h2>
                {detail.asset.sections.length ? detail.asset.sections.map((section) => {
                  const selected = selectedCandidate?.sourceLocator === section.locator
                    && selectedCandidate.sourceExcerpt === section.excerpt
                  return (
                    <button
                      id={`source-${section.id}`}
                      key={section.id}
                      type="button"
                      className={selected ? 'source-section selected' : 'source-section'}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => selectSection(section.locator, section.excerpt)}
                    >
                      <span>{section.title}</span>
                      <small>{section.locator}</small>
                      <p>{section.excerpt}</p>
                    </button>
                  )
                }) : <p className="inline-empty">暂无可展示内容</p>}
              </section>
              <section className="candidate-panel" aria-label="候选知识">
                <h2>候选知识</h2>
                {detail.candidates.length ? detail.candidates.map((candidate) => {
                  const selected = candidate.id === selectedCandidateId
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      className={selected ? 'candidate-item selected' : 'candidate-item'}
                      aria-pressed={selected}
                      onClick={() => setSelectedCandidateId(candidate.id)}
                    >
                      <span className="candidate-title">{candidate.title}</span>
                      <span className={`status-chip relation-${candidate.relation.toLowerCase()}`}>{relationLabels[candidate.relation]}</span>
                      <p>{candidate.content}</p>
                      <small>{candidate.aiReason}</small>
                    </button>
                  )
                }) : <p className="inline-empty">暂无候选知识</p>}
              </section>
            </div>
          </>
        ) : null}
      </AsyncState>
    </section>
  )
}
