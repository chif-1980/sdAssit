import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, History, Search, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { MeetingHistoryItem, MeetingHistoryPage } from '../../../shared/api/product'
import { api } from '../../api/client'
import './MeetingHistoryPicker.css'

function analysisTime(item: MeetingHistoryItem) {
  return item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false }) : '未记录'
}

function metadata(item: MeetingHistoryItem) {
  return `${item.platforms.join(' / ') || '文字或文件'} · 分析于 ${analysisTime(item)}`
}

type SelectionProps = {
  selectedIds: string[]
  disabled: boolean
  known: Record<string, MeetingHistoryItem>
  onSelect: (item: MeetingHistoryItem) => void
  onLoaded: (items: MeetingHistoryItem[]) => void
}

function HistoryResults({ query = '', groupId, ...selection }: SelectionProps & { query?: string; groupId?: string }) {
  const [items, setItems] = useState<MeetingHistoryItem[]>([])
  const [offset, setOffset] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const { onLoaded } = selection
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams({ q: query, offset: String(offset), limit: '20' })
      if (groupId) params.set('groupId', groupId)
      try {
        const result = await api<MeetingHistoryPage>(`/api/chat/meetings?${params}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        setItems(current => offset ? [...current, ...result.meetings] : result.meetings)
        setNextOffset(result.nextOffset)
        setTotal(result.total)
        onLoaded(result.meetings)
      } catch {
        if (!controller.signal.aborted) setError(true)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, query && offset === 0 ? 250 : 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, groupId, offset, attempt, onLoaded])

  return <div className="meeting-history-results" aria-busy={loading}>
    {!groupId && !loading && !error && total > 0 ? <p className="meeting-history-result-count">{query ? '搜索结果' : '最近会议'} · {total} 场</p> : null}
    {items.map(item => <HistoryRow key={item.id} item={item} showVersions={!groupId} {...selection} />)}
    {loading ? <p className="meeting-history-status" role="status">正在加载历史会议…</p> : null}
    {error ? <p className="meeting-history-status" role="alert">历史会议加载失败<button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></p> : null}
    {!loading && !error && !items.length ? <p className="meeting-history-status">{query ? '未找到匹配会议，请换个关键词' : '暂无已完成的历史会议'}</p> : null}
    {!loading && !error && nextOffset !== null ? <button className="meeting-history-load-more" type="button" onClick={() => setOffset(nextOffset)}>加载更多{groupId ? '版本' : '会议'}</button> : null}
  </div>
}

function HistoryRow({ item, showVersions, ...selection }: SelectionProps & { item: MeetingHistoryItem; showVersions: boolean }) {
  const [versionsOpen, setVersionsOpen] = useState(false)
  const checked = selection.selectedIds.includes(item.id)
  const groupSelected = selection.selectedIds.some(id => selection.known[id]?.groupId === item.groupId)
  const atLimit = selection.selectedIds.length >= 5 && !checked && !groupSelected
  const links = item.sourceUrls.filter(url => /^https?:\/\//i.test(url))
  return <article className={`meeting-history-row${checked ? ' is-selected' : ''}`}>
    <label className="meeting-history-option">
      <input type="checkbox" aria-label={`${item.title}，${metadata(item)}`} checked={checked}
        disabled={selection.disabled || atLimit} onChange={() => selection.onSelect(item)} />
      <span className="meeting-history-info">
        <strong title={item.title}>{item.title}</strong>
        <small>{metadata(item)}</small>
        {item.meetingDate && !['未提供', '待确认'].includes(item.meetingDate) ? <small>会议日期：{item.meetingDate}</small> : null}
        {showVersions && item.versionCount > 1 ? <small className="meeting-history-version-note">最新成功结果 · 共 {item.versionCount} 个分析版本</small> : null}
      </span>
    </label>
    <div className="meeting-history-row-actions">
      <details className="meeting-history-preview">
        <summary>预览纪要</summary>
        <div>
          <small>纪要节选</small>
          <ReactMarkdown components={{ img: () => null }}>{item.preview || '该版本没有可预览的纪要正文。'}</ReactMarkdown>
          {links.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer">查看原始来源{links.length > 1 ? ` ${index + 1}` : ''}</a>)}
        </div>
      </details>
      {showVersions && item.versionCount > 1 ? <button type="button" className="meeting-history-versions-toggle" aria-expanded={versionsOpen}
        onClick={() => setVersionsOpen(value => !value)}>{versionsOpen ? '收起历史版本' : `历史分析版本（${item.versionCount}）`}</button> : null}
    </div>
    {versionsOpen ? <div className="meeting-history-versions" aria-label={`${item.title}的历史分析版本`}>
      <p>同一会议只引用一个分析版本，选择其他版本会替换当前选择。</p>
      <HistoryResults groupId={item.groupId} {...selection} />
    </div> : null}
  </article>
}

export function MeetingHistoryPicker({ selectedIds, onChange, disabled }: {
  selectedIds: string[]; onChange: (ids: string[]) => void; disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [known, setKnown] = useState<Record<string, MeetingHistoryItem>>({})
  const onLoaded = useCallback((items: MeetingHistoryItem[]) => {
    setKnown(current => ({ ...current, ...Object.fromEntries(items.map(item => [item.id, item])) }))
  }, [])
  function onSelect(item: MeetingHistoryItem) {
    if (selectedIds.includes(item.id)) onChange(selectedIds.filter(id => id !== item.id))
    else {
      const others = selectedIds.filter(id => known[id]?.groupId !== item.groupId)
      if (others.length < 5) onChange([...others, item.id])
    }
  }
  return <details className="meeting-history" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <History size={16} aria-hidden="true" />
      <span className="meeting-history-title">引用历史会议</span>
      <span className={`meeting-history-count${selectedIds.length ? ' has-selection' : ''}`}>{selectedIds.length ? `已选 ${selectedIds.length} 场` : '可选'}</span>
      <ChevronDown className="meeting-history-chevron" size={16} aria-hidden="true" />
    </summary>
    {open ? <div className="meeting-history-panel">
      <div className="meeting-history-search">
        <Search size={15} aria-hidden="true" />
        <input type="search" aria-label="搜索历史会议" placeholder="搜索会议标题或纪要关键词" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      <div className="meeting-history-selection">
        <span>已选 {selectedIds.length}/5 场</span>
        {selectedIds.length ? <div className="meeting-history-selected" aria-label="已选历史会议">
          {selectedIds.map(id => <span key={id} className="meeting-history-chip">
            <span title={known[id] ? metadata(known[id]) : undefined}>{known[id]?.title || '已选会议'}<small>{known[id] ? analysisTime(known[id]) : ''}</small></span>
            <button type="button" disabled={disabled} aria-label={`移除 ${known[id]?.title || '已选会议'} ${known[id] ? analysisTime(known[id]) : ''}`}
              onClick={() => onChange(selectedIds.filter(value => value !== id))}><X size={13} aria-hidden="true" /></button>
          </span>)}
        </div> : <small>仅引用你主动选择的会议</small>}
      </div>
      <div className="meeting-history-options">
        <HistoryResults key={query.trim()} query={query.trim()} selectedIds={selectedIds} disabled={disabled} known={known} onSelect={onSelect} onLoaded={onLoaded} />
      </div>
    </div> : null}
  </details>
}
