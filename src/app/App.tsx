import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { ChatPage } from '../pages/ChatPage'
import { LoginPage } from '../pages/LoginPage'
import { SessionProvider, useSession } from '../session/SessionProvider'

function ProductRoutes() {
  const { status, reload } = useSession()

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
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="/chat" element={<ChatPage />} />
      <Route path="*" element={<Navigate to="/chat" replace />} />
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
