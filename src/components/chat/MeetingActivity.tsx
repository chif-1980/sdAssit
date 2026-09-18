import { useEffect, useRef, useState } from 'react'
import { Bell, Check, LoaderCircle } from 'lucide-react'
import { api } from '../../api/client'
import './MeetingActivity.css'

export interface MeetingActivityTask {
  id: string; conversationId: string; title: string; state: string
  progress: { message: string }; updatedAt: string
}
const isRunning = (task: MeetingActivityTask) => ['pending', 'running'].includes(task.state)

export function MeetingActivity({ userId, disabled, onOpen, onTasksChange }: {
  userId: string; disabled: boolean; onOpen: (task: MeetingActivityTask) => Promise<void>
  onTasksChange?: (tasks: MeetingActivityTask[]) => void
}) {
  const [tasks, setTasks] = useState<MeetingActivityTask[]>([])
  const [read, setRead] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const previous = useRef<Map<string, string>>(new Map())
  const storageKey = `meeting-activity-read:${userId}`
  useEffect(() => {
    let active = true
    let timer: number
    let saved: Record<string, string> = {}
    let initialized = false
    try {
      const value = localStorage.getItem(storageKey)
      initialized = value !== null
      saved = JSON.parse(value || '{}')
    } catch { /* Task state is always read from the server. */ }
    setRead(saved)
    previous.current = new Map()
    async function poll() {
      try {
        const response = await api<{ tasks: MeetingActivityTask[] }>('/api/chat/meeting-activity')
        if (!active) return
        const items = response.tasks
        // First use starts from now. On later visits, unseen terminal tasks remain unread.
        if (!initialized) {
          saved = Object.fromEntries(items.filter(task => !isRunning(task)).map(task => [task.id, task.updatedAt]))
          setRead(saved)
          try { localStorage.setItem(storageKey, JSON.stringify(saved)) } catch { /* Keep in memory. */ }
          initialized = true
        }
        const finished = items.filter(task => !isRunning(task) && ['pending', 'running'].includes(previous.current.get(task.id) || ''))
        if (finished.length) setAnnouncement(`${finished.length} 个会议任务已结束，可在后台任务中查看结果。`)
        previous.current = new Map(items.map(task => [task.id, task.state]))
        setTasks(items)
        onTasksChange?.(items)
        setError('')
      } catch { if (active) setError('任务状态暂时无法更新') }
      finally { if (active) timer = window.setTimeout(() => void poll(), 5000) }
    }
    void poll()
    return () => { active = false; window.clearTimeout(timer) }
  }, [storageKey, onTasksChange])
  const running = tasks.filter(isRunning)
  const unread = tasks.filter(task => !isRunning(task) && read[task.id] !== task.updatedAt)
  const visible = [...running, ...tasks.filter(task => !isRunning(task))]
  async function openTask(task: MeetingActivityTask) {
    setOpening(true)
    try {
      await onOpen(task)
      const next = { ...read, [task.id]: task.updatedAt }
      setRead(next)
      try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Keep in memory. */ }
      setOpen(false)
      setAnnouncement('')
    } catch { setError('打开任务失败，请重试') }
    finally { setOpening(false) }
  }
  return <div className="meeting-activity">
    <button type="button" className="meeting-activity-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Bell size={15} aria-hidden="true" /><span>后台任务</span>
      {running.length ? <span>{running.length} 进行中</span> : null}
      {unread.length ? <b aria-label={`${unread.length} 条未读通知`}>{unread.length}</b> : null}
    </button>
    {announcement ? <div className="meeting-notification" role="status"><span>{announcement}</span><button type="button" onClick={() => { setOpen(true); setAnnouncement('') }}>查看</button></div> : null}
    {open ? <div className="meeting-activity-panel" aria-label="后台会议任务">
      <p>会议在后台继续处理，可以新建或切换其他会话。</p>
      {error ? <p role="alert">{error}</p> : null}
      {!visible.length && !error ? <p>暂无会议任务</p> : null}
      {visible.map(task => <button type="button" disabled={disabled || opening} key={task.id} onClick={() => void openTask(task)}>
        {isRunning(task) ? <LoaderCircle size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
        <span><strong>{task.title}</strong><small>{task.state === 'completed' ? '已完成' : task.state === 'failed' ? '处理失败，可打开重试' : task.state === 'cancelled' ? '已取消' : task.progress.message}</small></span>
        {!isRunning(task) && read[task.id] !== task.updatedAt ? <i aria-label="未读" /> : null}
      </button>)}
    </div> : null}
  </div>
}
