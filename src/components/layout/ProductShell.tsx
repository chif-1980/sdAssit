import { LogOut } from 'lucide-react'

import { useSession } from '../../session/SessionProvider'

export function ProductShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useSession()

  return (
    <div className="product-shell chat-mode">
      <header className="topbar assistant-topbar">
        <h1>企业知识助手</h1>
        {user ? (
          <div className="current-user">
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" />
            ) : (
              <span className="user-avatar" aria-hidden="true">{user.name.trim().charAt(0)}</span>
            )}
            <span className="user-name">{user.name}</span>
            <button
              type="button"
              className="icon-button logout-button"
              aria-label="退出登录"
              title="退出登录"
              onClick={() => void logout()}
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
