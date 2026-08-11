import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from './client'

afterEach(() => vi.unstubAllGlobals())

describe('api client', () => {
  it('does not declare JSON for a request without a body', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await api('/api/assets/AST-1/process', { method: 'POST' })

    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(new Headers(request.headers).has('content-type')).toBe(false)
  })

  it('declares JSON when the request has a body', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await api('/api/conversations', { method: 'POST', body: JSON.stringify({ scope: 'ENTERPRISE' }) })

    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(new Headers(request.headers).get('content-type')).toBe('application/json')
  })
})
