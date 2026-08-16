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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')

  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
  })
  const body = await response.json().catch(() => ({})) as {
    error?: { code?: string; message?: string }
    detail?: { code?: string; message?: string } | string
  }
  if (!response.ok) {
    const detail = typeof body.detail === 'object' ? body.detail : undefined
    throw new ApiError(
      body.error?.code ?? detail?.code ?? 'UNKNOWN_ERROR',
      body.error?.message ?? detail?.message ?? (typeof body.detail === 'string' ? body.detail : '请求失败'),
      response.status,
    )
  }
  return body as T
}
