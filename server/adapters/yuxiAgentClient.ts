import { randomUUID } from 'node:crypto'

export interface YuxiAgentRunInput {
  query: string
  agentSlug: string
  threadId: string
  requestId?: string
  attachmentIds?: string[]
  productAttachmentIds?: string[]
  userUid?: string
  credentials?: YuxiRequestCredentials
}

export interface YuxiRequestCredentials {
  /** The caller's existing bearer credential, never persisted or logged. */
  authorization?: string
  /** The caller's existing product session cookie, never persisted or logged. */
  cookie?: string
}

export interface YuxiAgentRun {
  runId: string
  threadId?: string
  status?: string
  requestId?: string
  streamUrl?: string
  executionTrace?: Record<string, unknown>
  inputContent?: string
  inputMetadata?: Record<string, unknown>
  agentSlug?: string
}

export class YuxiAgentClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code = 'YUXI_UNAVAILABLE',
  ) {
    super(message)
    this.name = 'YuxiAgentClientError'
  }
}

function env(name: string) {
  const value = process.env[name]?.trim()
  return value || undefined
}

function parseRun(value: unknown): YuxiAgentRun {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const run = record.run && typeof record.run === 'object' ? record.run as Record<string, unknown> : record
  const runId = String(run.runId ?? run.run_id ?? run.id ?? '')
  if (!runId) throw new YuxiAgentClientError('Yuxi 未返回运行编号', 502, 'YUXI_PROTOCOL_ERROR')
  return {
    runId,
    threadId: typeof (run.threadId ?? run.thread_id) === 'string' ? String(run.threadId ?? run.thread_id) : undefined,
    status: typeof run.status === 'string' ? run.status : undefined,
    requestId: typeof (run.requestId ?? run.request_id) === 'string' ? String(run.requestId ?? run.request_id) : undefined,
    streamUrl: typeof (run.streamUrl ?? run.stream_url) === 'string' ? String(run.streamUrl ?? run.stream_url) : undefined,
    executionTrace: (run.executionTrace ?? run.execution_trace) && typeof (run.executionTrace ?? run.execution_trace) === 'object'
      ? (run.executionTrace ?? run.execution_trace) as Record<string, unknown>
      : undefined,
    inputContent: typeof (run.inputContent ?? run.input_content) === 'string' ? String(run.inputContent ?? run.input_content) : undefined,
    inputMetadata: (run.inputMetadata ?? run.input_metadata) && typeof (run.inputMetadata ?? run.input_metadata) === 'object'
      ? (run.inputMetadata ?? run.input_metadata) as Record<string, unknown>
      : undefined,
    agentSlug: typeof (run.agentSlug ?? run.agent_slug) === 'string' ? String(run.agentSlug ?? run.agent_slug) : undefined,
  }
}

function parseSseBlock(block: string) {
  let event = 'message'
  let id: string | undefined
  const data: string[] = []
  for (const line of block.split(/\r\n|\n|\r/u)) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const value = (separator === -1 ? '' : line.slice(separator + 1)).replace(/^ /u, '')
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') data.push(value)
  }
  return data.length ? { event, id, data: data.join('\n') } : undefined
}

export class YuxiAgentClient {
  private readonly baseUrl = env('YUXI_BASE_URL')?.replace(/\/+$/u, '')
  private readonly agentSlug = env('YUXI_AGENT_SLUG') ?? 'solution-draft'

  configured() {
    return Boolean(this.baseUrl)
  }

  private headers(extra: HeadersInit = {}, credentials: YuxiRequestCredentials = {}) {
    const headers = new Headers(extra)
    headers.set('accept', 'application/json')
    if (credentials.authorization) {
      headers.set('authorization', credentials.authorization)
    } else if (credentials.cookie) {
      headers.set('cookie', credentials.cookie)
    } else {
      throw new YuxiAgentClientError(
        '无法确认当前用户身份，暂不能调用方案 Agent',
        401,
        'YUXI_IDENTITY_REQUIRED',
      )
    }
    return headers
  }

  private url(path: string) {
    if (!this.baseUrl) throw new YuxiAgentClientError('Yuxi 未配置', 503, 'YUXI_NOT_CONFIGURED')
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }

  private async json(path: string, init?: RequestInit, credentials: YuxiRequestCredentials = {}) {
    let response: Response
    try {
      response = await fetch(this.url(path), { ...init, headers: this.headers(init?.headers, credentials) })
    } catch (error) {
      if (error instanceof YuxiAgentClientError) throw error
      throw new YuxiAgentClientError(error instanceof Error ? error.message : 'Yuxi 网络连接失败', undefined)
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const detail = body.detail && typeof body.detail === 'object' ? body.detail as Record<string, unknown> : undefined
      const message = String(detail?.message ?? body.message ?? `Yuxi 请求失败（${response.status}）`)
      throw new YuxiAgentClientError(message, response.status, String(detail?.code ?? body.code ?? 'YUXI_REQUEST_FAILED'))
    }
    return body
  }

