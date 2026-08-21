import { describe, expect, it, vi } from 'vitest'

import { ApiError, streamApi } from './client'

function chunkedResponse(chunks: string[]) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('streamApi', () => {
  it('parses chunked CRLF events and joins multiple data lines', async () => {
    const onProgress = vi.fn()
    const onDelta = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => chunkedResponse([
      'event: progress\r\ndata: {"stage":"UNDER',
      'STANDING",\r\ndata: "message":"正在理解"}\r\n\r',
      '\nevent: delta\r\ndata: {"content":"第一',
      '段"}\r\n\r\nevent: delta\r\ndata: {"content":"第二段"}\r\n\r\n',
      '\nevent: complete\r\ndata: {"ok":',
      'true}\r\n\r\n',
    ])))

    const result = await streamApi<{ ok: boolean }, { stage: string; message: string }>(
      '/api/stream',
      { method: 'POST', body: '{}' },
      { onProgress, onDelta },
    )

    expect(onProgress).toHaveBeenCalledWith({ stage: 'UNDERSTANDING', message: '正在理解' })
    expect(onDelta.mock.calls.map(([content]) => content)).toEqual(['第一段', '第二段'])
    expect(result).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith('/api/stream', expect.objectContaining({
      credentials: 'include',
      headers: expect.any(Headers),
    }))
    vi.unstubAllGlobals()
  })

  it('turns an SSE error event into ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chunkedResponse([
      'event: error\ndata: {"code":"KB_UNAVAILABLE","message":"知识服务不可用"}\n\n',
    ])))

    await expect(streamApi('/api/stream', { method: 'POST' }, { onProgress: vi.fn() }))
      .rejects.toEqual(expect.objectContaining<ApiError>({
        name: 'ApiError',
        code: 'KB_UNAVAILABLE',
        message: '知识服务不可用',
        status: 200,
      }))
    vi.unstubAllGlobals()
  })
})
