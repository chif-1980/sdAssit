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
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify(sessionResponse(role)),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )))
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
