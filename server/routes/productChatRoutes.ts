import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { ProductChatService } from '../application/productChatService.js'
import type { PlatformRepository } from '../application/ports.js'
import { YuxiAgentClient, YuxiAgentClientError, type YuxiRequestCredentials } from '../adapters/yuxiAgentClient.js'
import { ulid } from 'ulid'

const emptyBody = z.object({}).strict()
const messageBody = z.object({
  content: z.string().trim().min(1).max(12000),
  mode: z.enum(['CONCISE', 'DETAILED']).optional(),
  attachmentIds: z.array(z.string().min(1)).max(5).optional(),
  requestId: z.string().trim().min(1).max(128).optional(),
  skillId: z.enum(['MATERIAL_SEARCH', 'SOLUTION_DRAFT', 'MEETING_ANALYSIS']).optional(),
}).strict()
type MessageInput = z.infer<typeof messageBody>
const resumeBody = z.object({
  answer: z.unknown(),
  requestId: z.string().trim().min(1).max(128).optional(),
}).strict()
type ResumeInput = z.infer<typeof resumeBody>
const materialSearchQuery = z.object({ q: z.string().trim().max(200).optional() }).strict()
const distributionBody = z.object({
  channel: z.enum(['WECHAT', 'FEISHU', 'DINGTALK']),
}).strict()
const feedbackBody = z.object({
  rating: z.enum(['LIKE', 'DISLIKE']).nullable(),
  reasonType: z.enum(['CONTENT_ERROR', 'OUTDATED', 'MISSING_SOURCE', 'CITATION_ERROR', 'OTHER']).optional(),
  reasonText: z.string().trim().max(2000).optional(),
}).strict()

// The composer keeps its existing attachment affordance for the later
// solution/meeting phases. Register a lightweight multipart parser now so a
// phase-1 upload receives an intentional, machine-readable response instead
// of Fastify's generic 415 error.
const multipartContentType = /^multipart\/form-data(?:;.*)?$/u
type LocalRun = { runId: string; conversationId: string; skillId?: MessageInput['skillId']; status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'; events: Array<{ event: string; payload: unknown; seq?: string }>; result?: unknown }
const localRuns = new Map<string, LocalRun>()

export function buildSolutionResumeContent(rootInput: string, answers: readonly string[]) {
  const normalizedRoot = rootInput.trim()
  const normalizedAnswers = answers.map((answer) => answer.trim()).filter(Boolean)
  if (!normalizedAnswers.length) return normalizedRoot
  return `${normalizedRoot}\n\n补充信息：\n${normalizedAnswers.join('\n')}`
}

function parseMultipartFile(body: Buffer, contentType: string) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType)?.[1]
    ?? /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType)?.[2]
  if (!boundary) throw new Error('INVALID_REQUEST')
  const marker = Buffer.from(`--${boundary}`)
  const start = body.indexOf(Buffer.from('filename='))
  if (start < 0) throw new Error('INVALID_REQUEST')
  const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start)
  if (headerEnd < 0) throw new Error('INVALID_REQUEST')
  const header = body.subarray(body.lastIndexOf(Buffer.from('\r\n'), start) + 2, headerEnd).toString('utf8')
  const filenameMatch = /filename="([^"]*)"/iu.exec(header)
  if (!filenameMatch?.[1]) throw new Error('INVALID_REQUEST')
  const name = filenameMatch[1]
  const mimeType = /content-type:\s*([^\r\n]+)/iu.exec(header)?.[1]?.trim() || 'application/octet-stream'
  const contentStart = headerEnd + 4
  const contentEnd = body.indexOf(marker, contentStart)
  if (contentEnd < 0) throw new Error('INVALID_REQUEST')
  const content = body.subarray(contentStart, Math.max(contentStart, contentEnd - 2))
  if (content.byteLength > 20 * 1024 * 1024) throw new Error('ATTACHMENT_TOO_LARGE')
  return { name, mimeType, content }
}

function invalidRequest() {
  return new Error('INVALID_REQUEST')
}

