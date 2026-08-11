import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type { Authority, BusinessType, ProcessStatus } from '../../shared/domain/enums.js'
import { api, ApiError } from '../api/client'
import { AsyncState, type AsyncStatus } from '../components/ui/AsyncState'
import { useSession } from '../session/SessionProvider'

interface AssetListItem {
  id: string
  title: string
  businessType: BusinessType
  authority: Authority
  ownerId: string
  processStatus: ProcessStatus
  candidateCount: number
  reviewCount: number
  updatedAt: string
}

const businessLabels: Record<BusinessType, string> = {
  PRODUCT_DOCUMENT: '产品文档', SOLUTION: '解决方案', POLICY: '制度', PROCESS: '流程',
  TRAINING: '培训', CUSTOMER_MEETING: '客户会议', INTERNAL_MEETING: '内部会议',
  PROJECT_DOCUMENT: '项目文档', SESSION_UPLOAD: '会话上传', OTHER: '其他',
}

const statusLabels: Record<ProcessStatus, string> = {
  NEW: '待处理', PROCESSING: '处理中', PROCESSED: '已处理', FAILED: '处理失败',
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
})

export function AssetListPage() {
  const { users } = useSession()
  const [status, setStatus] = useState<AsyncStatus>('loading')
  const [assets, setAssets] = useState<AssetListItem[]>([])
  const ownerNames = useMemo(() => new Map(users.map((user) => [user.id, user.name])), [users])

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const result = await api<{ assets: AssetListItem[] }>('/api/assets')
      setAssets(result.assets)
      setStatus(result.assets.length ? 'ready' : 'empty')
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <section className="workspace-page">
      <h1>资料</h1>
      <AsyncState status={status} emptyTitle="暂无资料" errorTitle="资料加载失败" onRetry={() => void load()}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>资料</th><th>类型</th><th>Authority</th><th>Owner</th><th>状态</th><th>候选</th><th>更新时间</th></tr></thead>
            <tbody>
              {assets.map((asset) => (
                <tr key={asset.id}>
                  <td><Link className="primary-link" to={`/factory/assets/${asset.id}`}>{asset.title}</Link></td>
                  <td>{businessLabels[asset.businessType]}</td>
                  <td><span className="status-chip">{asset.authority}</span></td>
                  <td>{ownerNames.get(asset.ownerId) ?? asset.ownerId}</td>
                  <td><span className={`status-chip process-${asset.processStatus.toLowerCase()}`}>{statusLabels[asset.processStatus]}</span></td>
                  <td>{asset.candidateCount}</td>
                  <td><time dateTime={asset.updatedAt}>{dateFormatter.format(new Date(asset.updatedAt))}</time></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncState>
    </section>
  )
}
