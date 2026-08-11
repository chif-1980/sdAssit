import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import type { Knowledge } from '../../shared/domain/models.js'
import { api, ApiError } from '../api/client'
import { AsyncState, type AsyncStatus } from '../components/ui/AsyncState'
import { useSession } from '../session/SessionProvider'

export function KnowledgeListPage() {
  const { users } = useSession()
  const [searchParams, setSearchParams] = useSearchParams()
  const [status, setStatus] = useState<AsyncStatus>('loading')
  const [knowledge, setKnowledge] = useState<Knowledge[]>([])
  const ownerNames = useMemo(() => new Map(users.map((user) => [user.id, user.name])), [users])
  const query = searchParams.toString()

  useEffect(() => {
    let active = true
    setStatus('loading')
    void api<{ knowledge: Knowledge[] }>(`/api/knowledge${query ? `?${query}` : ''}`)
      .then((result) => {
        if (!active) return
        setKnowledge(result.knowledge)
        setStatus(result.knowledge.length ? 'ready' : 'empty')
      })
      .catch((error) => {
        if (active) setStatus(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
      })
    return () => { active = false }
  }, [query])

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(key, value); else next.delete(key)
    setSearchParams(next, { replace: true })
  }

  return (
    <section className="workspace-page">
      <h1>知识</h1>
      <div className="filter-bar">
        <label className="field compact"><span>搜索知识</span><input value={searchParams.get('q') ?? ''} onChange={(event) => setFilter('q', event.target.value)} /></label>
        <label className="field compact"><span>状态</span><select value={searchParams.get('status') ?? ''} onChange={(event) => setFilter('status', event.target.value)}><option value="">全部</option><option value="ACTIVE">生效</option><option value="STALE">待复核</option><option value="ARCHIVED">已归档</option></select></label>
        <label className="field compact"><span>Authority</span><select value={searchParams.get('authority') ?? ''} onChange={(event) => setFilter('authority', event.target.value)}><option value="">全部</option>{['L0', 'L1', 'L2', 'L3'].map((value) => <option key={value}>{value}</option>)}</select></label>
      </div>
      <AsyncState status={status} emptyTitle="暂无知识" errorTitle="知识列表加载失败">
        <div className="table-wrap"><table>
          <thead><tr><th>知识</th><th>类型</th><th>状态</th><th>Authority</th><th>Owner</th><th>版本</th><th>索引</th></tr></thead>
          <tbody>{knowledge.map((item) => <tr key={item.id}>
            <td><Link className="primary-link" to={`/factory/knowledge/${item.id}`}>{item.title}</Link></td>
            <td>{item.category}</td><td>{item.status}</td><td>{item.authority}</td><td>{ownerNames.get(item.ownerId) ?? item.ownerId}</td><td>{item.version}</td><td>{item.indexStatus}</td>
          </tr>)}</tbody>
        </table></div>
      </AsyncState>
    </section>
  )
}
