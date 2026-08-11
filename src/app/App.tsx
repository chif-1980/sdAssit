import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'

import { ProductShell } from '../components/layout/ProductShell'
import { AssetDetailPage } from '../pages/AssetDetailPage'
import { AssetListPage } from '../pages/AssetListPage'
import { ChatPage } from '../pages/ChatPage'
import { FactoryWorkbenchPage } from '../pages/FactoryWorkbenchPage'
import { KnowledgeDetailPage } from '../pages/KnowledgeDetailPage'
import { KnowledgeListPage } from '../pages/KnowledgeListPage'
import { NotFoundPage } from '../pages/NotFoundPage'
import { ReviewDetailPage } from '../pages/ReviewDetailPage'
import { ReviewListPage } from '../pages/ReviewListPage'
import { SessionProvider, useSession } from '../session/SessionProvider'

function FactoryGuard() {
  const { user } = useSession()
  return user?.role === 'OWNER' || user?.role === 'ADMIN'
    ? <Outlet />
    : <Navigate to="/chat" replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route element={<ProductShell />}>
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route element={<FactoryGuard />}>
              <Route path="/factory" element={<FactoryWorkbenchPage />} />
              <Route path="/factory/assets" element={<AssetListPage />} />
              <Route path="/factory/assets/:assetId" element={<AssetDetailPage />} />
              <Route path="/factory/reviews" element={<ReviewListPage />} />
              <Route path="/factory/reviews/:reviewId" element={<ReviewDetailPage />} />
              <Route path="/factory/knowledge" element={<KnowledgeListPage />} />
              <Route path="/factory/knowledge/:knowledgeId" element={<KnowledgeDetailPage />} />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  )
}
