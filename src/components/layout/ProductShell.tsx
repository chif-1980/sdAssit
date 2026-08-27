import { LogOut } from 'lucide-react'
import { useState } from 'react'

import { useSession } from '../../session/SessionProvider'

interface ProductShellProps {
  children: React.ReactNode
  headerInert?: boolean
}

export function ProductShell({ children, headerInert = false }: ProductShellProps) {
  const { user, logout } = useSession()
  const [logoutPending, setLogoutPending] = useState(false)
  const [logoutFailed, setLogoutFailed] = useState(false)

  async function handleLogout() {
    if (logoutPending) return
    setLogoutPending(true)
    setLogoutFailed(false)
    try {
      await logout()
    } catch {
      setLogoutFailed(true)
    } finally {
      setLogoutPending(false)
    }
  }

  return (
    <div className="product-shell chat-mode">
      <header className="topbar assistant-topbar" {...(headerInert ? { inert: '' } : {})}>
        <div className="assistant-brand">
          <span className="assistant-brand-mark" aria-hidden="true">
            <img src="/quickdone-mark.webp" alt="" />
          </span>
          <h1>企业知识助手</h1>
        </div>
        {user ? (
          <div className="current-user">
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" />
            ) : (
              <span className="user-avatar" aria-hidden="true">{user.name.trim().charAt(0)}</span>
            )}
            <span className="user-name">{user.name}</span>
            {logoutFailed ? <span className="logout-error" role="alert">退出失败，请重试</span> : null}
            <button
              type="button"
              className="icon-button logout-button"
              aria-label="退出登录"
              title="退出登录"
              disabled={logoutPending}
              onClick={() => void handleLogout()}
            >
              <LogOut aria-hidden="true" size={17} />
            </button>
          </div>
        ) : null}
      </header>
      <main className="page-content">{children}</main>
    </div>
  )
}
