export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string }
  detail?: { code?: string; message?: string } | string
}

function apiError(body: ErrorBody, status: number, fallback = '请求失败') {
  const detail = typeof body.detail === 'object' ? body.detail : undefined
  return new ApiError(
    body.error?.code ?? detail?.code ?? 'UNKNOWN_ERROR',
    body.error?.message ?? detail?.message ?? (typeof body.detail === 'string' ? body.detail : fallback),
    status,
  )
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  const requestBody = init?.body
  const isFormData = typeof FormData !== 'undefined' && requestBody instanceof FormData
  const isBlob = typeof Blob !== 'undefined' && requestBody instanceof Blob
  const isUrlEncoded = typeof URLSearchParams !== 'undefined' && requestBody instanceof URLSearchParams
  if (requestBody !== undefined && !isFormData && !isBlob && !isUrlEncoded && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
  })
  const responseBody = await response.json().catch(() => ({})) as ErrorBody
  if (!response.ok) {
    throw apiError(responseBody, response.status)
  }
  return responseBody as T
}

interface StreamApiOptions<TProgress> {
  onProgress: (progress: TProgress) => void
  onDelta?: (content: string) => void
}

interface SseEvent {
  event: string
  data: string
}

function parseSseEvent(block: string): SseEvent | undefined {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const rawValue = separator === -1 ? '' : line.slice(separator + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
    if (field === 'event') event = value
    if (field === 'data') data.push(value)
  }
  if (!data.length) return undefined
  return { event, data: data.join('\n') }
}

export async function streamApi<TComplete, TProgress>(
  path: string,
  init: RequestInit,
  options: StreamApiOptions<TProgress>,
): Promise<TComplete> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
  headers.set('accept', 'text/event-stream')

  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ErrorBody
    throw apiError(body, response.status)
  }
  if (!response.body) {
    throw new ApiError('STREAM_PROTOCOL_ERROR', '知识服务未返回回答', response.status)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let complete: TComplete | undefined
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined)
  }
  if (init.signal) {
    if (init.signal.aborted) {
      cancelReader()
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    init.signal.addEventListener('abort', cancelReader, { once: true })
  }

  const handleBlock = (block: string) => {
    const parsed = parseSseEvent(block)
    if (!parsed) return
    let payload: unknown
    try {
      payload = JSON.parse(parsed.data)
    } catch {
      throw new ApiError('STREAM_PROTOCOL_ERROR', '知识服务返回了无法识别的内容', response.status)
    }
    if (parsed.event === 'progress') {
      options.onProgress(payload as TProgress)
    } else if (parsed.event === 'delta') {
      const delta = payload as { content?: unknown }
      if (typeof delta.content === 'string') options.onDelta?.(delta.content)
    } else if (parsed.event === 'complete') {
      complete = payload as TComplete
    } else if (parsed.event === 'error') {
      const error = payload as { code?: string; message?: string }
      throw new ApiError(
        error.code ?? 'KNOWLEDGE_SERVICE_UNAVAILABLE',
        error.message ?? '知识服务暂时不可用，请稍后重试',
        response.status,
      )
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (init.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      buffer += decoder.decode(value, { stream: !done })
      let separator = buffer.match(/\r\n\r\n|\n\n|\r\r/)
      while (separator?.index !== undefined) {
        const index = separator.index
        handleBlock(buffer.slice(0, index))
        buffer = buffer.slice(index + separator[0].length)
        separator = buffer.match(/\r\n\r\n|\n\n|\r\r/)
      }
      if (done) break
    }
    if (buffer.trim()) handleBlock(buffer)
    if (complete === undefined) {
      throw new ApiError('STREAM_INCOMPLETE', '回答连接意外中断，请重试', response.status)
    }
    return complete
  } finally {
    init.signal?.removeEventListener('abort', cancelReader)
  }
}
