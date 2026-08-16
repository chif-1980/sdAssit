import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionProvider, useSession } from './SessionProvider'

const productUser = {
  id: 'USR-1',
  name: '陈晨',
  avatarUrl: 'https://example.com/avatar.png',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function SessionConsumer() {
  const { user, status, error, reload, logout } = useSession()

  return (
    <main>
      <output aria-label="会话状态">{status}</output>
      {user ? <span>{user.name}</span> : null}
      {error ? <span role="alert">{error.message}</span> : null}
      <output aria-label="退出能力">{typeof logout}</output>
      <button type="button" onClick={() => void reload()}>重新加载</button>
      <button type="button" onClick={() => void logout()}>退出登录</button>
    </main>
  )
}

function renderSession() {
  return render(
    <SessionProvider>
      <SessionConsumer />
    </SessionProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SessionProvider', () => {
  it('exposes a stable loading state while the session request is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))

    renderSession()

    expect(screen.getByLabelText('会话状态')).toHaveTextContent('loading')
  })

  it('loads an authenticated product user', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ user: productUser })))

    renderSession()

    await waitFor(() => expect(screen.getByLabelText('会话状态')).toHaveTextContent('authenticated'))
    expect(screen.getByText('陈晨')).toBeInTheDocument()
  })

  it('treats a 401 session response as anonymous without an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: { code: 'UNAUTHENTICATED', message: '请先登录' },
    }, 401)))

    renderSession()

    await waitFor(() => expect(screen.getByLabelText('会话状态')).toHaveTextContent('anonymous'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('exposes non-authentication failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用' },
    }, 503)))

    renderSession()

    await waitFor(() => expect(screen.getByLabelText('会话状态')).toHaveTextContent('error'))
    expect(screen.getByRole('alert')).toHaveTextContent('服务暂不可用')
  })

  it('reloads the current session', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        error: { code: 'UNAUTHENTICATED', message: '请先登录' },
      }, 401))
      .mockResolvedValueOnce(jsonResponse({ user: productUser }))
    vi.stubGlobal('fetch', fetchMock)
    renderSession()
    await waitFor(() => expect(screen.getByLabelText('会话状态')).toHaveTextContent('anonymous'))

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))

    await waitFor(() => expect(screen.getByLabelText('会话状态')).toHaveTextContent('authenticated'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('logs out and clears the authenticated session', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ user: productUser }))
      .mockResolvedValueOnce(jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    renderSession()
    await screen.findByText('陈晨')
    expect(screen.getByLabelText('退出能力')).toHaveTextContent('function')

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))

    await waitFor(() => expect(screen.getByLabelText('会话状态')).toHaveTextContent('anonymous'))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth/logout', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }))
    expect(screen.queryByText('陈晨')).not.toBeInTheDocument()
  })

  it('keeps the newest reload result when concurrent requests finish in reverse order', async () => {
    const olderReload = deferred<Response>()
    const newerReload = deferred<Response>()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } }, 401))
      .mockImplementationOnce(() => olderReload.promise)
      .mockImplementationOnce(() => newerReload.promise)
    vi.stubGlobal('fetch', fetchMock)
    renderSession()
    await waitFor(() => expect(screen.getByLabelText('会话状态')).toHaveTextContent('anonymous'))

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await act(async () => {
      newerReload.resolve(jsonResponse({ user: productUser }))
      await newerReload.promise
    })
    await waitFor(() => expect(screen.getByLabelText('会话状态')).toHaveTextContent('authenticated'))

    await act(async () => {
      olderReload.resolve(jsonResponse({ error: { code: 'SERVICE_UNAVAILABLE', message: '迟到错误' } }, 503))
      await olderReload.promise
    })

    expect(screen.getByLabelText('会话状态')).toHaveTextContent('authenticated')
    expect(screen.getByText('陈晨')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('ignores the first StrictMode request after effect cleanup', async () => {
    const staleRequest = deferred<Response>()
    const currentRequest = deferred<Response>()
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => currentRequest.promise)
    vi.stubGlobal('fetch', fetchMock)
    render(
      <StrictMode>
        <SessionProvider><SessionConsumer /></SessionProvider>
      </StrictMode>,
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    await act(async () => {
      currentRequest.resolve(jsonResponse({ user: productUser }))
      await currentRequest.promise
    })
    await waitFor(() => expect(screen.getByLabelText('会话状态')).toHaveTextContent('authenticated'))

    await act(async () => {
      staleRequest.resolve(jsonResponse({ error: { code: 'SERVICE_UNAVAILABLE', message: 'StrictMode 迟到错误' } }, 503))
      await staleRequest.promise
    })

    expect(screen.getByLabelText('会话状态')).toHaveTextContent('authenticated')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('invalidates a pending session request when logout starts', async () => {
    const staleSession = deferred<Response>()
    const pendingLogout = deferred<Response>()
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const path = String(input)
      if (path === '/api/session' && fetchMock.mock.calls.filter(([value]) => String(value) === '/api/session').length === 1) {
        return Promise.resolve(jsonResponse({ user: productUser }))
      }
      if (path === '/api/session') return staleSession.promise
      if (path === '/api/auth/logout') return pendingLogout.promise
      throw new Error(`Unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderSession()
    await screen.findByText('陈晨')

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    await act(async () => {
      staleSession.resolve(jsonResponse({ error: { code: 'SERVICE_UNAVAILABLE', message: '退出期间迟到错误' } }, 503))
      await staleSession.promise
    })
    expect(screen.getByLabelText('会话状态')).toHaveTextContent('loading')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await act(async () => {
      pendingLogout.resolve(jsonResponse({}))
      await pendingLogout.promise
    })
    await waitFor(() => expect(screen.getByLabelText('会话状态')).toHaveTextContent('anonymous'))
  })
})
