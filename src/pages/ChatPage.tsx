import { Archive, ArchiveRestore, ArrowDown, BookOpen, MessageCircle, PanelLeft, Plus, RefreshCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  MaterialDistributionResponse,
  MaterialShareChannel,
} from '../../shared/api/materials.js'
import type {
  AnswerMode,
  FeedbackRating,
  FeedbackReasonType,
  ProductAnswerProgress,
  ProductAgentInterrupt,
  ProductAttachment,
  ProductCitation,
  ProductConversation,
  ProductMaterial,
  ProductMessage,
  SolutionDraftEditRequest,
  SolutionExecutionTrace,
} from '../../shared/api/product.js'
import { ApiError, api, streamApi } from '../api/client'
import { ChatComposer } from '../components/chat/ChatComposer'
import type { ComposerAttachment, ComposerMention } from '../components/chat/ChatComposer'
import { businessTasks, composerMentions, inferBusinessTask, type BusinessTask } from '../components/chat/businessTasks'
import { ConversationOutline } from '../components/chat/ConversationOutline'
import { MessageThread } from '../components/chat/MessageThread'
import { MaterialDistributionDialog } from '../components/chat/MaterialDistributionDialog'
import { canShareMaterialFiles, openShareApplication, shareMaterialViaDevice, type ShareApplicationOpenResult } from '../components/chat/materialSharing'
import { messagePairAnchorId } from '../components/chat/messagePairs'
import { SourceDrawer } from '../components/chat/SourceDrawer'
import { attachmentError as getAttachmentError } from '../components/chat/fileAttachments'
import { ProductShell } from '../components/layout/ProductShell'

interface ConversationDetail {
  conversation: ProductConversation
  messages: ProductMessage[]
}

interface SendResponse {
  conversation: ProductConversation
  userMessage: ProductMessage
  assistantMessage: ProductMessage
}

interface FeedbackResponse {
  messageId: string
  feedbackRating: FeedbackRating | null
  feedbackReasonType?: FeedbackReasonType | null
  feedbackReasonText?: string | null
}

const MAX_COMPOSER_ATTACHMENTS = 5

const exampleQuestions = [
  '投标一体机定价体系',
  '语音智控的技术架构',
] as const

const FALLBACK_CONVERSATION_TITLE = '未命名会话'

function normalizeInterrupt(value: unknown, runId?: string): ProductAgentInterrupt | undefined {
  if (!value || typeof value !== 'object') return undefined
  const payload = value as Record<string, unknown>
  const question = typeof payload.question === 'string' && payload.question.trim()
    ? payload.question.trim()
    : undefined
  if (!question) return undefined
  const type = payload.type === 'SINGLE_CHOICE' || payload.type === 'MULTIPLE_CHOICE' || payload.type === 'TEXT'
    ? payload.type
    : undefined
  const options = Array.isArray(payload.options)
    ? payload.options.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const option = item as Record<string, unknown>
      const id = typeof option.id === 'string' ? option.id : ''
      const label = typeof option.label === 'string' ? option.label : id
      return id && label ? [{ id, label, ...(typeof option.description === 'string' ? { description: option.description } : {}) }] : []
    })
    : undefined
  return {
    question,
    ...(typeof payload.questionId === 'string' ? { questionId: payload.questionId } : {}),
    ...(type ? { type } : {}),
    ...(options?.length ? { options } : {}),
    required: payload.required !== false,
    allowSkip: payload.allowSkip !== false,
    ...(typeof payload.position === 'number' ? { position: payload.position } : {}),
    ...(typeof payload.total === 'number' ? { total: payload.total } : {}),
    ...(runId ? { runId } : typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
    status: 'INTERRUPTED',
  }
}

function normalizeConversation(conversation: ProductConversation): ProductConversation {
  const title = typeof conversation.title === 'string' ? conversation.title.trim() : ''
  return { ...conversation, title: title || FALLBACK_CONVERSATION_TITLE }
}

function sortConversations(conversations: ProductConversation[]) {
  return conversations
    .map(normalizeConversation)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function upsertConversation(current: ProductConversation[], next: ProductConversation) {
  const existing = current.some((item) => item.id === next.id)
  return sortConversations(existing
    ? current.map((item) => item.id === next.id ? next : item)
    : [next, ...current])
}

function nextProgressTrail(
  current: ProductAnswerProgress[],
  progress: ProductAnswerProgress,
): ProductAnswerProgress[] {
  const currentProgress = current.at(-1)
  if (currentProgress?.stage === progress.stage) {
    if (
      currentProgress.message === progress.message
      && currentProgress.status === progress.status
      && currentProgress.runId === progress.runId
      && currentProgress.elapsedMs === progress.elapsedMs
    ) return current
    return [...current.slice(0, -1), progress]
  }
  return [...current, progress].slice(-24)
}

function attachmentUploadMessage(error: unknown) {
  if (error instanceof ApiError && error.code === 'ATTACHMENTS_NOT_AVAILABLE') {
    return '当前阶段暂不支持附件处理'
  }
  if (error instanceof ApiError && (error.status === 404 || error.code === 'NOT_FOUND')) {
    return '附件解析服务暂不可用，请稍后重试'
  }
  if (error instanceof Error && error.message && !/^[A-Z][A-Z0-9_]*$/u.test(error.message)) {
    return error.message
  }
  return '附件上传失败，请重试'
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
    || Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
}

/**
 * Keep solution-draft deltas observable when several SSE events arrive in one
 * network read. React 18 may batch synchronous updates from that read, so a
 * paint boundary is required between visible chunks.
 */
function yieldSolutionStreamPaint() {
  return new Promise<void>((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve())
      return
    }
    globalThis.setTimeout(resolve, 16)
  })
}

function triggerBlobDownload(blob: Blob, fileName: string) {
  if (typeof URL.createObjectURL !== 'function') return false
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = fileName || '资料'
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 0)
  return true
}

function formatMaterialSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '未知大小'
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function businessTaskFromMessages(items: ProductMessage[]): BusinessTask {
  const skillMessage = [...items].reverse().find((item) => item.role === 'ASSISTANT' && item.skillId)
  if (skillMessage?.skillId) return skillMessage.skillId
  // Conversations created before skill metadata was added can still restore
  // the material-search context from their persisted result cards.
  if ([...items].reverse().some((item) => item.role === 'ASSISTANT' && item.materials?.length)) return 'MATERIAL_SEARCH'
  return 'QA'
}

function knownSkillTokenSpans(value: string, mentions: readonly ComposerMention[]) {
  const values = mentions
    .map((mention) => mention.value)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  const spans: { start: number; end: number }[] = []

  for (let index = 0; index < value.length;) {
    if (index > 0 && !/\s/u.test(value[index - 1] ?? '')) {
      index += 1
      continue
    }
    const matched = values.find((mention) => (
      value.startsWith(mention, index)
      && (index + mention.length === value.length || /\s/u.test(value[index + mention.length] ?? ''))
    ))
    if (!matched) {
      index += 1
      continue
    }
    spans.push({ start: index, end: index + matched.length })
    index += matched.length
  }
  return spans
}

