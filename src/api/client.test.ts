import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, ApiError } from './client'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('api client', () => {
  it('includes cookies without declaring JSON for a request without a body', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await api('/api/auth/logout', { method: 'POST' })

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({
      credentials: 'include',
    }))
    const request = fetchMock.mock.calls[0][1] as RequestInit
    const headers = new Headers(request.headers)
    expect(headers.has('content-type')).toBe(false)
    expect(headers.has('authorization')).toBe(false)
  })

  it('includes cookies and declares JSON when the request has a body', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await api('/api/chat/conversations', { method: 'POST', body: JSON.stringify({}) })

    expect(fetchMock).toHaveBeenCalledWith('/api/chat/conversations', expect.objectContaining({
      credentials: 'include',
    }))
    const request = fetchMock.mock.calls[0][1] as RequestInit
    const headers = new Headers(request.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.has('authorization')).toBe(false)
  })

  it('throws a product API error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: { code: 'SESSION_EXPIRED', message: '登录已过期' },
    }, 401)))

    const request = api('/api/session')
    await expect(request).rejects.toBeInstanceOf(ApiError)
    await expect(request).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
      message: '登录已过期',
      status: 401,
    })
  })

  it('reads a structured FastAPI detail error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      detail: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用' },
    }, 503)))

    const request = api('/api/session')
    await expect(request).rejects.toBeInstanceOf(ApiError)
    await expect(request).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: '服务暂不可用',
      status: 503,
    })
  })

  it('uses a string FastAPI detail as the error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: '请求参数无效' }, 422)))

    const request = api('/api/session')
    await expect(request).rejects.toBeInstanceOf(ApiError)
    await expect(request).rejects.toMatchObject({
      code: 'UNKNOWN_ERROR',
      message: '请求参数无效',
      status: 422,
    })
  })
})