  async createRun(input: YuxiAgentRunInput): Promise<YuxiAgentRun> {
    const requestId = input.requestId || randomUUID()
    const body = {
      query: input.query,
      agent_slug: this.agentSlug,
      thread_id: input.threadId,
      meta: {
        request_id: requestId,
        source: 'product_chat_solution_draft',
        attachment_file_ids: input.attachmentIds ?? [],
        agent_invocation_meta: {
          product_conversation_id: input.threadId.replace(/^product-/u, ''),
          skill_id: 'SOLUTION_DRAFT',
          request_source: 'enterprise_assistant',
          ...(input.userUid ? { product_user_uid: input.userUid } : {}),
          ...(input.productAttachmentIds?.length ? { product_attachment_ids: input.productAttachmentIds } : {}),
        },
      },
    }
    return parseRun(await this.json('/api/agent/runs', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, input.credentials))
  }

  async ensureThread(threadId: string, userUid?: string, credentials: YuxiRequestCredentials = {}) {
    await this.json('/api/chat/thread', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: this.agentSlug,
        title: '方案草稿',
        thread_id: threadId,
        metadata: {
          source: 'product_chat',
          ...(userUid ? { product_user_uid: userUid } : {}),
        },
      }),
      headers: { 'content-type': 'application/json' },
    }, credentials)
  }

  async uploadAttachment(threadId: string, file: { name: string; mimeType: string; content: Buffer }, credentials: YuxiRequestCredentials = {}) {
    const form = new FormData()
    // Copy the Node buffer into a plain Uint8Array so DOM BlobPart typings remain
    // valid across the Node 22/TypeScript versions used by the server build.
    const bytes = new Uint8Array(file.content.byteLength)
    bytes.set(file.content)
    form.append('file', new Blob([bytes], { type: file.mimeType || 'application/octet-stream' }), file.name)
    const body = await this.json(`/api/chat/thread/${encodeURIComponent(threadId)}/attachments`, {
      method: 'POST',
      body: form,
      headers: { accept: 'application/json' },
    }, credentials)
    const record = body.attachment && typeof body.attachment === 'object' ? body.attachment as Record<string, unknown> : body
    const id = String(record.fileId ?? record.file_id ?? record.id ?? '')
    if (!id) throw new YuxiAgentClientError('Yuxi 未返回附件编号', 502, 'YUXI_PROTOCOL_ERROR')
    return id
  }

  async getRun(runId: string, credentials: YuxiRequestCredentials = {}) {
    return this.json(`/api/agent/runs/${encodeURIComponent(runId)}`, undefined, credentials)
  }

  async getActiveRun(threadId: string, credentials: YuxiRequestCredentials = {}): Promise<YuxiAgentRun | undefined> {
    const body = await this.json(`/api/agent/thread/${encodeURIComponent(threadId)}/active_run`, undefined, credentials)
    if (!body || typeof body !== 'object' || !('run' in body)) return undefined
    const run = (body as Record<string, unknown>).run
    if (!run) return undefined
    return parseRun(run)
  }

  async getResult(runId: string, credentials: YuxiRequestCredentials = {}) {
    return this.json(`/api/agent/runs/${encodeURIComponent(runId)}/result`, undefined, credentials)
  }

  async cancelRun(runId: string, credentials: YuxiRequestCredentials = {}) {
    return this.json(`/api/agent/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }, credentials)
  }

  async resumeRun(
    runId: string,
    answer: unknown,
    requestId?: string,
    credentials: YuxiRequestCredentials = {},
  ) {
    const body = { answer, ...(requestId ? { requestId } : {}) }
    return parseRun(await this.json(
      `/api/chat/runs/${encodeURIComponent(runId)}/resume`,
      { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
      credentials,
    ))
  }

  async *streamEvents(runId: string, afterSeq = '0-0', credentials: YuxiRequestCredentials = {}): AsyncGenerator<{ event: string; id?: string; data: unknown }> {
    let response: Response
    try {
      response = await fetch(this.url(`/api/agent/runs/${encodeURIComponent(runId)}/events?after_seq=${encodeURIComponent(afterSeq)}`), {
        headers: this.headers({ accept: 'text/event-stream' }, credentials),
      })
    } catch (error) {
      if (error instanceof YuxiAgentClientError) throw error
      throw new YuxiAgentClientError(error instanceof Error ? error.message : 'Yuxi 事件流连接失败')
    }
    if (!response.ok || !response.body) throw new YuxiAgentClientError(`Yuxi 事件流不可用（${response.status}）`, response.status)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        let separator = buffer.match(/\r\n\r\n|\n\n|\r\r/u)
        while (separator?.index !== undefined) {
          const block = buffer.slice(0, separator.index)
          buffer = buffer.slice(separator.index + separator[0].length)
          const parsed = parseSseBlock(block)
          if (parsed) {
            let data: unknown = parsed.data
            try { data = JSON.parse(parsed.data) } catch { /* keep text for protocol diagnostics */ }
            yield { event: parsed.event, id: parsed.id, data }
          }
          separator = buffer.match(/\r\n\r\n|\n\n|\r\r/u)
        }
        if (done) break
      }
      if (buffer.trim()) {
        const parsed = parseSseBlock(buffer)
        if (parsed) {
          let data: unknown = parsed.data
          try { data = JSON.parse(parsed.data) } catch { /* keep text */ }
          yield { event: parsed.event, id: parsed.id, data }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}
