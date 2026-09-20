import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'

function iso(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function MeetingDatePicker({ value, disabled, onChange }: {
  value: string; disabled?: boolean; onChange: (value: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => new Date())
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const today = iso(new Date())
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const offset = (first.getDay() + 6) % 7
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  useLayoutEffect(() => {
    if (!open) return
    const rect = trigger.current!.getBoundingClientRect()
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 292)),
      top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - (panel.current?.offsetHeight || 350) - 12)) })
    panel.current?.querySelector<HTMLButtonElement>('[aria-pressed=true]:not(:disabled), [aria-current=date], .calendar-days button:not(:disabled)')?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    const close = () => setOpen(false)
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close() }
    document.addEventListener('mousedown', outside)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', scroll, true)
    return () => { document.removeEventListener('mousedown', outside); window.removeEventListener('resize', close); window.removeEventListener('scroll', scroll, true) }
  }, [open])
  function choose(next: string | null) { onChange(next); setOpen(false); trigger.current?.focus() }
  return <div className="meeting-date-picker" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus() }
  }}>
    <button type="button" ref={trigger} className="meeting-date-trigger" disabled={disabled} aria-label={`期限：${value || '待确认'}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setMonth(value ? new Date(`${value}T12:00:00`) : new Date()); setOpen(!open) }}>
      <span>{value || '选择日期'}</span><CalendarDays size={14} aria-hidden="true" />
    </button>
    {open ? createPortal(<div className="meeting-calendar" role="dialog" aria-label="选择截止日期" ref={panel} style={position}>
      <div className="calendar-header">
        <button type="button" aria-label="上个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
        <strong aria-live="polite">{month.getFullYear()}年{month.getMonth() + 1}月</strong>
        <button type="button" aria-label="下个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
      </div>
      <div className="calendar-days">
        {['一', '二', '三', '四', '五', '六', '日'].map(day => <small key={day}>{day}</small>)}
        {Array.from({ length: offset }, (_, index) => <span key={`empty-${index}`} />)}
        {Array.from({ length: days }, (_, index) => {
          const day = new Date(month.getFullYear(), month.getMonth(), index + 1)
          const date = iso(day)
          return <button type="button" key={date} aria-label={date} disabled={date < today} aria-current={date === today ? 'date' : undefined} aria-pressed={date === value} onClick={() => choose(date)}>{index + 1}</button>
        })}
      </div>
      <div className="calendar-footer"><button type="button" onClick={() => choose(null)}>清空日期</button><button type="button" onClick={() => choose(iso(new Date()))}>今天</button></div>
    </div>, document.body) : null}
  </div>
}
