import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MeetingRecord } from '../../../shared/api/product'
import { api } from '../../api/client'
import './MeetingCard.css'

export type MeetingAction = (action: 'revise' | 'retry', id: string) => void

function savedDraft(id: string): { body: string; title: string; meetingType: string; baseVersion: number } | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(`meeting-edit:${id}`) || 'null')
    if (value && typeof value.body === 'string' && typeof value.title === 'string'
      && typeof value.meetingType === 'string' && Number.isInteger(value.baseVersion)) return value
  } catch { /* Browser storage may be unavailable; the editor still reports unsaved changes. */ }
  return undefined
}

function timeLabel(ms?: number | null) {
  if (ms == null) return ''
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export function MeetingCard({ meeting, disabled, onAction, onDirtyChange }: {
  meeting: MeetingRecord; disabled?: boolean; onAction?: MeetingAction
  onDirtyChange?: (id: string, dirty: boolean) => void
}) {
  const [draftToRestore, setDraftToRestore] = useState(() => savedDraft(meeting.id))
  const [record, setRecord] = useState(meeting)
  const [body, setBody] = useState(draftToRestore?.body ?? meeting.result?.body ?? '')
  const [title, setTitle] = useState(draftToRestore?.title ?? meeting.result?.title ?? '')
  const [meetingType, setMeetingType] = useState(draftToRestore?.meetingType ?? meeting.result?.meetingType ?? '其他')
  const [editing, setEditing] = useState(Boolean(draftToRestore))
  const [saveStatus, setSaveStatus] = useState('已保存')
  const [error, setError] = useState('')
  const [evidence, setEvidence] = useState<string>()
  const [exporting, setExporting] = useState(false)
  const [saveAttempt, setSaveAttempt] = useState(0)
  const recordRef = useRef(record)
  const savingRef = useRef(false)
  const editRef = useRef({ body, title, meetingType })
  editRef.current = { body, title, meetingType }
  recordRef.current = record

  useEffect(() => {
    const previous = recordRef.current
    const hasLocalEdits = previous.result && (
      editRef.current.body !== previous.result.body || editRef.current.title !== previous.result.title
      || editRef.current.meetingType !== previous.result.meetingType
    )
    if (previous.id === meeting.id && hasLocalEdits && previous.version !== meeting.version) {
      setDraftToRestore({ ...editRef.current, baseVersion: previous.version })
      setError('服务器版本已变化，已保留本地编辑。请复制修改内容，核对最新版本后再编辑。')
      return
    }
    setRecord(meeting)
    if (draftToRestore) {
      if (draftToRestore.baseVersion !== meeting.version) setError('服务器版本已变化，已保留本地编辑。请复制修改内容，核对最新版本后再编辑。')
      return
    }
    setBody(meeting.result?.body ?? '')
    setTitle(meeting.result?.title ?? '')
    setMeetingType(meeting.result?.meetingType ?? '其他')
  }, [meeting.id, meeting.version, meeting.state])

  const dirty = Boolean(record.result && (body !== record.result.body || title !== record.result.title || meetingType !== record.result.meetingType))
  useEffect(() => {
    try {
      if (dirty) sessionStorage.setItem(`meeting-edit:${meeting.id}`, JSON.stringify({ body, title, meetingType, baseVersion: draftToRestore?.baseVersion ?? record.version }))
      else if (editing) sessionStorage.removeItem(`meeting-edit:${meeting.id}`)
    } catch { /* beforeunload and the unsaved indicator remain active. */ }
  }, [body, title, meetingType, dirty, editing, meeting.id, record.version, draftToRestore])
  useEffect(() => { onDirtyChange?.(meeting.id, dirty) }, [dirty, meeting.id, onDirtyChange])
  useEffect(() => () => { onDirtyChange?.(meeting.id, false) }, [meeting.id, onDirtyChange])
  useEffect(() => {
    if (!dirty || disabled || !editing) return
    if (draftToRestore && draftToRestore.baseVersion !== meeting.version) return
    setSaveStatus('等待保存…')
    const timer = window.setTimeout(async () => {
      if (savingRef.current) return
      if (!body.trim() || !title.trim()) {
        setError('标题和正文不能为空，修改尚未保存。')
        return
      }
      savingRef.current = true
      setSaveStatus('保存中…')
      try {
        // Drain edits that arrive while the preceding save is in flight.
        while (true) {
          const latest = { ...editRef.current }
          if (!latest.body.trim() || !latest.title.trim()) throw new Error('标题和正文不能为空，修改尚未保存。')
          const saved = await api<{ meeting: MeetingRecord }>(`/api/chat/meetings/${meeting.id}`, {
            method: 'PATCH', body: JSON.stringify({ version: recordRef.current.version, ...latest }),
          })
          recordRef.current = saved.meeting
          setRecord(saved.meeting)
          setDraftToRestore(undefined)
          if (JSON.stringify(latest) === JSON.stringify(editRef.current)) break
        }
        setError('')
        setSaveStatus('已保存')
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : '保存失败，请重试')
        setSaveStatus('保存失败')
      } finally { savingRef.current = false }
    }, 750)
    return () => window.clearTimeout(timer)
  }, [body, title, meetingType, dirty, editing, disabled, meeting.id, meeting.version, draftToRestore, saveAttempt])

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  async function reloadSaved() {
    try {
      const response = await api<{ meeting: MeetingRecord }>(`/api/chat/meetings/${meeting.id}`)
      const latest = response.meeting
      setDraftToRestore(undefined)
      setRecord(latest)
      setBody(latest.result?.body ?? '')
      setTitle(latest.result?.title ?? '')
      setMeetingType(latest.result?.meetingType ?? '其他')
      setError('')
      setSaveStatus('已保存')
      sessionStorage.removeItem(`meeting-edit:${meeting.id}`)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '读取最新版本失败') }
  }

  async function exportWord() {
    setExporting(true)
    try {
      const response = await fetch(`/api/chat/meetings/${record.id}/export?version=${record.version}`, { credentials: 'include' })
      if (!response.ok) throw new Error('导出失败，请确认修改已保存后重试。')
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `${title}-v${record.version}.docx`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '导出失败') }
    finally { setExporting(false) }
  }

  const references = record.sources.flatMap((source, i) => source.paragraphs.map(p => ({
    ...p, id: `S${i + 1}-${p.id}`, sourceTitle: source.title,
  })))
  const selected = references.find(p => p.id === evidence)
  const selectedHistory = record.result?.selectedHistory?.find(item => item.label === evidence)
  const markdown = body.replace(/\[(S\d+-P\d+|H\d+)\]/gu, '[$1](#meeting-evidence-$1)')
  const blocked = disabled || dirty || saveStatus === '保存中…'
  return <section className="meeting-card" aria-label="会议纪要">
    <header><strong>{record.result?.title || '会议纪要'}</strong><span>{record.result ? `版本 ${record.version}` : record.progress.message}</span></header>
    <p className="meeting-status">{record.progress.message} · 最近更新 {new Date(record.updatedAt).toLocaleString('zh-CN')}</p>
    {record.error ? <div role="alert">{record.error.message}<p>可在下方输入框替换链接、上传文件或粘贴完整文字。</p></div> : null}
    {record.state === 'cancelled' ? <p>任务已取消，之前的成功结果保留在会话中。</p> : null}
    {record.result ? <>
      <div className="meeting-actions">
        <button disabled={disabled || (editing && dirty)} onClick={() => setEditing(!editing)}>{editing ? '结束编辑' : '编辑正文'}</button>
        <button disabled={blocked} onClick={() => onAction?.('revise', record.id)}>继续修改</button>
        <button onClick={() => void navigator.clipboard.writeText(body).then(() => setSaveStatus('已复制')).catch(() => setError('复制失败，请手动选择正文复制。'))}>复制</button>
        <button disabled={blocked || exporting} onClick={() => void exportWord()}>{exporting ? '导出中…' : '导出 Word'}</button>
        <span role="status">{dirty ? saveStatus : saveStatus === '已复制' ? '已复制' : '已保存'}</span>
      </div>
      {editing ? <div className="meeting-editor">
        <label>会议标题<input value={title} maxLength={512} onChange={e => setTitle(e.target.value)} /></label>
        <label>会议类型<select value={meetingType} onChange={e => setMeetingType(e.target.value)}>
          {[...new Set(['客户交流', '内部管理', '混合', '其他', meetingType])].map(type => <option key={type}>{type}</option>)}
        </select></label>
        <label>纪要正文（自动保存）<textarea value={body} onChange={e => setBody(e.target.value)} /></label>
      </div> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => href?.startsWith('#meeting-evidence-')
          ? <button className="meeting-reference" onClick={() => setEvidence(href.slice(18))}>{children}</button>
          : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      }}>{markdown}</ReactMarkdown>}
      {selected ? <aside className="meeting-evidence" aria-label="原文依据">
        <button onClick={() => setEvidence(undefined)}>关闭原文</button>
        <strong>{selected.id} · {selected.sourceTitle}</strong>
        <p>发言人：{selected.speaker} · {timeLabel(selected.startMs) || `段落 ${selected.id.split('-')[1]}`}</p>
        <p>{selected.text}</p>
      </aside> : null}
      {selectedHistory ? <aside className="meeting-evidence" aria-label="历史会议依据">
        <button onClick={() => setEvidence(undefined)}>关闭原文</button>
        <strong>{selectedHistory.label} · {selectedHistory.title}（历史会议）</strong>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedHistory.body}</ReactMarkdown>
      </aside> : null}
      {record.result.selectedHistory?.length ? <details><summary>本次明确选用的历史会议</summary>{record.result.selectedHistory.map(item => <article key={item.id}>
        <strong>{item.label ? `${item.label} · ` : ''}{item.title}</strong><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.body}</ReactMarkdown>
      </article>)}</details> : null}
      {record.result.formalEvidence?.length ? <details><summary>企业正式资料依据</summary>{record.result.formalEvidence.map(e => <article key={e.evidence_id}>
        <strong>[{e.evidence_id}] {e.title}</strong><p>{e.excerpt}</p>
        {e.source_url ? <a href={e.source_url} target="_blank" rel="noreferrer">打开正式资料</a> : null}
      </article>)}</details> : null}
    </> : null}
    {record.sources.map((source, index) => <details key={index}>
      <summary>{source.platform} · {source.title} · {source.paragraphs.length} 段</summary>
      {source.url ? <a href={source.url} target="_blank" rel="noreferrer">查看原始会议</a> : null}
      {source.summaryNotice ? <p>{source.summaryNotice}</p> : null}
      {source.platformSummary ? <details><summary>平台生成的总结（辅助材料）</summary><pre>{source.platformSummary}</pre></details> : null}
    </details>)}
    {['failed', 'cancelled', 'completed'].includes(record.state) ? <button disabled={blocked} onClick={() => onAction?.('retry', record.id)}>
      {record.state === 'completed' ? '重新分析（保留此版本）' : '重试'}
    </button> : null}
    {error ? <div role="alert">{error}{dirty ? <>
      <button onClick={() => setSaveAttempt(n => n + 1)}>重试保存</button>
      <button disabled={savingRef.current} onClick={() => void reloadSaved()}>放弃本地修改，读取已保存版本</button>
    </> : null}</div> : null}
  </section>
}