function writeEvent(raw: NodeJS.WritableStream, event: string, payload: unknown, eventId?: string) {
  raw.write(`${eventId ? `id: ${eventId}\n` : ''}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function runErrorPayload(error: unknown, runId: string | undefined, fallback = '方案草稿生成失败，请重试') {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const code = typeof value.code === 'string' ? value.code : 'AGENT_RUN_FAILED'
  const message = error instanceof Error && error.message && !/^[A-Z][A-Z0-9_]*$/u.test(error.message)
    ? error.message
    : fallback
  return {
    code,
    message,
    ...(runId ? { runId } : {}),
    retryable: value.retryable !== false,
  }
}

type AgentProgress = {
  stage?: string
  message?: string
  error?: string
  errorCode?: string
  retryable?: boolean
  runId?: string
  interrupt?: string
  terminalStatus?: string
  delta?: string
}

const solutionStreamFields = new Set([
  'title',
  'customer_context',
  'executive_summary',
  'content_markdown',
  'text',
  'claim',
  'applicability',
  'description',
])

type SolutionStreamState = {
  rawOutput: string
  fieldEmitted: Map<number, number>
}

export function createSolutionStreamState(): SolutionStreamState {
  return { rawOutput: '', fieldEmitted: new Map() }
}

/**
 * Pull only text from the structured Blueprint fields. LangGraph can emit a
 * partial JSON document, so forwarding the raw token stream would expose
 * braces, field names and tool payloads to the browser.
 */
export function solutionSafeStreamDelta(content: string, state: SolutionStreamState): string {
  if (!content) return ''
  state.rawOutput += content
  const chunks: Array<{ start: number; value: string }> = []
  const fieldPattern = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"/gu
  for (const match of state.rawOutput.matchAll(fieldPattern)) {
    const field = match[1]
    const start = (match.index ?? 0) + match[0].length
    if (!solutionStreamFields.has(field)) continue
    let end = start
    let escaped = false
    while (end < state.rawOutput.length) {
      const char = state.rawOutput[end]
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') break
      end += 1
    }
    const fragment = state.rawOutput.slice(start, end)
    let decoded = ''
    for (let length = fragment.length; length >= Math.max(0, fragment.length - 3); length -= 1) {
      try {
        const value = JSON.parse(`"${fragment.slice(0, length)}"`) as unknown
        if (typeof value === 'string') {
          decoded = value
          break
        }
      } catch {
        // A trailing partial escape is expected while the model is streaming.
      }
    }
    const previous = state.fieldEmitted.get(start) ?? 0
    if (decoded.length > previous) {
      chunks.push({ start, value: decoded.slice(previous) })
      state.fieldEmitted.set(start, decoded.length)
    }
  }
  chunks.sort((left, right) => left.start - right.start)
  return chunks.map((chunk) => chunk.value).join('')
}

const solutionStreamBoundary = /[\n。！？；：,.!?;:]/u
const solutionStreamChunkMaxChars = 64
const solutionStreamChunkMinChars = 18

/** Split a large runtime delta so each visible update can paint independently. */
export function splitSolutionStreamText(content: string, maxChars = solutionStreamChunkMaxChars): string[] {
  if (!content) return []
  const chunks: string[] = []
  let remaining = content
  while (remaining.length > maxChars) {
    let cut = maxChars
    for (let index = maxChars; index >= Math.min(solutionStreamChunkMinChars, maxChars); index -= 1) {
      if (solutionStreamBoundary.test(remaining[index - 1] ?? '')) {
        cut = index
        break
      }
    }
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut)
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

async function writeSolutionStreamDelta(raw: NodeJS.WritableStream, content: string) {
  const chunks = splitSolutionStreamText(content)
  for (const [index, chunk] of chunks.entries()) {
    writeEvent(raw, 'delta', { content: chunk })
    // Yield to the socket between fragments. A short pause is only needed
    // when one Redis event contained a long aggregate; normal token events
    // keep their natural cadence.
    if (index < chunks.length - 1) await new Promise<void>((resolve) => setTimeout(resolve, 12))
  }
}

type ProgressEmissionState = {
  stage?: string
  message?: string
}

function createProgressEmissionState(): ProgressEmissionState {
  return {}
}

function localExecutionTrace(run: LocalRun) {
  const startedAt = new Date().toISOString()
  const steps: Array<Record<string, unknown>> = []
  for (const event of run.events) {
    if (event.event !== 'progress' || !event.payload || typeof event.payload !== 'object') continue
    const payload = event.payload as Record<string, unknown>
    const stage = typeof payload.stage === 'string' ? payload.stage : ''
    const message = typeof payload.message === 'string' ? payload.message : ''
    if (!stage || !message) continue
    const current = steps.at(-1)
    if (current?.stage === stage) {
      if (current.message === message) continue
      current.message = message
      continue
    }
    if (current && current.status === 'ACTIVE') current.status = 'COMPLETED'
    steps.push({ stage, label: stage, message, status: 'COMPLETED', startedAt, finishedAt: startedAt, elapsedMs: 0 })
  }
  return { status: run.status === 'CANCELLED' ? 'CANCELLED' : run.status === 'FAILED' ? 'FAILED' : run.status === 'RUNNING' ? 'RUNNING' : 'COMPLETED', startedAt, finishedAt: run.status === 'RUNNING' ? null : startedAt, elapsedMs: 0, steps }
}

function emitProgress(
  raw: NodeJS.WritableStream,
  progress: { stage: string; message: string },
  state: ProgressEmissionState,
  options: { preview?: boolean; runId?: string; persist?: (event: string, payload: unknown) => void } = {},
) {
  if (state.stage === progress.stage && state.message === progress.message) return false

  state.stage = progress.stage
  state.message = progress.message
  const payload = {
    ...progress,
    ...(options.runId ? { runId: options.runId } : {}),
    status: 'ACTIVE',
  }
  options.persist?.('progress', payload)
  writeEvent(raw, 'progress', payload)

  return true
}

function extractYuxiChunks(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== 'object') return []
  const envelope = data as Record<string, unknown>
  const payload = envelope.payload && typeof envelope.payload === 'object'
    ? envelope.payload as Record<string, unknown>
    : envelope
  const chunks: Record<string, unknown>[] = []
  if (payload.chunk && typeof payload.chunk === 'object') chunks.push(payload.chunk as Record<string, unknown>)
  if (Array.isArray(payload.items)) {
    chunks.push(...payload.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')))
  }
  return chunks
}

function extractYuxiMessageDelta(data: unknown): string {
  return extractYuxiChunks(data).map((chunk) => {
    const streamEvent = chunk.stream_event
    if (!streamEvent || typeof streamEvent !== 'object') return ''
    const value = (streamEvent as Record<string, unknown>).content
    return typeof value === 'string' ? value : ''
  }).join('')
}

const yuxiToolProgress: Record<string, { stage: string; message: string }> = {
  write_todos: { stage: 'REQUIREMENTS_ANALYSIS', message: '正在拆解需求并规划方案' },
  match_enterprise_capabilities: { stage: 'CAPABILITY_MATCHING', message: '正在匹配企业能力边界' },
  query_kb: { stage: 'RETRIEVING', message: '正在检索正式知识' },
  find_kb_document: { stage: 'RETRIEVING', message: '正在定位相关知识文档' },
  open_kb_document: { stage: 'RETRIEVING', message: '正在展开并阅读正式知识' },
  read_file: { stage: 'RETRIEVING', message: '正在读取方案方法或会话资料' },
  ocr_parse_file: { stage: 'RETRIEVING', message: '正在解析会话附件' },
  task: { stage: 'VERIFYING', message: '正在核验高风险事实与冲突' },
  ask_user_question: { stage: 'WAITING_FOR_INPUT', message: '等待补充方案所需信息' },
}

function yuxiProgressFromChunk(chunk: Record<string, unknown>) {
  const status = String(chunk.status ?? '')
  if (['ask_user_question_required', 'human_approval_required', 'interrupted'].includes(status)) {
    return { stage: 'WAITING_FOR_INPUT', message: '等待补充方案所需信息' }
  }

  const streamEvent = chunk.stream_event && typeof chunk.stream_event === 'object'
    ? chunk.stream_event as Record<string, unknown>
    : undefined
  const toolEvent = chunk.event && typeof chunk.event === 'object'
    ? chunk.event as Record<string, unknown>
    : undefined
  const toolData = toolEvent?.data && typeof toolEvent.data === 'object'
    ? toolEvent.data as Record<string, unknown>
    : undefined
  const toolName = streamEvent && ['tool_call', 'tool_call_delta'].includes(String(streamEvent.type ?? ''))
    ? String(streamEvent.name ?? '').trim()
    : String(toolData?.tool_name ?? toolData?.name ?? '').trim()
  if (toolName) {
    return yuxiToolProgress[toolName] ?? { stage: 'UNDERSTANDING', message: '正在执行方案所需操作' }
  }
  if (streamEvent?.type === 'message_delta' && typeof streamEvent.content === 'string' && streamEvent.content) {
    return { stage: 'COMPOSING', message: '正在生成方案蓝图' }
  }
  return undefined
}

function yuxiProgress(event: { event: string; data: unknown }): AgentProgress | undefined {
  if (event.event === 'error') {
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
    return {
      error: String(data.message ?? '方案运行暂时不可用'),
      errorCode: typeof data.code === 'string' ? data.code : undefined,
      retryable: data.retryable !== false,
      runId: typeof data.run_id === 'string' ? data.run_id : undefined,
    }
  }
  if (event.event === 'interrupt') {
    const envelope = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
    const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : envelope
    const chunk = payload.chunk && typeof payload.chunk === 'object' ? payload.chunk as Record<string, unknown> : payload
    const questions = Array.isArray(chunk.questions) ? chunk.questions : []
    const question = questions.find((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).question === 'string') as Record<string, unknown> | undefined
    return { interrupt: String(question?.question ?? chunk.message ?? chunk.error_message ?? '请补充方案所需信息') }
  }
  if (event.event === 'end') {
    const envelope = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
    const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : envelope
    const status = String(payload.status ?? '')
    if (status && status !== 'completed') return { terminalStatus: status }
    return { stage: 'COMPOSING', message: '正在校验并保存方案草稿', terminalStatus: 'completed' }
  }
  const delta = extractYuxiMessageDelta(event.data)
  for (const chunk of extractYuxiChunks(event.data)) {
    const progress = yuxiProgressFromChunk(chunk)
    if (progress) return delta ? { ...progress, delta } : progress
  }
  return delta ? { delta } : undefined
}

function requestCredentials(request: { headers: { authorization?: string; cookie?: string } }): YuxiRequestCredentials {
  return {
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
  }
}

function safeFileName(title: string) {
  const normalized = title.replace(/[\\/:*?"<>|\u0000-\u001F]/gu, '-').trim() || 'material'
  return normalized.length > 180 ? normalized.slice(0, 180) : normalized
}

export function registerProductChatRoutes(app: FastifyInstance, repository: PlatformRepository) {
  const service = new ProductChatService(repository)
  const yuxi = new YuxiAgentClient()
  const solutionRuntime = (process.env.SOLUTION_DRAFT_RUNTIME ?? 'shadow').toLowerCase()

  async function createYuxiSolutionRun(
    conversationId: string,
    data: MessageInput,
    credentials: YuxiRequestCredentials,
  ) {
    const threadId = `product-${conversationId}`
    const session = await repository.read()
    await yuxi.ensureThread(threadId, session.session.userId, credentials)
    const yuxiAttachmentIds: string[] = []
    for (const attachmentId of data.attachmentIds ?? []) {
      const file = await service.attachmentFile(conversationId, attachmentId)
      yuxiAttachmentIds.push(await yuxi.uploadAttachment(threadId, file, credentials))
    }
    return yuxi.createRun({
      query: data.content.replace(/(^|\s)@做方案(?=\s|$)/gu, '$1').trim() || data.content,
      agentSlug: 'solution-draft',
      threadId,
      requestId: data.requestId,
      attachmentIds: yuxiAttachmentIds,
      productAttachmentIds: data.attachmentIds,
      userUid: session.session.userId,
      credentials,
    })
  }

  async function projectYuxiSolutionRun(
    conversationId: string,
    data: MessageInput,
    runId: string,
    credentials: YuxiRequestCredentials,
  ) {
    const result = await yuxi.getResult(runId, credentials) as Record<string, unknown>
    const output = result.output
      ?? (result.result && typeof result.result === 'object' ? (result.result as Record<string, unknown>).output : undefined)
    const status = String(result.status ?? '')
    if (!['completed', 'succeeded', 'success'].includes(status.toLowerCase())) {
      throw new YuxiAgentClientError('方案运行未完成', 502, 'YUXI_RUN_FAILED')
    }
    const trace = result.execution_trace ?? result.executionTrace
    const candidate = output === undefined
      || (typeof output === 'string' && !output.trim())
      ? result
      : output
    const payload = trace && typeof trace === 'object'
      ? candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? { ...(candidate as Record<string, unknown>), execution_trace: trace }
        : { output: candidate, execution_trace: trace }
      : candidate
    return service.addAgentSolutionMessage(conversationId, data.content, data.attachmentIds ?? [], runId, payload)
  }

  async function remoteSolutionContext(runId: string, credentials: YuxiRequestCredentials) {
    let current = await yuxi.getRun(runId, credentials) as Record<string, unknown>
    let run = current.run && typeof current.run === 'object' ? current.run as Record<string, unknown> : current
    const resumeAnswers: string[] = []
    while (String(run.run_type ?? run.runType ?? '') === 'resume' && (run.created_by_run_id ?? run.createdByRunId)) {
      const rawAnswer = run.input_content ?? run.inputContent
      if (typeof rawAnswer === 'string' && rawAnswer.trim()) {
        try {
          const parsed = JSON.parse(rawAnswer)
          resumeAnswers.push(typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2))
        } catch {
          resumeAnswers.push(rawAnswer)
        }
      }
      current = await yuxi.getRun(String(run.created_by_run_id ?? run.createdByRunId), credentials) as Record<string, unknown>
      run = current.run && typeof current.run === 'object' ? current.run as Record<string, unknown> : current
    }
    const threadId = String(run.conversation_thread_id ?? run.threadId ?? '')
    const inputContent = String(run.input_content ?? run.inputContent ?? '').trim()
    const metadata = run.input_metadata && typeof run.input_metadata === 'object' ? run.input_metadata as Record<string, unknown> : {}
    const invocation = metadata.agent_invocation_meta && typeof metadata.agent_invocation_meta === 'object'
      ? metadata.agent_invocation_meta as Record<string, unknown>
      : {}
    const conversationId = String(invocation.product_conversation_id ?? threadId.replace(/^product-/u, '')).trim()
    if (!conversationId || !inputContent) throw new YuxiAgentClientError('方案运行缺少可恢复的会话上下文', 502, 'YUXI_CONTEXT_MISSING')
    const content = buildSolutionResumeContent(inputContent, resumeAnswers.reverse())
    const rawAttachmentIds = Array.isArray(invocation.product_attachment_ids)
      ? invocation.product_attachment_ids
      : (Array.isArray(metadata.attachment_file_ids) ? metadata.attachment_file_ids : [])
    const attachmentIds = rawAttachmentIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    return {
      conversationId,
      data: {
        content,
        skillId: 'SOLUTION_DRAFT' as const,
        attachmentIds,
        requestId: typeof run.request_id === 'string' ? run.request_id : undefined,
      },
    }
  }

  app.addContentTypeParser(
    multipartContentType,
    { parseAs: 'buffer', bodyLimit: 100 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  )

  app.get('/api/chat/skills', async () => service.skills())

  app.get('/api/chat/conversations', async () => ({ conversations: await service.listConversations() }))

  app.post('/api/chat/conversations', async (request, reply) => {
    const parsed = emptyBody.safeParse(request.body ?? {})
    if (!parsed.success) throw invalidRequest()
    return reply.status(201).send({ conversation: await service.createConversation() })
  })

  app.get<{ Params: { conversationId: string } }>('/api/chat/conversations/:conversationId', async (request) => {
    return service.detail(request.params.conversationId)
  })

  app.get<{ Params: { conversationId: string } }>('/api/chat/conversations/:conversationId/active-run', async (request) => {
    // detail() performs the same ownership check as the conversation API.
    await service.detail(request.params.conversationId)
    const local = [...localRuns.values()]
      .filter((run) => run.conversationId === request.params.conversationId
        && run.skillId === 'SOLUTION_DRAFT'
        && ['QUEUED', 'RUNNING'].includes(run.status))
      .at(-1)
    if (local) {
      return {
        run: {
          runId: local.runId,
          conversationId: local.conversationId,
          status: local.status,
          executionTrace: localExecutionTrace(local),
          streamUrl: `/api/chat/runs/${encodeURIComponent(local.runId)}/events`,
        },
      }
    }
    if (!yuxi.configured()) return { run: null }
    try {
      const remote = await yuxi.getActiveRun(`product-${request.params.conversationId}`, requestCredentials(request))
      if (!remote || (remote.agentSlug && remote.agentSlug !== 'solution-draft')) return { run: null }
      return {
        run: {
          runId: remote.runId,
          conversationId: request.params.conversationId,
          status: remote.status,
          inputContent: remote.inputContent,
          executionTrace: remote.executionTrace ?? {},
          streamUrl: `/api/chat/runs/${encodeURIComponent(remote.runId)}/events`,
        },
      }
    } catch {
      // A transient Yuxi outage should not make historical conversations
      // unreadable. The next explicit send will surface the actionable error.
      return { run: null }
    }
  })

  app.post<{ Params: { conversationId: string } }>('/api/chat/conversations/:conversationId/attachments', async (request, reply) => {
    const file = parseMultipartFile(request.body as Buffer, String(request.headers['content-type'] ?? ''))
    return reply.status(201).send({ attachment: await service.uploadAttachment(request.params.conversationId, file) })
  })

  app.post<{ Params: { conversationId: string } }>('/api/chat/conversations/:conversationId/messages', async (request, reply) => {
    const parsed = messageBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    if (parsed.data.skillId === 'SOLUTION_DRAFT' && solutionRuntime === 'enabled' && yuxi.configured()) {
      const run = await createYuxiSolutionRun(request.params.conversationId, parsed.data, requestCredentials(request))
      // The durable Agent Run remains the source of truth; this compatibility
      // endpoint waits for completion before returning the normal product DTO.
      for await (const _event of yuxi.streamEvents(run.runId, '0-0', requestCredentials(request))) { /* drain */ }
      return reply.status(201).send(await projectYuxiSolutionRun(request.params.conversationId, parsed.data, run.runId, requestCredentials(request)))
    }
    if (parsed.data.skillId === 'SOLUTION_DRAFT' && solutionRuntime === 'shadow' && yuxi.configured()) {
      void createYuxiSolutionRun(request.params.conversationId, parsed.data, requestCredentials(request)).then(async (run) => {
        for await (const _event of yuxi.streamEvents(run.runId, '0-0', requestCredentials(request))) { /* observe only */ }
      }).catch(() => undefined)
    }
    return reply.status(201).send(await service.addMessage(request.params.conversationId, parsed.data.content, parsed.data.skillId, parsed.data.attachmentIds, parsed.data.requestId))
  })

  app.post<{ Params: { conversationId: string } }>('/api/chat/conversations/:conversationId/messages/stream', async (request, reply) => {
    const parsed = messageBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    // Validate ownership and archive state before switching to an SSE response,
    // so ordinary HTTP errors keep their useful status codes.
    const existing = await service.detail(request.params.conversationId)
    if (existing.conversation.status !== 'ACTIVE') throw new Error('CONVERSATION_ARCHIVED')

    if (parsed.data.skillId === 'SOLUTION_DRAFT' && solutionRuntime === 'enabled' && yuxi.configured()) {
      const run = await createYuxiSolutionRun(request.params.conversationId, parsed.data, requestCredentials(request))
      reply.hijack()
      reply.raw.writeHead(200, {
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
      })
      try {
        writeEvent(reply.raw, 'run_started', { runId: run.runId, status: run.status ?? 'queued' })
        const progressState = createProgressEmissionState()
        emitProgress(reply.raw, { stage: 'UNDERSTANDING', message: '正在分析需求并规划方案' }, progressState, { preview: true, runId: run.runId })
        const streamState = createSolutionStreamState()
        let interruptedQuestion: string | undefined
        let terminalStatus = ''
        for await (const event of yuxi.streamEvents(run.runId, '0-0', requestCredentials(request))) {
          const progress = yuxiProgress(event)
          if (!progress) continue
          if (progress.error) {
            writeEvent(reply.raw, 'error', {
              code: progress.errorCode ?? 'YUXI_RUN_FAILED',
              message: progress.error,
              runId: progress.runId ?? run.runId,
              retryable: progress.retryable !== false,
            })
            reply.raw.end()
            return reply
          }
          if (progress.interrupt) interruptedQuestion = progress.interrupt
          if (progress.terminalStatus) terminalStatus = progress.terminalStatus
          if (progress.delta) {
            const safeDelta = solutionSafeStreamDelta(progress.delta, streamState)
            if (safeDelta) await writeSolutionStreamDelta(reply.raw, safeDelta)
          }
          if (progress.stage && progress.message) {
            emitProgress(reply.raw, { stage: progress.stage, message: progress.message }, progressState, { preview: true, runId: run.runId })
          }
        }
        if (terminalStatus === 'interrupted' || interruptedQuestion) {
          writeEvent(reply.raw, 'interrupt', { runId: run.runId, question: interruptedQuestion ?? '请补充方案所需信息', status: 'INTERRUPTED' })
          return reply
        }
        if (terminalStatus && terminalStatus !== 'completed') {
          writeEvent(reply.raw, 'error', runErrorPayload(undefined, run.runId, '方案运行未完成，请重试'))
          return reply
        }
        const result = await projectYuxiSolutionRun(request.params.conversationId, parsed.data, run.runId, requestCredentials(request))
        writeEvent(reply.raw, 'draft', result.assistantMessage.solutionDraft ?? {})
        writeEvent(reply.raw, 'complete', result)
      } catch (error) {
        writeEvent(reply.raw, 'error', runErrorPayload(error, run.runId))
      } finally {
        reply.raw.end()
      }
      return reply
    }

    if (parsed.data.skillId === 'SOLUTION_DRAFT' && solutionRuntime === 'shadow' && yuxi.configured()) {
      void createYuxiSolutionRun(request.params.conversationId, parsed.data, requestCredentials(request)).then(async (run) => {
        for await (const _event of yuxi.streamEvents(run.runId, '0-0', requestCredentials(request))) { /* observe only */ }
      }).catch(() => undefined)
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    })

    let activeRunId: string | undefined
    try {
      const runId = parsed.data.requestId ? `local-${parsed.data.requestId}` : `local-${ulid()}`
      activeRunId = runId
      const run: LocalRun = { runId, conversationId: request.params.conversationId, skillId: parsed.data.skillId, status: 'RUNNING', events: [] }
      localRuns.set(runId, run)
      // The local path is a compatibility fallback, not an Agent runtime. It
      // must not pretend that it performed retrieval, capability matching or
      // review stages that only Yuxi can actually execute. The real Yuxi
      // stream remains the source of any multi-stage execution trace.
      const progress = parsed.data.skillId === 'SOLUTION_DRAFT'
        ? [
          { stage: 'COMPOSING', message: '正在生成方案草稿' },
        ] as const
        : [
        { stage: 'UNDERSTANDING', message: '正在理解问题' },
        { stage: 'RETRIEVING', message: '正在检索已审核资料' },
        { stage: 'VERIFYING', message: '正在核验引用与权限' },
        { stage: 'COMPOSING', message: '正在组织回答' },
        ] as const
      writeEvent(reply.raw, 'run_started', { runId, status: run.status })
      const progressState = createProgressEmissionState()
      for (const item of progress) {
        emitProgress(reply.raw, item, progressState, {
          preview: parsed.data.skillId === 'SOLUTION_DRAFT',
          runId,
          persist: (event, payload) => {
            const seq = String(run.events.length + 1)
            run.events.push({ event, payload, seq })
          },
        })
        // Keep the local compatibility path observable as a stream. The real
        // Yuxi run naturally yields events over time; this small yield gives
        // the browser the same progressive experience when the fallback is in use.
        if (parsed.data.skillId === 'SOLUTION_DRAFT') {
          await new Promise((resolve) => setTimeout(resolve, 90))
        }
      }
      const result = await service.addMessage(request.params.conversationId, parsed.data.content, parsed.data.skillId, parsed.data.attachmentIds, parsed.data.requestId)
      run.status = 'SUCCEEDED'
      run.result = result
      if (parsed.data.skillId === 'SOLUTION_DRAFT') {
        const seq = String(run.events.length + 1)
        run.events.push({ event: 'draft', payload: result.assistantMessage.solutionDraft ?? {}, seq })
        writeEvent(reply.raw, 'draft', result.assistantMessage.solutionDraft ?? {}, seq)
      }
      const seq = String(run.events.length + 1)
      run.events.push({ event: 'complete', payload: result, seq })
      writeEvent(reply.raw, 'complete', result, seq)
    } catch (error) {
      const details = error && typeof error === 'object' ? error as Record<string, unknown> : {}
      const code = typeof details.code === 'string' ? details.code : error instanceof Error ? error.message : 'INTERNAL_ERROR'
      const message = code === 'CONVERSATION_ARCHIVED'
        ? '当前会话已归档，请恢复后再发送'
        : code === 'ATTACHMENTS_NOT_AVAILABLE'
          ? '当前阶段暂不支持附件处理'
          : code === 'AGENT_EMPTY_RESULT'
            ? 'Agent 未返回有效方案结果，请重试'
            : code === 'AGENT_MALFORMED_RESULT'
              ? '方案结果结构异常，请重试'
          : '知识服务暂时不可用，请稍后重试'
      const failedRun = activeRunId ? localRuns.get(activeRunId) : undefined
      if (failedRun) failedRun.status = 'FAILED'
      writeEvent(reply.raw, 'error', { code, message, ...(activeRunId ? { runId: activeRunId } : {}), retryable: code !== 'CONVERSATION_ARCHIVED' })
    } finally {
      reply.raw.end()
    }
  })

  app.post<{ Params: { runId: string } }>('/api/chat/runs/:runId/resume', async (request, reply) => {
    const parsed = resumeBody.safeParse(request.body)
    if (!parsed.success || parsed.data.answer === null || parsed.data.answer === undefined) throw invalidRequest()
    if (!yuxi.configured()) throw new Error('YUXI_NOT_CONFIGURED')
    const run = await yuxi.resumeRun(
      request.params.runId,
      parsed.data.answer,
      parsed.data.requestId,
      requestCredentials(request),
    )
    return reply.status(201).send({
      run: {
        runId: run.runId,
        threadId: run.threadId,
        status: run.status,
        requestId: run.requestId,
        streamUrl: `/api/chat/runs/${run.runId}/events`,
        resumedFromRunId: request.params.runId,
      },
    })
  })

  app.get<{ Params: { runId: string } }>('/api/chat/runs/:runId', async (request) => {
    const run = localRuns.get(request.params.runId)
    if (!run && !request.params.runId.startsWith('local-') && yuxi.configured()) {
      try {
        const remote = await yuxi.getRun(request.params.runId, requestCredentials(request)) as Record<string, unknown>
        const remoteRun = remote.run && typeof remote.run === 'object' ? remote.run as Record<string, unknown> : remote
        return {
          run: {
            runId: String(remoteRun.runId ?? remoteRun.run_id ?? request.params.runId),
            conversationId: undefined,
            status: remoteRun.status,
            requestId: remoteRun.requestId ?? remoteRun.request_id,
            executionTrace: remoteRun.executionTrace ?? remoteRun.execution_trace ?? {},
            inputContent: remoteRun.inputContent ?? remoteRun.input_content,
            streamUrl: `/api/chat/runs/${request.params.runId}/events`,
          },
        }
      } catch {
        // Fall through to the stable not-found response below.  A process
        // restart must not make a stale in-memory delegation flag decisive.
      }
    }
    if (!run) throw new Error('RUN_NOT_FOUND')
    return { run: { runId: run.runId, conversationId: run.conversationId, status: run.status, executionTrace: localExecutionTrace(run), streamUrl: `/api/chat/runs/${run.runId}/events` } }
  })

  app.get<{ Params: { runId: string } }>('/api/chat/runs/:runId/events', async (request, reply) => {
    const run = localRuns.get(request.params.runId)
    if (!run && !request.params.runId.startsWith('local-') && yuxi.configured()) {
      reply.hijack()
      reply.raw.writeHead(200, { 'cache-control': 'no-cache, no-transform', 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' })
      try {
        writeEvent(reply.raw, 'run_started', { runId: request.params.runId, status: 'running' })
        const progressState = createProgressEmissionState()
        const streamState = createSolutionStreamState()
        let interruptedQuestion: string | undefined
        let terminalStatus = ''
        for await (const event of yuxi.streamEvents(request.params.runId, String((request.query as { afterSeq?: string } | undefined)?.afterSeq ?? '0-0'), requestCredentials(request))) {
          const progress = yuxiProgress(event)
          if (!progress) continue
          if (progress.error) {
            writeEvent(reply.raw, 'error', {
              code: progress.errorCode ?? 'YUXI_RUN_FAILED',
              message: progress.error,
              runId: progress.runId ?? request.params.runId,
              retryable: progress.retryable !== false,
            })
            return reply
          }
          if (progress.interrupt) interruptedQuestion = progress.interrupt
          if (progress.terminalStatus) terminalStatus = progress.terminalStatus
          if (progress.delta) {
            const safeDelta = solutionSafeStreamDelta(progress.delta, streamState)
            if (safeDelta) await writeSolutionStreamDelta(reply.raw, safeDelta)
          }
          if (progress.stage && progress.message) {
            emitProgress(reply.raw, { stage: progress.stage, message: progress.message }, progressState, { preview: true, runId: request.params.runId })
          }
        }
        if (terminalStatus === 'interrupted' || interruptedQuestion) {
          writeEvent(reply.raw, 'interrupt', { runId: request.params.runId, question: interruptedQuestion ?? '请补充方案所需信息', status: 'INTERRUPTED' })
          return reply
        }
        if (terminalStatus && terminalStatus !== 'completed') {
          writeEvent(reply.raw, 'error', runErrorPayload(undefined, request.params.runId, '方案运行未完成，请重试'))
          return reply
        }
        const context = await remoteSolutionContext(request.params.runId, requestCredentials(request))
        const result = await projectYuxiSolutionRun(context.conversationId, context.data, request.params.runId, requestCredentials(request))
        writeEvent(reply.raw, 'draft', result.assistantMessage.solutionDraft ?? {})
        writeEvent(reply.raw, 'complete', result)
      } finally {
        reply.raw.end()
      }
      return reply
    }
    if (!run) throw new Error('RUN_NOT_FOUND')
    reply.hijack()
    reply.raw.writeHead(200, { 'cache-control': 'no-cache, no-transform', 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' })
    writeEvent(reply.raw, 'run_started', { runId: run.runId, status: run.status })
    const afterSeq = String((request.query as { afterSeq?: string } | undefined)?.afterSeq ?? '0')
    const afterNumber = Number(afterSeq)
    for (const event of run.events) {
      if (Number.isFinite(afterNumber) && event.seq && Number(event.seq) <= afterNumber) continue
      writeEvent(reply.raw, event.event, event.payload, event.seq)
    }
    reply.raw.end()
  })

  app.post<{ Params: { runId: string } }>('/api/chat/runs/:runId/cancel', async (request) => {
    const run = localRuns.get(request.params.runId)
    if (!run && !request.params.runId.startsWith('local-') && yuxi.configured()) {
      return yuxi.cancelRun(request.params.runId, requestCredentials(request))
    }
    if (!run) throw new Error('RUN_NOT_FOUND')
    if (run.status === 'QUEUED' || run.status === 'RUNNING') run.status = 'CANCELLED'
    return { run: { runId: run.runId, status: run.status } }
  })

  app.get<{ Params: { draftId: string } }>('/api/chat/solution-drafts/:draftId', async (request) => ({
    draft: await service.getSolutionDraft(request.params.draftId),
  }))

  app.patch<{ Params: { draftId: string } }>('/api/chat/solution-drafts/:draftId', async (request) => ({
    draft: await service.updateSolutionDraft(request.params.draftId, request.body as Record<string, unknown>),
  }))

  app.post<{ Params: { conversationId: string } }>('/api/chat/conversations/:conversationId/archive', async (request, reply) => {
    await service.archive(request.params.conversationId)
    return reply.status(204).send()
  })

  app.post<{ Params: { conversationId: string } }>('/api/chat/conversations/:conversationId/restore', async (request, reply) => {
    return reply.send({ conversation: await service.restore(request.params.conversationId) })
  })

  app.get('/api/chat/materials/search', async (request) => {
    const parsed = materialSearchQuery.safeParse(request.query)
    if (!parsed.success) throw invalidRequest()
    return { materials: await service.searchMaterials(parsed.data.q) }
  })

  app.get<{ Params: { assetId: string } }>('/api/chat/materials/:assetId/download', async (request, reply) => {
    const result = await service.downloadMaterial(request.params.assetId)
    reply
      .type(result.mimeType)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(result.asset.title))}`)
      .header('cache-control', 'private, no-store')
    return reply.send(Buffer.from(result.content, 'utf8'))
  })

  app.post<{ Params: { assetId: string } }>('/api/chat/materials/:assetId/distributions', async (request, reply) => {
    const parsed = distributionBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    return reply.status(201).send(await service.createDistribution(request.params.assetId, parsed.data.channel))
  })

  app.put<{ Params: { messageId: string } }>('/api/chat/messages/:messageId/feedback', async (request) => {
    const parsed = feedbackBody.safeParse(request.body)
    if (!parsed.success) throw invalidRequest()
    return service.updateFeedback(request.params.messageId, parsed.data)
  })

  app.get<{ Params: { citationId: string } }>('/api/citations/:citationId', async (request) => {
    return service.resolveCitation(request.params.citationId)
  })

  app.get<{ Params: { citationId: string } }>('/api/citations/:citationId/open', async (request, reply) => {
    const result = await service.openCitation(request.params.citationId)
    return reply.code(307).header('location', result.sourceUrl).send()
  })
}
