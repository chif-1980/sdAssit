import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { ChatPage } from '../pages/ChatPage'
import { LoginPage } from '../pages/LoginPage'
import { PrototypePage } from '../pages/PrototypePage'
import { SessionProvider, useSession } from '../session/SessionProvider'
import { safeReturnPath } from '../session/returnPath'

function ProductRoutes() {
  const { status, reload, automaticLoginAllowed } = useSession()
  const location = useLocation()
  const returnPath = safeReturnPath(location.pathname === '/login'
    ? new URLSearchParams(location.search).get('return_path')
    : location.pathname + location.search)

  if (window.location.pathname === '/prototype') {
    return (
      <Routes>
        <Route path="/prototype" element={<PrototypePage />} />
        <Route path="*" element={<Navigate to="/prototype" replace />} />
      </Routes>
    )
  }

  if (status === 'loading') {
    return <main className="center-state" aria-label="正在加载"><span className="spinner" /></main>
  }

  if (status === 'error') {
    return (
      <main className="center-state" role="alert">
        <h1>暂时无法加载</h1>
        <button type="button" onClick={() => void reload()}>重新加载</button>
      </main>
    )
  }

  if (status === 'anonymous') {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage automaticLoginAllowed={automaticLoginAllowed} />} />
        <Route path="*" element={<Navigate to={`/login?return_path=${encodeURIComponent(returnPath)}`} replace />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="/chat" element={<ChatPage />} />
      <Route path="*" element={<Navigate to={returnPath} replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <ProductRoutes />
      </SessionProvider>
    </BrowserRouter>
  )
}
