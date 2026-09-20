import { useEffect, useId, useRef, useState } from 'react'
import { Check, CheckCircle2, CircleDot, Copy, Download, PencilLine, Sparkles } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MeetingDepartment, MeetingDirectoryUser, MeetingFollowup, MeetingRecord } from '../../../shared/api/product'
import { api } from '../../api/client'
import './MeetingCard.css'
import { MeetingMemberPicker } from './MeetingMemberPicker'
import { MeetingDatePicker } from './MeetingDatePicker'
import { editableMeetingBody, splitMeetingBody } from './meetingContent'
import { meetingTaskDate } from './meetingTaskDate'

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

function TaskEvidence({ sourceRefs, sources, sourceMeetingId }: { sourceRefs: string[]; sources: MeetingRecord['sources']; sourceMeetingId?: string }) {
  const [activeRef, setActiveRef] = useState<string>()
  const panelId = useId()
  const [originalSources, setOriginalSources] = useState<MeetingRecord['sources']>()
  const [sourceError, setSourceError] = useState('')
  useEffect(() => {
    if (!activeRef || !sourceMeetingId || originalSources) return
    let cancelled = false
    void api<{ meeting: MeetingRecord }>(`/api/chat/meetings/${encodeURIComponent(sourceMeetingId)}`)
      .then(response => { if (!cancelled) setOriginalSources(response.meeting.sources) })
      .catch(() => { if (!cancelled) setSourceError('原始分析版本暂不可访问，请稍后重试。') })
    return () => { cancelled = true }
  }, [activeRef, sourceMeetingId, originalSources])
  const evidenceSources = sourceMeetingId ? originalSources || [] : sources
  const match = activeRef?.match(/^S(\d+)-(P\d+)$/u)
  const source = match ? evidenceSources[Number(match[1]) - 1] : undefined
  const paragraph = source?.paragraphs.find(item => item.id === match?.[2])
  const sourceUrl = source?.url && /^https?:\/\//iu.test(source.url) ? source.url : undefined
  return <div className="meeting-task-evidence">
    <div className="meeting-task-evidence-links"><span>依据：</span>{[...new Set(sourceRefs)].map(ref =>
      <button key={ref} type="button" className="meeting-reference" aria-label={`查看待办依据 ${ref}`}
        aria-expanded={activeRef === ref} aria-controls={panelId}
        onClick={() => setActiveRef(current => current === ref ? undefined : ref)}>{ref}</button>,
    )}</div>
    {activeRef ? <section id={panelId} className="meeting-evidence" aria-label="待办原文依据">
      <strong>{activeRef}{source ? ` · ${source.title}` : ''}</strong>
      {paragraph ? <>
        <p className="meeting-task-evidence-meta">发言人：{paragraph.speaker || '未提供'} · {timeLabel(paragraph.startMs) || `段落 ${paragraph.id}`}</p>
        <p className="meeting-task-evidence-text">{paragraph.text}</p>
      </> : <p>{sourceError || (sourceMeetingId && !originalSources ? '正在读取原始分析版本…' : '此依据对应的原文片段暂不可用。')}</p>}
      {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">查看原始会议</a> : null}
    </section> : null}
  </div>
}

const knowledgeComparisonLabels: Record<string, string> = {
  COVERED: '正式知识已覆盖',
  NEEDS_UPDATE: '已有知识，建议修改',
  NEW_TOPIC: '正式知识未覆盖，建议新增',
  UNVERIFIED: '暂无法核对正式知识',
}

export function MeetingCard({ meeting, disabled, onAction, onDirtyChange }: {
  meeting: MeetingRecord; disabled?: boolean; onAction?: MeetingAction
  onDirtyChange?: (id: string, dirty: boolean) => void
}) {
  const [draftToRestore, setDraftToRestore] = useState(() => savedDraft(meeting.id))
  const [record, setRecord] = useState(meeting)
  const [body, setBody] = useState(draftToRestore?.body ?? editableMeetingBody(meeting.result))
  const [title, setTitle] = useState(draftToRestore?.title ?? meeting.result?.title ?? '')
  const [meetingType, setMeetingType] = useState(draftToRestore?.meetingType ?? meeting.result?.meetingType ?? '其他')
  const [editing, setEditing] = useState(Boolean(draftToRestore))
  const [saveStatus, setSaveStatus] = useState('已保存')
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    setCopied(false)
    return () => clearTimeout(copyTimer.current)
  }, [meeting.id, meeting.version])
  const [error, setError] = useState('')
  const [evidence, setEvidence] = useState<string>()
  const [exporting, setExporting] = useState(false)
  const [saveAttempt, setSaveAttempt] = useState(0)
  const [followup, setFollowup] = useState<MeetingFollowup | undefined>(meeting.result?.followup)
  const [directory, setDirectory] = useState<MeetingDirectoryUser[]>([])
  const [departments, setDepartments] = useState<MeetingDepartment[]>([])
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [directoryError, setDirectoryError] = useState('')
  const [directoryNotice, setDirectoryNotice] = useState('')
  const [directoryAttempt, setDirectoryAttempt] = useState(0)
  const [followupSaving, setFollowupSaving] = useState(false)
  const [followupError, setFollowupError] = useState('')
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(() => new Set())
  const [editingFollowupTasks, setEditingFollowupTasks] = useState<Set<string>>(() => new Set())
  const [followupTaskSnapshots, setFollowupTaskSnapshots] = useState<Record<string, MeetingFollowup['tasks'][number]>>({})
  const recordRef = useRef(record)
  const savingRef = useRef(false)
  const editRef = useRef({ body, title, meetingType })
  editRef.current = { body, title, meetingType }
  recordRef.current = record

  useEffect(() => {
    const previous = recordRef.current
    const hasLocalEdits = previous.result && (
      editRef.current.body !== editableMeetingBody(previous.result) || editRef.current.title !== previous.result.title
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
    setBody(editableMeetingBody(meeting.result))
    setTitle(meeting.result?.title ?? '')
    setMeetingType(meeting.result?.meetingType ?? '其他')
    setFollowup(meeting.result?.followup)
  }, [meeting.id, meeting.version, meeting.state])

  useEffect(() => {
    if (record.state !== 'completed' || !record.result?.followup) return
    let active = true
    setDirectoryLoading(true)
    setDirectoryError('')
    void api<{ users: MeetingDirectoryUser[]; departments?: MeetingDepartment[]; scopeNotice?: string }>(`/api/chat/meetings/${record.id}/followup-directory`)
      .then(response => { if (active) { setDirectory(response.users); setDepartments(response.departments ?? []); setDirectoryNotice(response.scopeNotice ?? '') } })
      .catch(failure => { if (active) { setDirectory([]); setDirectoryError(failure instanceof Error ? failure.message : '企业通讯录加载失败') } })
      .finally(() => { if (active) setDirectoryLoading(false) })
    return () => { active = false }
  }, [record.id, record.state, directoryAttempt])

  const dirty = Boolean(record.result && (body !== editableMeetingBody(record.result) || title !== record.result.title || meetingType !== record.result.meetingType))
  useEffect(() => {
    try {
      if (dirty) sessionStorage.setItem(`meeting-edit:${meeting.id}`, JSON.stringify({ body, title, meetingType, baseVersion: draftToRestore?.baseVersion ?? record.version }))
      else if (editing) sessionStorage.removeItem(`meeting-edit:${meeting.id}`)
    } catch { /* beforeunload and the unsaved indicator remain active. */ }
  }, [body, title, meetingType, dirty, editing, meeting.id, record.version, draftToRestore])
  const followupDirty = JSON.stringify(followup) !== JSON.stringify(record.result?.followup)
  useEffect(() => { onDirtyChange?.(meeting.id, dirty || followupDirty) }, [dirty, followupDirty, meeting.id, onDirtyChange])
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
    if (!dirty && !followupDirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, followupDirty])

  async function reloadSaved() {
    try {
      const response = await api<{ meeting: MeetingRecord }>(`/api/chat/meetings/${meeting.id}`)
      const latest = response.meeting
      setDraftToRestore(undefined)
      setRecord(latest)
      setBody(editableMeetingBody(latest.result))
      setTitle(latest.result?.title ?? '')
      setMeetingType(latest.result?.meetingType ?? '其他')
      setError('')
      setSaveStatus('已保存')
      sessionStorage.removeItem(`meeting-edit:${meeting.id}`)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '读取最新版本失败') }
  }

  async function copyMinutes() {
    try {
      const saved = await api<{ body: string }>(`/api/chat/meetings/${record.id}/markdown?version=${record.version}`)
      await navigator.clipboard.writeText(saved.body)
      clearTimeout(copyTimer.current)
      setCopied(true)
      copyTimer.current = setTimeout(() => setCopied(false), 3000)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '复制失败，请重试。') }
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

  function updateFollowupTask(taskId: string, patch: Partial<MeetingFollowup['tasks'][number]>) {
    setFollowup(current => current ? {
      ...current,
      tasks: current.tasks.map(task => {
        if (task.id !== taskId) return task
        const changedDeliveryField = ['title', 'content', 'assignee', 'dueDate'].some(field => field in patch)
        if (task.delivery?.feishuTaskId && (changedDeliveryField || 'status' in patch)) {
          return { ...task, ...patch, delivery: { ...task.delivery, pendingUpdate: true } }
        }
        return { ...task, ...patch, ...(task.reviewStatus === 'IGNORED' && changedDeliveryField ? { reviewStatus: 'PENDING' } : {}) }
      }),
    } : current)
    setFollowupError('')
  }

  function startFollowupTaskEdit(task: MeetingFollowup['tasks'][number]) {
    setFollowupTaskSnapshots(current => current[task.id] ? current : { ...current, [task.id]: task })
    setEditingFollowupTasks(current => new Set(current).add(task.id))
    setFollowupError('')
  }

  function cancelFollowupTaskEdit(taskId: string) {
    const snapshot = followupTaskSnapshots[taskId]
    if (snapshot) setFollowup(current => current ? {
      ...current,
      tasks: current.tasks.map(task => task.id === taskId ? snapshot : task),
    } : current)
    setFollowupTaskSnapshots(current => {
      const next = { ...current }
      delete next[taskId]
      return next
    })
    setEditingFollowupTasks(current => {
      const next = new Set(current)
      next.delete(taskId)
      return next
    })
    setFollowupError('')
  }

  function addFollowupTask() {
    const id = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setExpandedTasks(current => new Set(current).add(id))
    setFollowup(current => current ? {
      ...current,
      tasks: [...current.tasks, {
        id, title: '', content: '', assignee: null, dueDate: null, status: 'OPEN', sourceRefs: [],
        origin: 'MANUAL', reviewStatus: 'PENDING',
        delivery: { notification: 'NOT_SENT', feishuTaskId: null, messageId: null, error: null },
      }],
    } : current)
    setFollowupError('')
  }

  async function saveFollowup(action: 'SAVE' | 'CONFIRM' | 'RESEND' | 'IGNORE' | 'APPLY_AI' | 'DISMISS_AI' = 'SAVE', taskId?: string) {
    if (!followup || dirty || followupSaving) return
    const target = taskId ? followup.tasks.find(task => task.id === taskId) : undefined
    if ((action === 'CONFIRM' || action === 'RESEND' || action === 'IGNORE') && !target) return
    if ((action === 'CONFIRM' || action === 'RESEND') && !target?.title.trim()) {
      setFollowupError('请先填写待办标题，再确认并发送。')
      return
    }
    setFollowupSaving(true)
    setFollowupError('')
    try {
      const response = await api<{ meeting: MeetingRecord; deliveryError?: string }>(`/api/chat/meetings/${record.id}/followup`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: recordRef.current.version,
          action,
          taskId,
          tasks: followup.tasks.map(task => ({
            id: task.id,
            title: task.title,
            content: task.content ?? '',
            assigneeUserId: task.assignee?.userId ?? null,
            assigneeFeishuUserId: task.assignee?.feishuUserId ?? null,
            dueDate: meetingTaskDate(task) || null,
            status: task.status,
          })),
        }),
      })
      recordRef.current = response.meeting
      setRecord(response.meeting)
      setFollowup(response.meeting.result?.followup)
      if (action === 'SAVE') {
        setEditingFollowupTasks(new Set())
        setFollowupTaskSnapshots({})
      }
      if (response.deliveryError) setFollowupError(response.deliveryError)
    } catch (failure) {
      setFollowupError(failure instanceof Error ? failure.message : '跟进保存失败，请重试')
    } finally { setFollowupSaving(false) }
  }

  const references = record.sources.flatMap((source, i) => source.paragraphs.map(p => ({
    ...p, id: `S${i + 1}-${p.id}`, sourceTitle: source.title,
  })))
  const selected = references.find(p => p.id === evidence)
  const selectedHistory = record.result?.selectedHistory?.find(item => item.label === evidence)
  const markdown = body.replace(/\[(S\d+-P\d+|H\d+)\]/gu, '[$1](#meeting-evidence-$1)')
  const formalEvidenceById = new Map((record.result?.formalEvidence ?? []).map(item => [item.evidence_id, item]))
  const blocked = disabled || dirty || saveStatus === '保存中…'
  const [beforeTasks, afterTasks] = followup ? splitMeetingBody(markdown) : [markdown, '']
  return <section className="meeting-card" aria-label="会议纪要" data-meeting-id={meeting.id}>
    <header><strong>{record.result?.title || '会议纪要'}</strong><span>{record.result ? `版本 ${record.version}` : record.progress.message}</span></header>
    <p className="meeting-status">{record.progress.message} · 最近更新 {new Date(record.updatedAt).toLocaleString('zh-CN')}</p>
    {record.error ? <div role="alert">{record.error.message}
      {['EMPTY', 'SUMMARY_ONLY', 'PARTIAL', 'EXPIRED', 'ACCESS_REQUIRED', 'PARSE_FAILED', 'MISSING_BODY',
        'ATTACHMENT_MISSING', 'UNSUPPORTED_FILE', 'UNSAFE_ADDRESS', 'TOO_LARGE', 'REDIRECT_LIMIT', 'MULTIPLE_MEETINGS',
      ].includes(record.error.code) ? <p>可在下方输入框替换链接、上传文件或粘贴完整文字。</p> : null}
    </div> : null}
    {record.state === 'cancelled' ? <p>任务已取消，之前的成功结果保留在会话中。</p> : null}
    {record.result ? <>
      <div className="meeting-actions" role="group" aria-label="纪要操作">
        <div className="meeting-action-group">
          <button type="button" className={`meeting-action-edit${editing ? ' is-active' : ''}`} aria-pressed={editing} disabled={disabled || (editing && dirty)} title="直接修改标题、会议类型和正文，修改后自动保存" onClick={() => setEditing(!editing)}>
            {editing ? <Check size={15} aria-hidden="true" /> : <PencilLine size={15} aria-hidden="true" />}{editing ? '完成编辑' : '手动编辑'}
          </button>
          <button type="button" className="meeting-action-ai" disabled={blocked} title="在下方输入修改要求，发送后由 AI 修改纪要" onClick={() => onAction?.('revise', record.id)}>
            <Sparkles size={15} aria-hidden="true" />AI 帮我修改
          </button>
        </div>
        <div className="meeting-action-group meeting-action-utilities">
          <button type="button" className={`meeting-action-copy${copied ? ' is-copied' : ''}`} aria-live="polite" disabled={blocked || followupDirty || followupSaving} onClick={() => void copyMinutes()}>
            {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{copied ? '已复制' : '复制'}
          </button>
          <button type="button" disabled={blocked || followupDirty || followupSaving || exporting} onClick={() => void exportWord()}><Download size={15} aria-hidden="true" />{exporting ? '导出中…' : '导出 Word'}</button>
        </div>
        <span className={`meeting-save-status${dirty ? ' is-pending' : ''}`} role="status">
          {dirty ? <CircleDot size={14} aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}
          {dirty ? saveStatus : '已保存'}
        </span>
      </div>
      <p className="meeting-edit-help">手动编辑会自动保存；AI 修改需在下方输入要求后发送。</p>
      {editing ? <div className="meeting-editor">
        {followup ? <p className="meeting-edit-help">待办事项请在下方列表中修改，正文编辑不会修改待办。</p> : null}
        {dirty ? <button type="button" onClick={() => void navigator.clipboard.writeText(body).then(() => setSaveStatus('草稿已复制')).catch(() => setError('复制草稿失败，请手动选择正文复制。'))}>复制未保存正文</button> : null}
        <label>会议标题<input value={title} maxLength={512} onChange={e => setTitle(e.target.value)} /></label>
        <label>会议类型<select value={meetingType} onChange={e => setMeetingType(e.target.value)}>
          {[...new Set(['客户交流', '内部管理', '混合', '其他', meetingType])].map(type => <option key={type}>{type}</option>)}
        </select></label>
        <label>纪要正文（自动保存）<textarea value={body} onChange={e => setBody(e.target.value)} /></label>
      </div> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => href?.startsWith('#meeting-evidence-')
          ? <button className="meeting-reference" onClick={() => setEvidence(href.slice(18))}>{children}</button>
          : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      }}>{beforeTasks}</ReactMarkdown>}
      {followup ? <section className="meeting-followup" aria-label="待办事项">
        <p className="meeting-followup-note">跟进负责人：{followup.coordinator.displayName}。在此核对、修改和确认待办，确认后才会发送飞书。</p>
        <div className="meeting-followup-toolbar">
          <h2>待办事项</h2>
          <button type="button" disabled={blocked || followupSaving} onClick={addFollowupTask}>＋新增待办</button>
        </div>
        {followup.tasks.length ? <div className="meeting-followup-tasks">
          {followup.tasks.map(task => {
            const dateValue = meetingTaskDate(task)
            const taskEditing = editingFollowupTasks.has(task.id)
            const taskLocked = (task.reviewStatus === 'CONFIRMED' || task.reviewStatus === 'IGNORED') && !taskEditing
            return <article className={`meeting-followup-task meeting-followup-task-${task.reviewStatus || 'PENDING'}`} key={task.id}>
            <details className="meeting-task-detail" open={expandedTasks.has(task.id)}>
              <summary onClick={event => {
                event.preventDefault()
                setExpandedTasks(current => {
                  const next = new Set(current)
                  if (next.has(task.id)) next.delete(task.id)
                  else next.add(task.id)
                  return next
                })
              }}>
                <span className="meeting-task-summary-title">{task.title || '未填写待办'}{task.aiProposal ? <small>AI 修改待核对</small> : null}</span>
                <span>{task.assignee?.displayName || '待分配'}</span>
                <span>{dateValue || '期限待确认'}</span>
                <span className={`meeting-task-summary-status status-${task.reviewStatus === 'CONFIRMED' ? task.status : task.reviewStatus || 'PENDING'}`}>
                  {task.reviewStatus === 'IGNORED' ? '已忽略' : task.reviewStatus !== 'CONFIRMED' ? '待确认' : task.status === 'DONE' ? '已完成' : task.status === 'IN_PROGRESS' ? '进行中' : '待开始'}
                </span>
                <span className="meeting-task-expand">{expandedTasks.has(task.id) ? '收起 ∧' : '查看 / 修改 ∨'}</span>
              </summary>
              <div className="meeting-task-fields">
            <div className="meeting-followup-task-heading">
              <label>待办标题<input aria-label={`待办标题：${task.title || '未填写'}`} value={task.title} maxLength={1000} placeholder="填写待办事项" onChange={event => updateFollowupTask(task.id, { title: event.target.value })} disabled={disabled || followupSaving || taskLocked} /></label>
              <label className="meeting-followup-content-field">待办内容（可选）<textarea aria-label={`待办内容：${task.title || '未填写'}`} value={task.content ?? ''} maxLength={5000} placeholder="补充执行要求、交付物或上下文" onChange={event => updateFollowupTask(task.id, { content: event.target.value })} disabled={disabled || followupSaving || taskLocked} /></label>
              <span className="meeting-followup-origin">{task.origin === 'MANUAL' ? '人工补充' : '会议识别'}</span>
              <span className={`meeting-followup-review review-${task.reviewStatus || 'PENDING'}`}>
                {task.reviewStatus === 'CONFIRMED' ? '已确认' : task.reviewStatus === 'IGNORED' ? '已忽略' : task.reviewStatus === 'DELIVERY_FAILED' ? '发送失败，可重试' : '待确认'}
              </span>
            </div>
            {task.assigneeSuggestion ? <small>模型识别的负责人：{task.assigneeSuggestion}（请核对）</small> : null}
            <div className="meeting-field"><span>负责人</span><MeetingMemberPicker value={task.assignee} users={directory} departments={departments} loading={directoryLoading} error={directoryError} notice={directoryNotice} disabled={disabled || followupSaving || taskLocked} onRetry={() => setDirectoryAttempt(n => n + 1)} onChange={assignee => updateFollowupTask(task.id, { assignee })} /></div>
            <div className="meeting-field"><span>期限</span><MeetingDatePicker value={dateValue} onChange={dueDate => updateFollowupTask(task.id, { dueDate, dueDateEdited: true })} disabled={disabled || followupSaving || taskLocked} />
              {!dateValue ? <span>待确认，可稍后补充</span> : null}
              {task.dueDateSuggestion || (task.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate)) ? <span>原文期限：{task.dueDateSuggestion || task.dueDate}{dateValue ? '（请核对）' : '（请选择具体日期）'}</span> : null}
            </div>
            <label>状态<select value={task.status} onChange={event => updateFollowupTask(task.id, { status: event.target.value })} disabled={disabled || followupSaving || taskLocked}>
              <option value="OPEN">待开始</option><option value="IN_PROGRESS">进行中</option><option value="DONE">已完成</option>
            </select></label>
            {task.sourceRefs?.length ? <TaskEvidence sourceRefs={task.sourceRefs} sources={record.sources} sourceMeetingId={task.sourceMeetingId !== record.id ? task.sourceMeetingId : undefined} /> : null}
            {task.delivery?.notification === 'SENT' && task.delivery.messageId ? <small role="status">飞书已接收发给{task.assignee?.displayName || '负责人的'}通知{task.delivery.feishuTaskId ? '，待办已创建' : ''}。如未看到消息，请在飞书中查看应用机器人会话。{task.delivery.chatId ? <a className="meeting-feishu-chat-link" href={`https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(task.delivery.chatId)}`} target="_blank" rel="noreferrer">打开对应会话</a> : null}</small> : null}
            {task.delivery?.pendingUpdate ? <small role="status">本地修改已保存，待同步到飞书。</small> : null}
            {task.delivery?.syncError ? <small role="status">最近读取飞书状态失败：{task.delivery.syncError}</small> : null}
            {task.delivery?.error ? <p className="meeting-followup-delivery-error" role="alert">{task.delivery.error}</p> : null}
            {task.aiProposal ? <aside className="meeting-task-proposal" aria-label="AI 待办修改建议">
              <strong>AI 修改建议 · 待核对</strong>
              <p>{task.aiProposal.title}{task.aiProposal.content ? `：${task.aiProposal.content}` : ''}</p>
              <p>建议负责人：{task.aiProposal.assigneeSuggestion || '待确认'} · 期限：{task.aiProposal.dueDate || task.aiProposal.dueDateSuggestion || '待确认'}</p>
              {task.aiProposal.sourceRefs?.length ? <TaskEvidence sourceRefs={task.aiProposal.sourceRefs} sources={record.sources} sourceMeetingId={task.aiProposal.sourceMeetingId !== record.id ? task.aiProposal.sourceMeetingId : undefined} /> : null}
              <small>采用后请核对负责人；已发送的任务仍需点击“同步修改到飞书”。</small>
              <div><button type="button" disabled={blocked || followupSaving || followupDirty} onClick={() => void saveFollowup('APPLY_AI', task.id)}>采用修改</button>
              <button type="button" disabled={blocked || followupSaving || followupDirty} onClick={() => void saveFollowup('DISMISS_AI', task.id)}>保留原待办</button></div>
            </aside> : null}
            <div className="meeting-followup-task-actions">
              {taskEditing ? <>
                <button type="button" className="meeting-secondary-action" disabled={blocked || followupSaving} onClick={() => cancelFollowupTaskEdit(task.id)}>取消修改</button>
                <button type="button" disabled={blocked || followupSaving || !task.title.trim()} onClick={() => void saveFollowup('SAVE')}>
                  {followupSaving ? '保存中…' : '保存修改'}
                </button>
              </> : taskLocked ? <>
                <button type="button" disabled={blocked || followupSaving} onClick={() => startFollowupTaskEdit(task)}>修改</button>
                {task.reviewStatus === 'CONFIRMED' ? <button
                  type="button"
                  disabled={blocked || followupSaving || !task.title.trim()}
                  onClick={() => void saveFollowup(task.delivery?.feishuTaskId && !task.delivery.pendingUpdate && task.delivery.syncStatus !== 'FAILED' ? 'RESEND' : 'CONFIRM', task.id)}
                >
                  {task.delivery?.syncStatus === 'FAILED' ? '重试飞书同步' : task.delivery?.pendingUpdate ? '同步修改到飞书' : task.delivery?.feishuTaskId ? '重新发送通知' : '确认并发送'}
                </button> : null}
              </> : <button
                type="button"
                disabled={blocked || followupSaving || !task.title.trim()}
                onClick={() => void saveFollowup(task.reviewStatus === 'CONFIRMED' && task.delivery?.feishuTaskId ? 'RESEND' : 'CONFIRM', task.id)}
              >
                {followupSaving ? '处理中…' : task.reviewStatus === 'DELIVERY_FAILED' ? '重试发送' : task.reviewStatus === 'CONFIRMED' && task.delivery?.feishuTaskId ? '重新发送通知' : '确认并发送'}
              </button>}
              {!taskEditing && !taskLocked ? <button type="button" className="meeting-secondary-action" disabled={blocked || followupSaving || !task.title.trim() || task.reviewStatus === 'IGNORED' || task.reviewStatus === 'CONFIRMED'} onClick={() => void saveFollowup('IGNORE', task.id)}>忽略</button> : null}
            </div>
            {taskEditing ? <small className="meeting-followup-edit-hint">修改保存后，请同步到飞书；已发送待办会更新原任务。</small> : null}
              </div>
            </details>
          </article>
          })}
          <div className="meeting-followup-savebar">
            <button type="button" disabled={blocked || followupSaving} onClick={() => void saveFollowup()}>{followupSaving ? '保存中…' : '保存跟进'}</button>
            {followupDirty ? <small role="status">跟进修改尚未保存</small> : null}
          </div>
          {followupError ? <div role="alert">{followupError}</div> : null}
        </div> : <p>会议中没有识别到明确行动项，可点击“＋新增待办”补充。</p>}
      </section> : null}
      {!editing && afterTasks ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => href?.startsWith('#meeting-evidence-')
          ? <button className="meeting-reference" onClick={() => setEvidence(href.slice(18))}>{children}</button>
          : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      }}>{afterTasks}</ReactMarkdown> : null}
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
        {followup?.knowledgeSuggestions.length ? <section className="meeting-knowledge-suggestions" aria-label="知识更新建议">
          <h3>知识更新建议</h3>
          <p>以下判断仅供知识维护人员核对，平台不会自动修改正式知识。会议依据、正式知识依据和助手建议分开呈现。</p>
          {followup.knowledgeSuggestions.map(item => {
            const comparisonStatus = item.comparisonStatus || 'UNVERIFIED'
            const evidence = item.formalEvidence ?? (item.formalEvidenceIds ?? []).map(id => formalEvidenceById.get(id)).filter(Boolean)
            return <article key={item.id}>
              <div className="meeting-knowledge-suggestion-heading">
                <strong>{item.title}</strong>
                <span className={`meeting-knowledge-status status-${comparisonStatus}`}>
                  {!item.comparisonStatus ? '未记录比对结果' : knowledgeComparisonLabels[comparisonStatus] || '暂无法核对正式知识'}
                </span>
              </div>
              <p><b>会议提出：</b>{item.reason}</p>
              {item.status !== 'PENDING_MAINTAINER' ? <p><b>维护处理：</b>{({ COVERED: '已有知识覆盖', PROCESSING: '建议草稿处理中', DEFERRED: '暂缓处理', REJECTED: '不采纳' } as Record<string, string>)[item.status] || item.status}{item.decisionReason ? ` · ${item.decisionReason}` : ''}</p> : null}
              <div className="meeting-knowledge-comparison"><b>比对结论</b><span>{item.comparison || '此版本未记录逐条比对结果，无法据此判断正式知识是否已覆盖。'}</span></div>
              {item.sourceRefs.length ? <small>会议依据：{item.sourceRefs.join('、')}</small> : null}
              <div className="meeting-knowledge-evidence">
                <b>正式知识依据</b>
                {evidence.length ? <details><summary>{evidence.map(value => value!.evidence_id).join('、')}</summary>{evidence.map(value => <div key={value!.evidence_id}>
                  <strong>[{value!.evidence_id}] {value!.title}</strong>
                  <p>{value!.excerpt}</p>
                  {value!.source_url ? <a href={value!.source_url} target="_blank" rel="noreferrer">打开正式资料</a> : null}
                </div>)}</details> : <span>{item.comparisonStatus ? '本条建议没有可引用的正式知识依据' : '此版本没有逐条正式知识引用记录'}</span>}
              </div>
            </article>
          })}
        </section> : null}
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
