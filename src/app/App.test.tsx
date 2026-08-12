import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UserRole } from '../../shared/domain/enums.js'
import App from './App'

const users = [
  { id: 'USR-EMPLOYEE', name: '演示员工', role: 'EMPLOYEE' as const },
  { id: 'USR-OWNER', name: '知识负责人', role: 'OWNER' as const },
  { id: 'USR-ADMIN', name: '系统管理员', role: 'ADMIN' as const },
]

function sessionResponse(role: UserRole) {
  const user = users.find((item) => item.role === role)
  if (!user) throw new Error('Missing test user')
  return { session: { userId: user.id, role }, user, users }
}

function mockSession(role: UserRole) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    let body: unknown = sessionResponse(role)
    if (url.startsWith('/api/reviews/')) body = {
      review: {
        id: 'RVW-DEMO', title: '演示审核', reviewType: 'NEW', risk: 'LOW', status: 'PENDING',
        reviewerId: 'USR-OWNER', createdAt: '2026-08-11T12:00:00.000Z',
      },
      allowedActions: [],
    }
    if (url === '/api/reviews') body = { reviews: [] }
    if (url.startsWith('/api/knowledge/')) body = {
      knowledge: {
        id: 'KNW-DEMO', title: '演示知识', content: '演示内容', category: 'OTHER', tags: [],
        authority: 'L0', ownerId: 'USR-OWNER', primaryAssetId: 'AST-DEMO', supportingAssetIds: [],
        sourceLocator: 'paragraph:1', status: 'ACTIVE', version: 1,
        lastVerifiedAt: '2026-08-11T12:00:00.000Z', aiEnabled: true, indexStatus: 'INDEXED',
        createdAt: '2026-08-11T12:00:00.000Z', updatedAt: '2026-08-11T12:00:00.000Z',
      },
      primaryAsset: { id: 'AST-DEMO', title: '演示资料', sections: [] },
      supportingAssets: [],
      history: [],
    }
    if (url === '/api/knowledge' || url.startsWith('/api/knowledge?')) body = { knowledge: [] }
    if (url === '/api/assets') body = { assets: [] }
    if (url.startsWith('/api/assets/')) body = {
      asset: {
        id: 'AST-DEMO', title: '演示资料', businessType: 'OTHER', authority: 'L0',
        ownerId: 'USR-OWNER', processStatus: 'NEW', sections: [],
      },
      candidates: [],
      reviews: [],
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
}

function renderAt(path: string, role: UserRole) {
  window.history.pushState({}, '', path)
  mockSession(role)
  return render(<App />)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.pushState({}, '', '/')
})

describe('role-aware application routes', () => {
  it('sends an Employee from the root to Knowledge AI without factory navigation', async () => {
    renderAt('/', 'EMPLOYEE')

    expect(await screen.findByRole('heading', { level: 1, name: '知识问答' })).toBeInTheDocument()
    expect(document.querySelector('.product-shell')).toHaveClass('chat-mode')
    expect(screen.queryByText('Knowledge Factory')).not.toBeInTheDocument()
    expect(window.location.pathname).toBe('/chat')
  })

  it('lets an Owner open the Knowledge Factory', async () => {
    renderAt('/factory', 'OWNER')

    expect(await screen.findByRole('heading', { level: 1, name: '工作台' })).toBeInTheDocument()
    expect(screen.getByText('Knowledge Factory')).toBeInTheDocument()
  })

  it('shows a not-found page for unknown routes', async () => {
    renderAt('/missing', 'OWNER')

    expect(await screen.findByRole('heading', { level: 1, name: '页面不存在' })).toBeInTheDocument()
  })

  it.each([
    ['/chat', 'EMPLOYEE', '知识问答'],
    ['/factory', 'OWNER', '工作台'],
    ['/factory/assets', 'OWNER', '资料'],
    ['/factory/assets/AST-DEMO', 'OWNER', '资料详情'],
    ['/factory/reviews', 'OWNER', '审核'],
    ['/factory/reviews/RVW-DEMO', 'OWNER', '审核详情'],
    ['/factory/knowledge', 'OWNER', '知识'],
    ['/factory/knowledge/KNW-DEMO', 'OWNER', '知识详情'],
  ] as const)('renders one page heading at %s', async (path, role, heading) => {
    renderAt(path, role)

    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })
})