function replaceSelectedSkill(
  current: string,
  nextValue: string,
  mentions: readonly ComposerMention[],
) {
  const spans = knownSkillTokenSpans(current, mentions)
  const trailingMention = /(^|\s)@[^\s@]*$/u.exec(current)
  if (trailingMention) {
    const start = trailingMention.index + trailingMention[1].length
    const isAlreadyKnown = spans.some((span) => start >= span.start && current.length <= span.end)
    if (!isAlreadyKnown) spans.push({ start, end: current.length })
  }
  spans.sort((left, right) => left.start - right.start)
  if (spans.length) {
    let output = ''
    let cursor = 0
    let insertionIndex = 0
    spans.forEach((span, index) => {
      output += current.slice(cursor, span.start)
      if (index === 0) insertionIndex = output.length
      const trailingWhitespace = current[span.end] === ' ' ? 1 : 0
      cursor = span.end + trailingWhitespace
    })
    output += current.slice(cursor)
    return `${output.slice(0, insertionIndex)}${nextValue} ${output.slice(insertionIndex)}`
  }

  // If the menu was opened while the user was typing an incomplete @ token,
  // replace that token in place and leave the rest of the request untouched.
  const replaced = current.replace(
    /(^|\s)@[^\s@]*$/u,
    (_match, prefix: string) => `${prefix}${nextValue} `,
  )
  return replaced === current ? `${current}${current ? ' ' : ''}${nextValue} ` : replaced
}

const traceStageKeys = new Set<ProductAnswerProgress['stage']>([
  'UNDERSTANDING',
  'REQUIREMENTS_ANALYSIS',
  'CAPABILITY_MATCHING',
  'RETRIEVING',
  'ARCHITECTURE_DESIGN',
  'VERIFYING',
  'EVIDENCE_CHECK',
  'QUALITY_REVIEW',
  'COMPOSING',
  'WAITING_FOR_INPUT',
])

function traceToProgressTrail(trace: unknown, runId?: string): ProductAnswerProgress[] {
  if (!trace || typeof trace !== 'object') return []
  const value = trace as Partial<SolutionExecutionTrace> & { steps?: unknown }
  if (!Array.isArray(value.steps)) return []
  const trail: ProductAnswerProgress[] = []
  for (const rawStep of value.steps) {
    if (!rawStep || typeof rawStep !== 'object') continue
    const step = rawStep as unknown as Record<string, unknown>
    const stage = typeof step.stage === 'string' && traceStageKeys.has(step.stage as ProductAnswerProgress['stage'])
      ? step.stage as ProductAnswerProgress['stage']
      : undefined
    if (!stage) continue
    const message = typeof step.message === 'string' && step.message.trim()
      ? step.message
      : typeof step.label === 'string' && step.label.trim() ? step.label : '正在处理'
    const status = typeof step.status === 'string' ? step.status : undefined
    const elapsedMs = typeof step.elapsedMs === 'number' && Number.isFinite(step.elapsedMs) ? step.elapsedMs : undefined
    const progress = { stage, message, ...(runId ? { runId } : {}), ...(status ? { status } : {}), ...(elapsedMs !== undefined ? { elapsedMs } : {}) }
    const previous = trail.at(-1)
    if (previous?.stage === stage) trail[trail.length - 1] = progress
    else trail.push(progress)
  }
  return trail
}

interface ActiveRunResponse {
  run?: {
    runId: string
    status?: string
    streamUrl?: string
    inputContent?: string
    executionTrace?: unknown
    interrupt?: unknown
  } | null
}

