import { Archive, ClipboardCheck, LayoutDashboard } from 'lucide-react'
import { NavLink } from 'react-router-dom'

const links = [
  { to: '/factory', label: '工作台', icon: LayoutDashboard, end: true },
  { to: '/factory/assets', label: '资料', icon: Archive, end: false },
  { to: '/factory/reviews', label: '审核', icon: ClipboardCheck, end: false },
  { to: '/factory/knowledge', label: '知识', icon: Archive, end: false },
]

export function FactoryNav() {
  return (
    <nav className="factory-nav" aria-label="Knowledge Factory">
      {links.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end}>
          <Icon aria-hidden="true" size={17} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
