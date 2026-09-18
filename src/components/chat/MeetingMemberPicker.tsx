import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Search, Users, X } from 'lucide-react'
import { pinyin } from 'pinyin-pro'
import type { MeetingDepartment, MeetingDirectoryUser } from '../../../shared/api/product'

export function MeetingMemberPicker({ value, users, departments, loading, error, notice, disabled, onChange, onRetry }: {
  value: MeetingDirectoryUser | null; users: MeetingDirectoryUser[]; departments: MeetingDepartment[]
  loading: boolean; error: string; notice: string; disabled?: boolean
  onChange: (user: MeetingDirectoryUser | null) => void; onRetry: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [department, setDepartment] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0, width: 560 })
  useLayoutEffect(() => {
    if (!open) return
    function place() {
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      const width = Math.min(560, window.innerWidth - 24)
      const height = Math.min(panel.current?.offsetHeight || 390, window.innerHeight - 24)
      setPosition({ width, left: Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(anchor.bottom + 6, window.innerHeight - height - 12)) })
    }
    place()
    window.addEventListener('resize', place)
    const closeOnScroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('scroll', closeOnScroll, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', closeOnScroll, true) }
  }, [open, loading, error])
  const indexed = useMemo(() => users.map(user => ({ user, search: [user.displayName, user.englishName,
    pinyin(user.displayName, { toneType: 'none', separator: '' }),
    pinyin(user.displayName, { pattern: 'first', toneType: 'none', separator: '' }),
  ].join(' ').toLowerCase() })), [users])
  const normalized = query.trim().toLowerCase().replace(/\s+/g, '')
  const visible = indexed.filter(({ user, search }) => normalized
    ? search.replace(/\s+/g, '').includes(normalized)
    : !department || user.departmentIds?.includes(department))
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  function choose(user: MeetingDirectoryUser | null) { onChange(user); setOpen(false); trigger.current?.focus() }
  function tree(parent: string | null, ancestors: string[] = []): React.ReactNode {
    return departments.filter(d => d.parentId === parent && !ancestors.includes(d.id)).map(d => {
      const children = departments.some(child => child.parentId === d.id)
      const button = <button type="button" aria-pressed={department === d.id} onClick={() => { setDepartment(d.id); setQuery('') }}>{d.name}</button>
      return children ? <details key={d.id} open><summary>{button}</summary><div className="member-tree-children">{tree(d.id, [...ancestors, d.id])}</div></details> : <div key={d.id}>{button}</div>
    })
  }
  return <div className="meeting-member-picker" ref={root} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus() }
  }}>
    <button ref={trigger} type="button" className="member-trigger" aria-label={`负责人：${value?.displayName || '待分配'}`} aria-expanded={open} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(!open)}>
      <Users size={14} aria-hidden="true" /><span>{value?.displayName || '待分配'}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open ? createPortal(<div ref={panel} style={position} className="member-panel" role="dialog" aria-label="选择企业成员">
      <div className="member-search"><Search size={15} aria-hidden="true" /><input autoFocus aria-label="搜索企业成员" placeholder="姓名 / 英文 / 全拼 / 首字母" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" aria-label="关闭成员选择" onClick={() => { setOpen(false); trigger.current?.focus() }}><X size={14} /></button></div>
      {loading ? <p role="status">正在读取企业通讯录…</p> : error ? <p role="alert">{error}<button type="button" onClick={onRetry}>重新加载</button></p> : <>
        <div className="member-directory">
          <nav aria-label="部门树"><button type="button" aria-pressed={!department} onClick={() => { setDepartment(''); setQuery('') }}>全部成员</button>{tree(null)}</nav>
          <div className="member-results" aria-label="员工列表">
            <button type="button" className="member-option" onClick={() => choose(null)}>暂不分配</button>
            {visible.map(({ user }) => <button type="button" className="member-option" key={user.feishuUserId || user.userId} onClick={() => choose(user)}>
              <strong>{user.displayName}{user.englishName ? ` · ${user.englishName}` : ''}</strong><small>{user.departmentIds?.map(id => departments.find(d => d.id === id)?.name).filter(Boolean).join(' / ')}</small>
            </button>)}
            {!visible.length ? <p>没有匹配的成员</p> : null}
          </div>
        </div><p className="member-scope">{notice}</p>
      </>}
    </div>, document.body) : null}
  </div>
}