export function ChatPage() {
  const [conversations, setConversations] = useState<ProductConversation[]>([])
  const [conversation, setConversation] = useState<ProductConversation>()
  const [messages, setMessages] = useState<ProductMessage[]>([])
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string>()
  const [answerMode, setAnswerMode] = useState<AnswerMode>('DETAILED')
  const [pendingQuestion, setPendingQuestion] = useState<string>()
  const [agentInterruptQuestion, setAgentInterruptQuestion] = useState<ProductAgentInterrupt>()
  const [answerProgress, setAnswerProgress] = useState<ProductAnswerProgress>()
  const [answerProgressTrail, setAnswerProgressTrail] = useState<ProductAnswerProgress[]>([])
  const [streamedAnswer, setStreamedAnswer] = useState('')
  const [loadingWorkspace, setLoadingWorkspace] = useState(true)
  const [loadingConversation, setLoadingConversation] = useState(false)
  const [sending, setSending] = useState(false)
  const [currentRunId, setCurrentRunId] = useState<string>()
  const [archiving, setArchiving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [feedbackPendingIds, setFeedbackPendingIds] = useState<Set<string>>(() => new Set())
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [activePairId, setActivePairId] = useState<string>()
  const [highlightedPairId, setHighlightedPairId] = useState<string>()
  const [errorText, setErrorText] = useState<string>()
  const [conversationListOpen, setConversationListOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [conversationSearch, setConversationSearch] = useState('')
  const [businessTask, setBusinessTask] = useState<BusinessTask>('QA')
  const [businessTaskExplicit, setBusinessTaskExplicit] = useState(false)
  const [selectedCitation, setSelectedCitation] = useState<ProductCitation>()
  const [sourceDrawerModal, setSourceDrawerModal] = useState(false)
  const [distributionMaterial, setDistributionMaterial] = useState<ProductMaterial>()
  const [distributionBusy, setDistributionBusy] = useState(false)
  const [distributionFeedback, setDistributionFeedback] = useState<string>()
  const [toastText, setToastText] = useState<string>()
  const contextVersionRef = useRef(0)
  const citationVersionRef = useRef(0)
  const answerProgressTrailRef = useRef<ProductAnswerProgress[]>([])
  const streamedAnswerRef = useRef('')
  const citationTriggerRef = useRef<HTMLButtonElement>()
  const messageScrollRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)
  const conversationSidebarRef = useRef<HTMLElement>(null)
  const conversationTriggerRef = useRef<HTMLButtonElement>(null)
  const conversationCloseRef = useRef<HTMLButtonElement>(null)
  const toastTimerRef = useRef<number>()
  const sendAbortControllerRef = useRef<AbortController>()
  const currentRunIdRef = useRef<string>()
  const restoredConversationIdsRef = useRef(new Set<string>())
  const lastEventIdRef = useRef<string>()

  function streamRequestInit(signal: AbortSignal): RequestInit {
    const headers = new Headers()
    if (lastEventIdRef.current) headers.set('Last-Event-ID', lastEventIdRef.current)
    return { method: 'GET', signal, headers }
  }

  const loadWorkspace = useCallback(async () => {
    const version = ++contextVersionRef.current
    setLoadingWorkspace(true)
    setErrorText(undefined)
    try {
      const result = await api<{ conversations: ProductConversation[] }>('/api/chat/conversations')
      if (contextVersionRef.current !== version) return
      const items = sortConversations(result.conversations)
      setConversations(items)
      const initialConversation = items.find((item) => item.status === 'ACTIVE') ?? items[0]
      setShowArchived(initialConversation?.status === 'ARCHIVED')
      if (initialConversation) {
        const detail = await api<ConversationDetail>(`/api/chat/conversations/${initialConversation.id}`)
        if (contextVersionRef.current !== version) return
        setConversation(normalizeConversation(detail.conversation))
        setMessages(detail.messages)
        setBusinessTask(businessTaskFromMessages(detail.messages))
        setBusinessTaskExplicit(false)
      } else {
        setConversation(undefined)
        setMessages([])
      }
    } catch {
      if (contextVersionRef.current !== version) return
      setErrorText('会话加载失败，请重试')
    } finally {
      if (contextVersionRef.current === version) setLoadingWorkspace(false)
    }
  }, [])

  useEffect(() => {
    void loadWorkspace()
    return () => {
      sendAbortControllerRef.current?.abort()
      sendAbortControllerRef.current = undefined
      contextVersionRef.current += 1
      citationVersionRef.current += 1
      if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    }
  }, [loadWorkspace])

  useEffect(() => {
    if (conversationListOpen) conversationCloseRef.current?.focus()
  }, [conversationListOpen])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mediaQuery = window.matchMedia('(max-width: 1024px)')
    const syncModalState = () => setSourceDrawerModal(mediaQuery.matches)
    syncModalState()
    mediaQuery.addEventListener('change', syncModalState)
    return () => mediaQuery.removeEventListener('change', syncModalState)
  }, [])

  useEffect(() => {
    if (selectedCitation || !citationTriggerRef.current) return
    const trigger = citationTriggerRef.current
    citationTriggerRef.current = undefined
    trigger.focus()
  }, [selectedCitation])

  const lastMessageId = messages.at(-1)?.id

  useEffect(() => {
    const element = messageScrollRef.current
    if (!element) return

    const syncScrollButton = () => {
      const distanceFromBottom = element.scrollHeight - element.clientHeight - element.scrollTop
      followLatestRef.current = distanceFromBottom <= 24
      setShowScrollToBottom(element.scrollHeight > element.clientHeight + 24 && distanceFromBottom > 24)
    }

    syncScrollButton()
    element.addEventListener('scroll', syncScrollButton, { passive: true })
    window.addEventListener('resize', syncScrollButton)
    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(syncScrollButton)
      resizeObserver.observe(element)
    }
    return () => {
      element.removeEventListener('scroll', syncScrollButton)
      window.removeEventListener('resize', syncScrollButton)
      resizeObserver?.disconnect()
    }
  }, [lastMessageId, loadingConversation, loadingWorkspace, messages.length, pendingQuestion])

  useEffect(() => {
    const element = messageScrollRef.current
    if (!element) return

    const syncActivePair = () => {
      const anchors = Array.from(element.querySelectorAll<HTMLElement>('[data-message-pair]'))
      if (!anchors.length) {
        setActivePairId(undefined)
        return
      }
      const threshold = element.getBoundingClientRect().top + Math.min(180, element.clientHeight * 0.28)
      const current = anchors.reduce((candidate, anchor) => (
        anchor.getBoundingClientRect().top <= threshold ? anchor : candidate
      ), anchors[0])
      setActivePairId(current.dataset.messagePair)
    }

    syncActivePair()
    element.addEventListener('scroll', syncActivePair, { passive: true })
    window.addEventListener('resize', syncActivePair)
    return () => {
      element.removeEventListener('scroll', syncActivePair)
      window.removeEventListener('resize', syncActivePair)
    }
  }, [loadingConversation, loadingWorkspace, messages.length])

  useEffect(() => {
    if (!streamedAnswer) return
    const element = messageScrollRef.current
    if (!element) return
    if (followLatestRef.current) {
      element.scrollTop = element.scrollHeight
      setShowScrollToBottom(false)
      return
    }
    setShowScrollToBottom(element.scrollHeight > element.clientHeight + 24)
  }, [streamedAnswer])

  const recordProgress = useCallback((progress: ProductAnswerProgress) => {
    const normalized = {
      ...progress,
      ...(progress.runId || !currentRunIdRef.current ? {} : { runId: currentRunIdRef.current }),
      ...(progress.status ? {} : { status: 'ACTIVE' }),
    }
    const next = nextProgressTrail(answerProgressTrailRef.current, normalized)
    if (next === answerProgressTrailRef.current) return
    answerProgressTrailRef.current = next
    setAnswerProgress(next.at(-1))
    setAnswerProgressTrail(next)
  }, [])

  const scrollToLatest = useCallback(() => {
    const element = messageScrollRef.current
    if (!element) return
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    followLatestRef.current = true
    setShowScrollToBottom(false)
  }, [])

  const visibleConversations = useMemo(() => sortConversations(conversations), [conversations])
  const archivedConversations = visibleConversations.filter((item) => item.status === 'ARCHIVED')
  const listedConversations = visibleConversations.filter((item) => item.status === (showArchived ? 'ARCHIVED' : 'ACTIVE'))
  const filteredConversations = useMemo(() => {
    const query = conversationSearch.trim().toLocaleLowerCase()
    if (!query) return listedConversations
    return listedConversations.filter((item) => item.title.toLocaleLowerCase().includes(query))
  }, [conversationSearch, listedConversations])
  const switchLocked = sending || archiving || restoring
  const mutationLocked = switchLocked || loadingWorkspace || loadingConversation
  const archived = conversation?.status === 'ARCHIVED'

  const applyAnswer = useCallback((result: SendResponse) => {
    const conversation = normalizeConversation(result.conversation)
    setConversation(conversation)
    setConversations((current) => upsertConversation(current, conversation))
    setMessages((current) => [...current, result.userMessage, result.assistantMessage])
    setPendingQuestion(undefined)
    setAgentInterruptQuestion(undefined)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    setStreamedAnswer('')
    streamedAnswerRef.current = ''
    lastEventIdRef.current = undefined
    currentRunIdRef.current = undefined
    setCurrentRunId(undefined)
    setDraft('')
    setAttachments([])
    setAttachmentError(undefined)
  }, [])

  const restoreActiveRun = useCallback(async (conversationId: string, version: number) => {
    if (restoredConversationIdsRef.current.has(conversationId) || sending || currentRunIdRef.current) return
    restoredConversationIdsRef.current.add(conversationId)
    let active: ActiveRunResponse
    try {
      active = await api<ActiveRunResponse>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/active-run`)
    } catch {
      return
    }
    const run = active.run
    if (!run || contextVersionRef.current !== version) return
    const terminal = String(run.status ?? '').toLowerCase()
    if (['completed', 'succeeded', 'success', 'failed', 'cancelled'].includes(terminal)) return
    const trail = traceToProgressTrail(run.executionTrace, run.runId)
    answerProgressTrailRef.current = trail
    setAnswerProgressTrail(trail)
    setAnswerProgress(trail.at(-1))
    setBusinessTask('SOLUTION_DRAFT')
    setBusinessTaskExplicit(false)
    setPendingQuestion(run.inputContent?.trim() || '正在恢复方案运行…')
    setAgentInterruptQuestion(normalizeInterrupt(run.interrupt, run.runId))
    setStreamedAnswer('')
    streamedAnswerRef.current = ''
    currentRunIdRef.current = run.runId
    setCurrentRunId(run.runId)
    setSending(true)
    const abortController = new AbortController()
    sendAbortControllerRef.current = abortController
    try {
      const baseUrl = run.streamUrl || `/api/chat/runs/${encodeURIComponent(run.runId)}/events`
      const streamUrl = baseUrl.includes('?') ? `${baseUrl}&afterSeq=0` : `${baseUrl}?afterSeq=0`
      const result = await streamApi<SendResponse, ProductAnswerProgress>(
        streamUrl,
        streamRequestInit(abortController.signal),
        {
          onProgress: (progress) => {
            if (contextVersionRef.current === version) recordProgress({ ...progress, runId: progress.runId ?? run.runId })
          },
          onEventId: (eventId) => { lastEventIdRef.current = eventId },
          onRunStarted: (value) => {
            const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}
            const nextRunId = typeof payload.runId === 'string' ? payload.runId : run.runId
            currentRunIdRef.current = nextRunId
            setCurrentRunId(nextRunId)
          },
          onDelta: async (delta) => {
            if (contextVersionRef.current !== version) return
            streamedAnswerRef.current += delta
            setStreamedAnswer(streamedAnswerRef.current)
            await yieldSolutionStreamPaint()
          },
          onDraft: () => {
            if (contextVersionRef.current === version) recordProgress({ stage: 'COMPOSING', message: '方案草稿已生成，正在整理结果', runId: run.runId })
          },
          onInterrupt: (value) => {
            if (contextVersionRef.current !== version) return
            const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}
            setAgentInterruptQuestion(normalizeInterrupt(payload, run.runId))
            recordProgress({ stage: 'WAITING_FOR_INPUT', message: '等待补充方案所需信息', runId: run.runId, status: 'INTERRUPTED' })
          },
        },
      )
      if (contextVersionRef.current === version && result) applyAnswer(result)
    } catch (error) {
      if (contextVersionRef.current === version && !isAbortError(error)) {
        setErrorText(error instanceof ApiError ? error.message : '方案运行恢复失败，请重试')
      }
    } finally {
      if (sendAbortControllerRef.current === abortController) sendAbortControllerRef.current = undefined
      if (contextVersionRef.current === version) setSending(false)
    }
  }, [applyAnswer, recordProgress, sending])

  useEffect(() => {
    const conversationId = conversation?.id
    if (!conversationId || loadingWorkspace || loadingConversation) return
    void restoreActiveRun(conversationId, contextVersionRef.current)
  }, [conversation?.id, loadingConversation, loadingWorkspace, restoreActiveRun])

  function closeConversationList() {
    setConversationListOpen(false)
    if (conversationListOpen) conversationTriggerRef.current?.focus()
  }

  function handleConversationDrawerKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (!conversationListOpen) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeConversationList()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(conversationSidebarRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
    ) ?? [])
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function startConversation() {
    if (switchLocked) return
    contextVersionRef.current += 1
    citationVersionRef.current += 1
    setConversation(undefined)
    setMessages([])
    setAnswerMode('DETAILED')
    setPendingQuestion(undefined)
    setAgentInterruptQuestion(undefined)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    setStreamedAnswer('')
    streamedAnswerRef.current = ''
    lastEventIdRef.current = undefined
    currentRunIdRef.current = undefined
    setCurrentRunId(undefined)
    setActivePairId(undefined)
    setHighlightedPairId(undefined)
    setShowArchived(false)
    setConversationSearch('')
    setBusinessTask('QA')
    setBusinessTaskExplicit(false)
    setDraft('')
    setAttachments([])
    setAttachmentError(undefined)
    setErrorText(undefined)
    setLoadingWorkspace(false)
    setLoadingConversation(false)
    setSelectedCitation(undefined)
    setFeedbackPendingIds(new Set())
    closeConversationList()
  }

  async function selectConversation(item: ProductConversation) {
    if (switchLocked) return
    restoredConversationIdsRef.current.delete(item.id)
    const version = ++contextVersionRef.current
    citationVersionRef.current += 1
    setErrorText(undefined)
    setPendingQuestion(undefined)
    setAgentInterruptQuestion(undefined)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    setStreamedAnswer('')
    streamedAnswerRef.current = ''
    lastEventIdRef.current = undefined
    currentRunIdRef.current = undefined
    setCurrentRunId(undefined)
    setActivePairId(undefined)
    setHighlightedPairId(undefined)
    setShowArchived(item.status === 'ARCHIVED')
    setBusinessTask('QA')
    setBusinessTaskExplicit(false)
    setSelectedCitation(undefined)
    setAttachments([])
    setAttachmentError(undefined)
    setFeedbackPendingIds(new Set())
    setLoadingWorkspace(false)
    setLoadingConversation(true)
    closeConversationList()
    try {
      const detail = await api<ConversationDetail>(`/api/chat/conversations/${item.id}`)
      if (contextVersionRef.current !== version) return
      setConversation(normalizeConversation(detail.conversation))
      setMessages(detail.messages)
      setBusinessTask(businessTaskFromMessages(detail.messages))
      setBusinessTaskExplicit(false)
    } catch {
      if (contextVersionRef.current !== version) return
      setErrorText('会话加载失败，请重试')
    } finally {
      if (contextVersionRef.current === version) setLoadingConversation(false)
    }
  }

  async function send() {
    const content = draft.trim()
    if (!content || mutationLocked || archived) return
    const resolvedBusinessTask = businessTaskExplicit ? businessTask : inferBusinessTask(content)
    const requestedSkillId = resolvedBusinessTask === 'QA' ? undefined : resolvedBusinessTask
    setBusinessTask(resolvedBusinessTask)
    setBusinessTaskExplicit(false)
    const mode = answerMode
    const version = contextVersionRef.current
    const abortController = new AbortController()
    sendAbortControllerRef.current = abortController
    let attachmentUploadFailed = false
    setSending(true)
    setDraft('')
    setPendingQuestion(content)
    setAgentInterruptQuestion(undefined)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    setStreamedAnswer('')
    streamedAnswerRef.current = ''
    lastEventIdRef.current = undefined
    currentRunIdRef.current = undefined
    setCurrentRunId(undefined)
    setAttachmentError(undefined)
    followLatestRef.current = true
    setErrorText(undefined)
    try {
      let target = conversation
      if (!target) {
        const created = await api<{ conversation: ProductConversation }>('/api/chat/conversations', {
          method: 'POST',
          body: JSON.stringify({}),
          signal: abortController.signal,
        })
        if (contextVersionRef.current !== version) return
        target = normalizeConversation(created.conversation)
        setConversation(target)
        setConversations((current) => upsertConversation(current, target!))
      }
      const attachmentIds: string[] = []
      if (attachments.length) {
        setAttachments((current) => current.map((attachment) => ({ ...attachment, status: 'UPLOADING', error: undefined })))
        try {
          for (const attachment of attachments) {
            const formData = new FormData()
            formData.append('file', attachment.file, attachment.file.name)
            const uploaded = await api<{ attachment: ProductAttachment }>(
              `/api/chat/conversations/${target.id}/attachments`,
              { method: 'POST', body: formData, signal: abortController.signal },
            )
            attachmentIds.push(uploaded.attachment.id)
          }
        } catch (error) {
          attachmentUploadFailed = true
          const message = attachmentUploadMessage(error)
          setAttachments((current) => current.map((attachment) => ({
            ...attachment,
            status: 'FAILED',
            error: message,
          })))
          setAttachmentError(message)
          throw error
        }
      }

      const messageBody = JSON.stringify({
        content,
        mode,
        requestId: globalThis.crypto?.randomUUID?.() ?? `request-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ...(requestedSkillId ? { skillId: requestedSkillId } : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
      })
      const result = await streamApi<SendResponse, ProductAnswerProgress>(
        `/api/chat/conversations/${target.id}/messages/stream`,
        {
          method: 'POST',
          body: messageBody,
          signal: abortController.signal,
        },
        {
          onProgress: (progress) => {
            if (contextVersionRef.current !== version) return
            recordProgress(progress)
          },
          onDelta: async (delta) => {
            if (contextVersionRef.current !== version) return
            streamedAnswerRef.current += delta
            setStreamedAnswer(streamedAnswerRef.current)
            if (requestedSkillId === 'SOLUTION_DRAFT') await yieldSolutionStreamPaint()
          },
          onRunStarted: (run) => {
            if (contextVersionRef.current !== version || !run || typeof run !== 'object') return
            const payload = run as Record<string, unknown>
            const runId = typeof payload.runId === 'string'
              ? payload.runId
              : typeof payload.run_id === 'string'
                ? payload.run_id
                : undefined
            if (!runId) return
            currentRunIdRef.current = runId
            setCurrentRunId(runId)
          },
          onEventId: (eventId) => { lastEventIdRef.current = eventId },
          onDraft: (value) => {
            if (contextVersionRef.current !== version) return
            if (value && typeof value === 'object') {
              recordProgress({ stage: 'COMPOSING', message: '方案草稿已生成，正在整理结果' })
            }
          },
          onInterrupt: (value) => {
            if (contextVersionRef.current !== version) return
            const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}
            const interruptedRunId = typeof payload.runId === 'string' ? payload.runId : currentRunIdRef.current
            setAgentInterruptQuestion(normalizeInterrupt(payload, interruptedRunId))
            if (interruptedRunId) {
              currentRunIdRef.current = interruptedRunId
              setCurrentRunId(interruptedRunId)
            }
            recordProgress({
              stage: 'WAITING_FOR_INPUT',
              message: '等待补充方案所需信息',
              runId: interruptedRunId,
              status: 'INTERRUPTED',
            })
          },
        },
      )
      if (contextVersionRef.current !== version) return
      if (!result) return
      currentRunIdRef.current = undefined
      setCurrentRunId(undefined)
      applyAnswer(result)
    } catch (error) {
      if (contextVersionRef.current !== version) return
      setPendingQuestion(undefined)
      setAgentInterruptQuestion(undefined)
      setStreamedAnswer('')
      streamedAnswerRef.current = ''
      currentRunIdRef.current = undefined
      setCurrentRunId(undefined)
      // Upload errors already have a specific inline message next to the
      // attachment. Avoid replacing it with a generic send failure banner.
      if (!isAbortError(error)) {
        setDraft(content)
        if (!attachmentUploadFailed) setErrorText('发送失败，请重试')
      }
    } finally {
      if (sendAbortControllerRef.current === abortController) {
        sendAbortControllerRef.current = undefined
      }
      if (contextVersionRef.current === version) setSending(false)
    }
  }

  async function resumeAgentRun(answerOverride?: string | string[], action: 'answer' | 'skip' = 'answer') {
    const answer = answerOverride ?? draft.trim()
    const parentRunId = currentRunIdRef.current
    const hasAnswer = Array.isArray(answer) ? answer.length > 0 : Boolean(answer.trim())
    if (action === 'answer' && !hasAnswer || !parentRunId || mutationLocked || archived || !agentInterruptQuestion) return
    const version = contextVersionRef.current
    const abortController = new AbortController()
    sendAbortControllerRef.current = abortController
    setSending(true)
    setDraft('')
    setStreamedAnswer('')
    streamedAnswerRef.current = ''
    // A resumed run has a new run id; do not send the parent cursor to it.
    lastEventIdRef.current = undefined
    setAgentInterruptQuestion(undefined)
    setErrorText(undefined)
    try {
      const resumed = await api<{ run: { runId: string; streamUrl?: string } }>(`/api/chat/runs/${encodeURIComponent(parentRunId)}/resume`, {
        method: 'POST',
        body: JSON.stringify({
          answer,
          action,
          ...(agentInterruptQuestion.questionId ? { questionId: agentInterruptQuestion.questionId } : {}),
          requestId: globalThis.crypto?.randomUUID?.() ?? `resume-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        }),
        signal: abortController.signal,
      })
      if (contextVersionRef.current !== version) return
      currentRunIdRef.current = resumed.run.runId
      setCurrentRunId(resumed.run.runId)
      const result = await streamApi<SendResponse, ProductAnswerProgress>(
        resumed.run.streamUrl || `/api/chat/runs/${encodeURIComponent(resumed.run.runId)}/events`,
        streamRequestInit(abortController.signal),
        {
          onProgress: (progress) => {
            if (contextVersionRef.current !== version) return
            recordProgress(progress)
          },
          onRunStarted: (run) => {
            const payload = run && typeof run === 'object' ? run as Record<string, unknown> : {}
            const nextRunId = typeof payload.runId === 'string' ? payload.runId : undefined
            if (nextRunId) {
              currentRunIdRef.current = nextRunId
              setCurrentRunId(nextRunId)
            }
          },
          onEventId: (eventId) => { lastEventIdRef.current = eventId },
          onDelta: async (delta) => {
            if (contextVersionRef.current !== version) return
            streamedAnswerRef.current += delta
            setStreamedAnswer(streamedAnswerRef.current)
            await yieldSolutionStreamPaint()
          },
          onDraft: () => recordProgress({ stage: 'COMPOSING', message: '方案草稿已生成，正在整理结果' }),
          onInterrupt: (value) => {
            if (contextVersionRef.current !== version) return
            const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}
            setAgentInterruptQuestion(normalizeInterrupt(payload, currentRunIdRef.current) ?? {
              question: typeof payload.question === 'string' ? payload.question : '请补充方案所需信息',
              status: 'INTERRUPTED',
              runId: currentRunIdRef.current,
            })
            recordProgress({
              stage: 'WAITING_FOR_INPUT',
              message: '等待补充方案所需信息',
              runId: currentRunIdRef.current,
              status: 'INTERRUPTED',
            })
          },
        },
      )
      if (contextVersionRef.current !== version || !result) return
      applyAnswer(result)
    } catch (error) {
      if (contextVersionRef.current !== version) return
      if (!isAbortError(error)) {
        setErrorText(error instanceof ApiError ? error.message : '方案继续生成失败，请重试')
      }
    } finally {
      if (sendAbortControllerRef.current === abortController) sendAbortControllerRef.current = undefined
      if (contextVersionRef.current === version) setSending(false)
    }
  }

  function stopSending() {
    if (!sending) return
    const runId = currentRunIdRef.current
    if (runId) {
      void api(`/api/chat/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }).catch(() => undefined)
    }
    sendAbortControllerRef.current?.abort()
    sendAbortControllerRef.current = undefined
    currentRunIdRef.current = undefined
    setCurrentRunId(undefined)
    contextVersionRef.current += 1
    setSending(false)
    setPendingQuestion(undefined)
    setAgentInterruptQuestion(undefined)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    setStreamedAnswer('')
    streamedAnswerRef.current = ''
    setAttachments((current) => current.map((attachment) => (
      attachment.status === 'UPLOADING' ? { ...attachment, status: 'PENDING' } : attachment
    )))
    setAttachmentError(undefined)
    setErrorText(undefined)
  }

  function addAttachments(files: File[]) {
    if (mutationLocked || archived) return
    const next: ComposerAttachment[] = []
    let firstError: string | undefined
    const existing = new Set(attachments.map((attachment) => `${attachment.file.name}:${attachment.file.size}:${attachment.file.lastModified}`))
    for (const file of files) {
      const error = getAttachmentError(file)
      if (error) {
        firstError ??= error
        continue
      }
      const key = `${file.name}:${file.size}:${file.lastModified}`
      if (existing.has(key)) continue
      existing.add(key)
      next.push({ id: `attachment-${file.name}-${file.size}-${file.lastModified}`, file, status: 'PENDING' })
    }
    if (attachments.length + next.length > MAX_COMPOSER_ATTACHMENTS) {
      firstError ??= `最多同时添加 ${MAX_COMPOSER_ATTACHMENTS} 个文件`
      next.splice(Math.max(0, MAX_COMPOSER_ATTACHMENTS - attachments.length))
    }
    if (next.length) setAttachments((current) => [...current, ...next])
    setAttachmentError(firstError)
  }

  function removeAttachment(id: string) {
    if (mutationLocked || archived) return
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
    setAttachmentError(undefined)
  }

  async function archiveConversation() {
    if (!conversation || archived || mutationLocked) return
    const version = contextVersionRef.current
    const target = conversation
    setArchiving(true)
    setErrorText(undefined)
    try {
      await api<unknown>(`/api/chat/conversations/${target.id}/archive`, { method: 'POST' })
      if (contextVersionRef.current !== version) return
      const archivedConversation: ProductConversation = { ...target, status: 'ARCHIVED' }
      setConversation(archivedConversation)
      setConversations((current) => current.map((item) => item.id === target.id ? archivedConversation : item))
    } catch {
      if (contextVersionRef.current !== version) return
      setErrorText('归档失败，请重试')
    } finally {
      if (contextVersionRef.current === version) setArchiving(false)
    }
  }

  async function restoreConversation() {
    if (!conversation || !archived || mutationLocked) return
    const version = contextVersionRef.current
    const target = conversation
    setRestoring(true)
    setErrorText(undefined)
    try {
      await api<unknown>(`/api/chat/conversations/${target.id}/restore`, { method: 'POST' })
      if (contextVersionRef.current !== version) return
      const restoredConversation: ProductConversation = { ...target, status: 'ACTIVE' }
      setConversation(restoredConversation)
      setConversations((current) => upsertConversation(current, restoredConversation))
      setShowArchived(false)
    } catch {
      if (contextVersionRef.current !== version) return
      setErrorText('恢复会话失败，请重试')
    } finally {
      if (contextVersionRef.current === version) setRestoring(false)
    }
  }

  async function updateFeedback(
    messageId: string,
    rating: FeedbackRating | null,
    reasonType?: FeedbackReasonType,
    reasonText?: string,
  ) {
    if (feedbackPendingIds.has(messageId)) return
    const target = messages.find((message) => message.id === messageId && message.role === 'ASSISTANT')
    if (!target || archived) return
    const version = contextVersionRef.current
    const previousRating = target.feedbackRating ?? null
    setFeedbackPendingIds((current) => new Set(current).add(messageId))
    setErrorText(undefined)
    setMessages((current) => current.map((message) => (
      message.id === messageId
        ? {
            ...message,
            feedbackRating: rating,
            feedbackReasonType: rating === 'DISLIKE' ? reasonType : null,
            feedbackReasonText: rating === 'DISLIKE' ? reasonText : null,
          }
        : message
    )))
    try {
      const response = await api<FeedbackResponse>(`/api/chat/messages/${messageId}/feedback`, {
        method: 'PUT',
        body: JSON.stringify({ rating, reasonType, reasonText }),
      })
      if (contextVersionRef.current !== version) return
      setMessages((current) => current.map((message) => (
        message.id === response.messageId
          ? {
              ...message,
              feedbackRating: response.feedbackRating,
              feedbackReasonType: response.feedbackReasonType,
              feedbackReasonText: response.feedbackReasonText,
            }
          : message
      )))
    } catch {
      if (contextVersionRef.current !== version) return
      setMessages((current) => current.map((message) => (
        message.id === messageId ? { ...message, feedbackRating: previousRating } : message
      )))
      setErrorText('反馈提交失败，请重试')
    } finally {
      if (contextVersionRef.current === version) {
        setFeedbackPendingIds((current) => {
          const next = new Set(current)
          next.delete(messageId)
          return next
        })
      }
    }
  }

  async function updateSolutionDraft(draftId: string, patch: SolutionDraftEditRequest) {
    try {
      const response = await api<{ draft: NonNullable<ProductMessage['solutionDraft']> }>(
        `/api/chat/solution-drafts/${encodeURIComponent(draftId)}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      )
      setMessages((current) => current.map((message) => (
        message.solutionDraft?.id === draftId
          ? { ...message, solutionDraft: response.draft, content: response.draft.executiveSummary }
          : message
      )))
      showToast('方案草稿已保存为新版本')
    } catch {
      setErrorText('方案草稿保存失败，请重试')
      throw new Error('SOLUTION_DRAFT_SAVE_FAILED')
    }
  }

  async function confirmSolutionDraft(draftId: string) {
    try {
      const response = await api<{ draft: NonNullable<ProductMessage['solutionDraft']>; confirmed: boolean }>(
        `/api/chat/solution-drafts/${encodeURIComponent(draftId)}/confirm`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      setMessages((current) => current.map((message) => (
        message.solutionDraft?.id === draftId
          ? { ...message, solutionDraft: response.draft, content: response.draft.executiveSummary }
          : message
      )))
      showToast('已确认并生成正式方案')
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : '方案确认失败，请重试')
      throw new Error('SOLUTION_DRAFT_CONFIRM_FAILED')
    }
  }

  async function openCitation(citation: ProductCitation, trigger: HTMLButtonElement) {
    const version = ++citationVersionRef.current
    citationTriggerRef.current = trigger
    setErrorText(undefined)
    try {
      const detail = await api<ProductCitation>(`/api/citations/${citation.id}`)
      if (citationVersionRef.current !== version) return
      setSelectedCitation(detail)
    } catch {
      if (citationVersionRef.current !== version) return
      setErrorText('来源加载失败，请重试')
    }
  }

  function closeCitation() {
    citationVersionRef.current += 1
    setSelectedCitation(undefined)
  }

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    setToastText(message)
    toastTimerRef.current = window.setTimeout(() => {
      setToastText(undefined)
      toastTimerRef.current = undefined
    }, 3200)
  }, [])

  async function fetchMaterialBlob(material: ProductMaterial, downloadPath?: string) {
    const response = await fetch(downloadPath ?? `/api/chat/materials/${encodeURIComponent(material.id)}/download`, {
      credentials: 'include',
    })
    if (!response.ok) throw new Error('MATERIAL_DOWNLOAD_FAILED')
    return response.blob()
  }

  async function downloadMaterial(material: ProductMaterial) {
    setErrorText(undefined)
    try {
      const blob = await fetchMaterialBlob(material)
      if (!triggerBlobDownload(blob, material.fileName)) throw new Error('BROWSER_DOWNLOAD_UNAVAILABLE')
      showToast(`已下载「${material.fileName}」`)
    } catch {
      setErrorText('资料下载失败，请重试')
    }
  }

  function openMaterialPreview(material: ProductMaterial, trigger: HTMLButtonElement) {
    void openCitation(material.citation, trigger)
  }

  function openMaterialDistribution(material: ProductMaterial) {
    setDistributionMaterial(material)
    setDistributionFeedback(undefined)
    setErrorText(undefined)
  }

  function closeMaterialDistribution() {
    if (distributionBusy) return
    setDistributionMaterial(undefined)
    setDistributionFeedback(undefined)
  }

  async function distributeMaterial(channel: MaterialShareChannel) {
    const material = distributionMaterial
    if (!material || distributionBusy) return
    // Launch the desktop protocol while the click still has user activation.
    // The network request and file preparation below are asynchronous and may
    // otherwise cause browsers to reject a later custom-protocol navigation.
    const earlyWechatOpen: ShareApplicationOpenResult | undefined = channel === 'WECHAT' && !canShareMaterialFiles(undefined, material.mimeType)
      ? openShareApplication('WECHAT')
      : undefined
    setDistributionBusy(true)
    setDistributionFeedback(undefined)
    setErrorText(undefined)
    try {
      const response = await api<MaterialDistributionResponse>(
        `/api/chat/materials/${encodeURIComponent(material.id)}/distributions`,
        {
          method: 'POST',
          body: JSON.stringify({ channel }),
        },
      )
      const blob = await fetchMaterialBlob(material, response.downloadUrl)
      const file = new File([blob], material.fileName, { type: blob.type || material.mimeType })
      const result = await shareMaterialViaDevice({
        title: material.title,
        fileName: material.fileName,
        size: formatMaterialSize(material.sizeBytes),
        summary: response.text,
        sourcePath: material.citation.path,
        shareText: response.text,
      }, channel, undefined, file)
      if (result === 'SHARED') {
        setDistributionFeedback(`已打开${channel === 'FEISHU' ? '飞书' : '微信'}系统分享面板，请选择联系人发送`)
        showToast('已打开手机分享面板')
      } else if (result === 'CANCELLED') {
        setDistributionFeedback('已取消分享，资料未发送')
      } else {
        if (!triggerBlobDownload(blob, material.fileName)) throw new Error('BROWSER_DOWNLOAD_UNAVAILABLE')
        if (channel === 'WECHAT') {
          const openResult = earlyWechatOpen === 'OPENED' ? earlyWechatOpen : openShareApplication('WECHAT')
          if (openResult === 'OPENED') {
            setDistributionFeedback('资料已下载，并已尝试打开微信。请在微信中选择联系人并发送刚下载的文件。')
            showToast(`已下载「${material.fileName}」，正在打开微信`)
          } else {
            setDistributionFeedback('资料已下载，但浏览器无法自动打开微信，请手动打开微信发送。')
            showToast(`已下载「${material.fileName}」`)
          }
        } else {
          setDistributionFeedback('设备不支持直接分享，已下载资料，请使用系统分享')
          showToast(`已下载「${material.fileName}」，可用系统分享`)
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CHANNEL_NOT_AVAILABLE') {
        setDistributionFeedback('钉钉暂未接入，请选择微信或飞书')
      } else {
        setErrorText('分发准备失败，请重试')
      }
    } finally {
      setDistributionBusy(false)
    }
  }

  function activatePair(pairId: string) {
    const target = document.getElementById(messagePairAnchorId(pairId))
    if (!target) return
    setActivePairId(pairId)
    setHighlightedPairId(pairId)
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function selectExampleQuestion(question: string) {
    setBusinessTask('QA')
    setBusinessTaskExplicit(false)
    setAnswerMode('DETAILED')
    setDraft(question)
  }

  function selectBusinessTask(task: Exclude<BusinessTask, 'QA'>, mentionValue?: string) {
    const definition = businessTasks.find((item) => item.id === task)
    if (!definition) return
    setBusinessTask(task)
    setBusinessTaskExplicit(true)
    setAnswerMode('DETAILED')
    setDraft((current) => {
      const value = mentionValue ?? `@${definition.label}`
      return replaceSelectedSkill(current, value, composerMentions)
    })
  }

  function selectMention(mention: ComposerMention) {
    const task = businessTasks.find((item) => item.label === mention.label)
    if (task) selectBusinessTask(task.id, mention.value)
  }

  function changeDraft(nextDraft: string) {
    setDraft(nextDraft)
    if (!businessTaskExplicit || businessTask === 'QA') return
    const task = businessTasks.find((item) => item.id === businessTask)
    const mention = composerMentions.find((item) => item.label === task?.label)
    if (mention && !nextDraft.includes(mention.value)) {
      setBusinessTask('QA')
      setBusinessTaskExplicit(false)
    }
  }

  const sourceBackgroundInert = Boolean(selectedCitation && sourceDrawerModal)
  const sourceBackgroundProps = sourceBackgroundInert ? { inert: '' } : {}
  const showEmptyState = !loadingWorkspace && !loadingConversation && !messages.length && !pendingQuestion

  return (
    <ProductShell headerInert={sourceBackgroundInert}>
      <section className="chat-page" aria-label="企业知识助手工作区">
        <div className={`chat-layout${selectedCitation ? ' source-open' : ''}`}>
          <aside
            ref={conversationSidebarRef}
            {...sourceBackgroundProps}
            id="conversation-sidebar"
            className={`conversation-sidebar${conversationListOpen ? ' mobile-open' : ''}`}
            aria-label="对话列表"
            onKeyDown={handleConversationDrawerKeyDown}
          >
            <div className="sidebar-heading">
              <h2>对话</h2>
              <button
                ref={conversationCloseRef}
                type="button"
                className="icon-button conversation-sidebar-close"
                aria-label="关闭对话列表"
                title="关闭对话列表"
                onClick={closeConversationList}
              >
                <X aria-hidden="true" size={17} />
              </button>
            </div>
            <div className="conversation-sidebar-actions">
              <button type="button" className="new-conversation-button" disabled={switchLocked} onClick={startConversation}>
                <Plus aria-hidden="true" size={17} />
                新对话
              </button>
              <button
                type="button"
                className={`archived-conversations-button${showArchived ? ' active' : ''}`}
                aria-pressed={showArchived}
                disabled={switchLocked}
                onClick={() => setShowArchived((current) => !current)}
              >
                <ArchiveRestore aria-hidden="true" size={15} />
                <span>已归档</span>
                <span className="archived-conversations-count">{archivedConversations.length}</span>
              </button>
              <div className="conversation-search">
                <Search aria-hidden="true" size={15} />
                <input
                  type="search"
                  value={conversationSearch}
                  aria-label="搜索历史会话"
                  placeholder="搜索会话"
                  onChange={(event) => setConversationSearch(event.target.value)}
                />
                {conversationSearch ? (
                  <button
                    type="button"
                    className="conversation-search-clear"
                    aria-label="清除会话搜索"
                    title="清除搜索"
                    onClick={() => setConversationSearch('')}
                  >
                    <X aria-hidden="true" size={14} />
                  </button>
                ) : null}
              </div>
            </div>
            <ul className="conversation-list">
              {filteredConversations.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`conversation-link${conversation?.id === item.id ? ' active' : ''}`}
                    aria-current={conversation?.id === item.id ? 'page' : undefined}
                    disabled={switchLocked}
                    onClick={() => void selectConversation(item)}
                  >
                    {item.title || FALLBACK_CONVERSATION_TITLE}
                  </button>
                </li>
              ))}
              {!filteredConversations.length ? (
                <li className="conversation-list-empty">
                  {conversationSearch.trim() ? '未找到匹配的会话' : showArchived ? '暂无已归档会话' : '暂无进行中会话'}
                </li>
              ) : null}
            </ul>
          </aside>

          <main
            className={`chat-main${showEmptyState ? ' chat-main-empty' : ''}`}
            data-agent-run-id={currentRunId}
            {...sourceBackgroundProps}
          >
            <div className="chat-utility-actions">
              <button
                ref={conversationTriggerRef}
                type="button"
                className="icon-button conversation-drawer-trigger"
                aria-label="打开对话列表"
                title="打开对话列表"
                aria-controls="conversation-sidebar"
                aria-expanded={conversationListOpen}
                disabled={switchLocked}
                onClick={() => setConversationListOpen(true)}
              >
                <PanelLeft aria-hidden="true" size={18} />
              </button>
              {archived ? <span className="archive-label chat-archive-label">已归档</span> : null}
              {conversation ? (
                <button
                  type="button"
                  className="icon-button chat-archive-button"
                  aria-label={archived ? '恢复当前会话' : '归档当前对话'}
                  title={archived ? '恢复当前会话' : '归档当前对话'}
                  disabled={mutationLocked}
                  onClick={() => void (archived ? restoreConversation() : archiveConversation())}
                >
                  {archived ? <ArchiveRestore aria-hidden="true" size={17} /> : <Archive aria-hidden="true" size={17} />}
                </button>
              ) : null}
            </div>

            <ConversationOutline
              messages={messages}
              activePairId={activePairId}
              onActivate={activatePair}
              onHighlight={setHighlightedPairId}
            />

            <div className="chat-message-area">
              <div ref={messageScrollRef} className={`chat-message-scroll${showEmptyState ? ' chat-message-scroll-empty' : ''}`}>
                {loadingWorkspace || loadingConversation ? (
                  <div className="chat-loading" role="status"><span className="spinner" />正在加载</div>
                ) : messages.length || pendingQuestion ? (
                  <MessageThread
                    messages={messages}
                    pendingQuestion={pendingQuestion}
                    agentInterruptQuestion={agentInterruptQuestion}
                    answerProgress={answerProgress}
                    answerProgressTrail={answerProgressTrail}
                    streamedAnswer={streamedAnswer}
                    highlightedPairId={highlightedPairId}
                    expandedCitationId={selectedCitation?.id}
                    onCitation={(item, trigger) => void openCitation(item, trigger)}
                    feedbackPendingIds={feedbackPendingIds}
                    feedbackDisabled={archived}
                    onFeedback={(messageId, rating, reasonType, reasonText) => (
                      void updateFeedback(messageId, rating, reasonType, reasonText)
                    )}
                    onMaterialPreview={openMaterialPreview}
                    onMaterialDownload={(material) => void downloadMaterial(material)}
                    onMaterialDistribute={openMaterialDistribution}
                    onDraftSave={updateSolutionDraft}
                    onDraftConfirm={confirmSolutionDraft}
                    onInterruptAnswer={(answer, action) => void resumeAgentRun(answer, action)}
                    interruptDisabled={sending}
                  />
                ) : (
                  <div className="chat-empty prototype-home" aria-label="新对话引导">
                    <div className="prototype-hero">
                      <span className="prototype-eyebrow">统一对话入口 · 企业知识助手</span>
                      <h2>让每一次工作协作，<em>都从一个对话开始。</em></h2>
                    </div>
                    <div className="prototype-default-skill">
                      <span className="prototype-default-skill-icon"><MessageCircle aria-hidden="true" size={17} /></span>
                      <span><strong>默认能力 · 直接问答</strong><small>基于已审核、已发布且你有权限访问的企业资料，回答并保留引用。</small></span>
                    </div>
                    <div className="prototype-skill-strip" aria-label="可调用技能">
                      <span className="prototype-skill-strip-label">可调用技能</span>
                      {businessTasks.map((task) => {
                        const mention = composerMentions.find((item) => item.label === task.label)
                        const Icon = task.icon
                        return (
                          <button
                            key={task.id}
                            type="button"
                            className="prototype-skill-chip"
                            title={task.availability === 'PLANNED' ? `${task.description} · 第 ${task.stage} 阶段开放` : task.description}
                            aria-label={`选择${task.label}`}
                            onClick={() => selectBusinessTask(task.id, mention?.value)}
                          >
                            <Icon aria-hidden="true" size={15} />
                            <span>@{task.label}</span>
                          </button>
                        )
                      })}
                    </div>
                    <p className="prototype-skill-hint">需要查资料、做方案或分析会议时，AI 会自动调用合适技能；也可以输入 @ 手动选择。</p>
                    <div className="prototype-example-prompts" aria-label="示例问题">
                      <span>可以这样问</span>
                      {exampleQuestions.map((question) => (
                        <button key={question} type="button" onClick={() => selectExampleQuestion(question)}>{question}</button>
                      ))}
                    </div>
                    <div className="prototype-home-note"><BookOpen aria-hidden="true" size={15} /><span>资料原文只存放在飞书知识库，助手不会复制到其他位置</span></div>
                  </div>
                )}
              </div>

              {showScrollToBottom ? (
                <button
                  type="button"
                  className="chat-scroll-to-bottom"
                  aria-label="滚动到最新消息"
                  title="滚动到最新消息"
                  onClick={scrollToLatest}
                >
                  <ArrowDown aria-hidden="true" size={19} strokeWidth={1.9} />
                </button>
              ) : null}
            </div>

            {errorText ? (
              <div className="chat-error" role="alert">
                <span>{errorText}</span>
                {errorText === '发送失败，请重试' ? (
                  <button type="button" onClick={() => void send()}>重试</button>
                ) : errorText === '会话加载失败，请重试' ? (
                  <button type="button" onClick={() => void loadWorkspace()}>
                    <RefreshCw aria-hidden="true" size={14} />
                    重试
                  </button>
                ) : errorText === '恢复会话失败，请重试' ? (
                  <button type="button" onClick={() => void restoreConversation()}>
                    <RefreshCw aria-hidden="true" size={14} />
                    重试
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="chat-composer-dock">
              <ChatComposer
                value={draft}
                mode={answerMode}
                disabled={mutationLocked || archived}
                onChange={changeDraft}
                onModeChange={setAnswerMode}
                attachments={attachments}
                attachmentError={attachmentError}
                onFiles={addAttachments}
                onRemoveAttachment={removeAttachment}
                mentions={composerMentions}
                onMentionSelect={selectMention}
                showModeSwitch={false}
                sending={sending}
                onStop={stopSending}
                onSubmit={() => void (agentInterruptQuestion ? resumeAgentRun() : send())}
              />
            </div>
            {toastText ? <div className="chat-toast" role="status">{toastText}</div> : null}
          </main>

          <SourceDrawer citation={selectedCitation} modal={sourceDrawerModal} onClose={closeCitation} />
        </div>
        <MaterialDistributionDialog
          material={distributionMaterial}
          busy={distributionBusy}
          feedback={distributionFeedback}
          onSelectChannel={(channel) => void distributeMaterial(channel)}
          onClose={closeMaterialDistribution}
        />
        <button
          type="button"
          className={`conversation-backdrop${conversationListOpen ? ' is-open' : ''}`}
          aria-label="关闭对话列表"
          onClick={closeConversationList}
        />
      </section>
    </ProductShell>
  )
}
