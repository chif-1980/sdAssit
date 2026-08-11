import { Bot, Database, RefreshCw } from 'lucide-react'
import { Link, Outlet, useLocation } from 'react-router-dom'

import type { UserRole } from '../../../shared/domain/enums.js'
import { useSession } from '../../session/SessionProvider'
import { FactoryNav } from './FactoryNav'

export function ProductShell() {
  const location = useLocation()
  const { status, user, users, switchRole, reload } = useSession()
  const canUseFactory = user?.role === 'OWNER' || user?.role === 'ADMIN'
  const inFactory = location.pathname.startsWith('/factory') && canUseFactory

  if (status === 'loading') {
    return <main className="center-state" aria-label="正在加载"><span className="spinner" /></main>
  }

  if (status === 'error' || !user) {
    return (
      <main className="center-state">
        <h1>暂时无法加载</h1>
        <button type="button" onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" size={17} />
          重新加载
        </button>
      </main>
    )
  }

  return (
    <div className={inFactory ? 'product-shell factory-mode' : 'product-shell'}>
      <header className="topbar">
        <Link className="brand" to="/chat" aria-label="Knowledge AI">
          <span className="brand-mark"><Bot aria-hidden="true" size={18} /></span>
          <span>Knowledge AI</span>
        </Link>
        <nav className="product-nav" aria-label="产品">
          <Link to="/chat">知识问答</Link>
          {canUseFactory ? <Link to="/factory"><Database aria-hidden="true" size={16} />Knowledge Factory</Link> : null}
        </nav>
        <label className="role-switcher">
          <span>身份</span>
          <select
            aria-label="演示身份"
            value={user.role}
            onChange={(event) => void switchRole(event.target.value as UserRole)}
          >
            {users.map((item) => <option key={item.id} value={item.role}>{item.name}</option>)}
          </select>
        </label>
      </header>
      {inFactory ? <aside className="factory-sidebar"><FactoryNav /></aside> : null}
      <main className="page-content"><Outlet /></main>
    </div>
  )
}
