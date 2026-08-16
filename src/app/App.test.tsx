import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App'

const productUser = {
  id: 'USR-1',
  name: '陈晨',
  avatarUrl: null,
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockApi(sessionBody: unknown, sessionStatus = 200) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const path = String(input)
    if (path === '/api/session') return jsonResponse(sessionBody, sessionStatus)
    if (path === '/api/chat/conversations') return jsonResponse({ conversations: [] })
    if (path === '/api/auth/logout') return jsonResponse({})
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderAt(path: string) {
  window.history.pushState({}, '', path)
  return render(<App />)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.pushState({}, '', '/')
})

describe('authenticated product routes', () => {
  it('shows a stable loading state while authentication is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))

    renderAt('/chat')

    expect(screen.getByLabelText('正在加载')).toBeInTheDocument()
  })

  it.each(['/chat', '/', '/missing'])('routes an anonymous user from %s to login', async (path) => {
    mockApi({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } }, 401)

    renderAt(path)

    expect(await screen.findByRole('link', { name: '使用飞书登录' })).toHaveAttribute(
      'href',
      '/api/auth/feishu/login?return_path=%2Fchat',
    )
    expect(window.location.pathname).toBe('/login')
  })

  it('renders the real chat page for an authenticated user', async () => {
    const fetchMock = mockApi({ user: productUser })

    renderAt('/chat')

    expect(await screen.findByRole('textbox', { name: '问题' })).toBeInTheDocument()
    expect(screen.getByText('陈晨')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/演示身份|模型|Agent|智能体|Skill|知识库|回答范围|Factory|Knowledge Factory|@/iu)
    expect(fetchMock).toHaveBeenCalledWith('/api/session', expect.objectContaining({ credentials: 'include' }))
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/conversations', expect.objectContaining({ credentials: 'include' }))
    expect(window.location.pathname).toBe('/chat')
  })

  it.each(['/login', '/', '/missing'])('routes an authenticated user from %s to chat', async (path) => {
    mockApi({ user: productUser })

    renderAt(path)

    expect(await screen.findByRole('textbox', { name: '问题' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.pathname).toBe('/chat'))
  })
})
