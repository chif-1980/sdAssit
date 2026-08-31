import { Archive, ArchiveRestore, ArrowDown, ArrowUpRight, PanelLeft, Plus, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AnswerMode,
  FeedbackRating,
  ProductAnswerProgress,
  ProductAttachment,
  ProductCitation,
  ProductConversation,
  ProductMessage,
} from '../../shared/api/product.js'
import { ApiError, api, streamApi } from '../api/client'
import { ChatComposer } from '../components/chat/ChatComposer'
import type { ComposerAttachment } from '../components/chat/ChatComposer'
import { ConversationOutline } from '../components/chat/ConversationOutline'
import { MessageThread } from '../components/chat/MessageThread'
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
}

const MAX_COMPOSER_ATTACHMENTS = 5

const exampleQuestions = [
  '产品标准部署需要哪些前置条件？',
  '请对比不同部署模式的适用场景和限制。',
  '如何根据正式资料制定一份实施方案？',
] as const

function sortConversations(conversations: ProductConversation[]) {
  return [...conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function upsertConversation(current: ProductConversation[], next: ProductConversation) {
  const existing = current.some((item) => item.id === next.id)
  return sortConversations(existing
    ? current.map((item) => item.id === next.id ? next : item)
    : [next, ...current])
}

function hasCompleteProgressTrail(progressTrail: readonly ProductAnswerProgress[]) {
  const stages: ProductAnswerProgress['stage'][] = ['UNDERSTANDING', 'RETRIEVING', 'VERIFYING', 'COMPOSING']
  return stages
    .every((stage) => progressTrail.some((progress) => progress.stage === stage))
}

function attachmentUploadMessage(error: unknown) {
  if (error instanceof ApiError && (error.status === 404 || error.code === 'NOT_FOUND')) {
    return '附件解析服务暂不可用，请稍后重试'
  }
  if (error instanceof Error && error.message && !/^[A-Z][A-Z0-9_]*$/u.test(error.message)) {
    return error.message
  }
  return '附件上传失败，请重试'
}

export function ChatPage() {
  const [conversations, setConversations] = useState<ProductConversation[]>([])
  const [conversation, setConversation] = useState<ProductConversation>()
  const [messages, setMessages] = useState<ProductMessage[]>([])
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string>()
  const [answerMode, setAnswerMode] = useState<AnswerMode>('CONCISE')
  const [pendingQuestion, setPendingQuestion] = useState<string>()
  const [answerProgress, setAnswerProgress] = useState<ProductAnswerProgress>()
  const [answerProgressTrail, setAnswerProgressTrail] = useState<ProductAnswerProgress[]>([])
  const [streamedAnswer, setStreamedAnswer] = useState('')
  const [pendingAnswer, setPendingAnswer] = useState<SendResponse>()
  const [loadingWorkspace, setLoadingWorkspace] = useState(true)
  const [loadingConversation, setLoadingConversation] = useState(false)
  const [sending, setSending] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [feedbackPendingIds, setFeedbackPendingIds] = useState<Set<string>>(() => new Set())
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [activePairId, setActivePairId] = useState<string>()
  const [highlightedPairId, setHighlightedPairId] = useState<string>()
  const [errorText, setErrorText] = useState<string>()
  const [conversationListOpen, setConversationListOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [selectedCitation, setSelectedCitation] = useState<ProductCitation>()
  const [sourceDrawerModal, setSourceDrawerModal] = useState(false)
  const contextVersionRef = useRef(0)
  const citationVersionRef = useRef(0)
  const answerProgressTrailRef = useRef<ProductAnswerProgress[]>([])
  const pendingAnswerRef = useRef<SendResponse>()
  const citationTriggerRef = useRef<HTMLButtonElement>()
  const messageScrollRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)
  const conversationSidebarRef = useRef<HTMLElement>(null)
  const conversationTriggerRef = useRef<HTMLButtonElement>(null)
  const conversationCloseRef = useRef<HTMLButtonElement>(null)

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
        setConversation(detail.conversation)
        setMessages(detail.messages)
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
      contextVersionRef.current += 1
      citationVersionRef.current += 1
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
      const current = anchors.reduce((closest, anchor) => {
        const closestDistance = Math.abs(closest.getBoundingClientRect().top - threshold)
        const anchorDistance = Math.abs(anchor.getBoundingClientRect().top - threshold)
        return anchorDistance < closestDistance ? anchor : closest
      })
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
  const switchLocked = sending || Boolean(pendingAnswer) || archiving || restoring
  const mutationLocked = switchLocked || loadingWorkspace || loadingConversation
  const archived = conversation?.status === 'ARCHIVED'

  const applyAnswer = useCallback((result: SendResponse) => {
    pendingAnswerRef.current = undefined
    setConversation(result.conversation)
    setConversations((current) => upsertConversation(current, result.conversation))
    setMessages((current) => [...current, result.userMessage, result.assistantMessage])
    setPendingQuestion(undefined)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    setStreamedAnswer('')
    setPendingAnswer(undefined)
    setDraft('')
    setAttachments([])
    setAttachmentError(undefined)
  }, [])

  const finishProgressPlayback = useCallback(() => {
    const result = pendingAnswerRef.current
    if (result) applyAnswer(result)
  }, [applyAnswer])

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
    const focusable = Array.from(conversationSidebarRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])
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
    setAnswerMode('CONCISE')
    setPendingQuestion(undefined)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    setStreamedAnswer('')
    pendingAnswerRef.current = undefined
    setPendingAnswer(undefined)
    setActivePairId(undefined)
    setHighlightedPairId(undefined)
    setShowArchived(false)
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
    const version = ++contextVersionRef.current
    citationVersionRef.current += 1
    setErrorText(undefined)
    setPendingQuestion(undefined)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    setStreamedAnswer('')
    pendingAnswerRef.current = undefined
    setPendingAnswer(undefined)
    setActivePairId(undefined)
    setHighlightedPairId(undefined)
    setShowArchived(item.status === 'ARCHIVED')
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
      setConversation(detail.conversation)
      setMessages(detail.messages)
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
    const mode = answerMode
    const version = contextVersionRef.current
    setSending(true)
    setPendingQuestion(content)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    answerProgressTrailRef.current = []
    setStreamedAnswer('')
    pendingAnswerRef.current = undefined
    setPendingAnswer(undefined)
    setAttachmentError(undefined)
    followLatestRef.current = true
    setErrorText(undefined)
    try {
      let target = conversation
      if (!target) {
        const created = await api<{ conversation: ProductConversation }>('/api/chat/conversations', {
          method: 'POST',
          body: JSON.stringify({}),
        })
        if (contextVersionRef.current !== version) return
        target = created.conversation
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
              { method: 'POST', body: formData },
            )
            attachmentIds.push(uploaded.attachment.id)
          }
        } catch (error) {
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

      const messageBody = attachmentIds.length
        ? JSON.stringify({ content, mode, attachmentIds })
        : JSON.stringify({ content, mode })
      const result = await streamApi<SendResponse, ProductAnswerProgress>(
        `/api/chat/conversations/${target.id}/messages/stream`,
        {
          method: 'POST',
          body: messageBody,
        },
        {
          onProgress: (progress) => {
            if (contextVersionRef.current !== version) return
            setAnswerProgress(progress)
            answerProgressTrailRef.current = answerProgressTrailRef.current.at(-1)?.stage === progress.stage
              ? [...answerProgressTrailRef.current.slice(0, -1), progress]
              : [...answerProgressTrailRef.current, progress]
            setAnswerProgressTrail(answerProgressTrailRef.current)
          },
          onDelta: (delta) => {
            if (contextVersionRef.current === version) setStreamedAnswer((current) => current + delta)
          },
        },
      )
      if (contextVersionRef.current !== version) return
      if (hasCompleteProgressTrail(answerProgressTrailRef.current)) {
        pendingAnswerRef.current = result
        setPendingAnswer(result)
      } else applyAnswer(result)
    } catch {
      if (contextVersionRef.current !== version) return
      setPendingQuestion(undefined)
      setAnswerProgress(undefined)
      setAnswerProgressTrail([])
      answerProgressTrailRef.current = []
      setStreamedAnswer('')
      pendingAnswerRef.current = undefined
      setPendingAnswer(undefined)
      setErrorText('发送失败，请重试')
    } finally {
      if (contextVersionRef.current === version) setSending(false)
    }
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

  async function updateFeedback(messageId: string, rating: FeedbackRating | null) {
    if (feedbackPendingIds.has(messageId)) return
    const target = messages.find((message) => message.id === messageId && message.role === 'ASSISTANT')
    if (!target || archived) return
    const version = contextVersionRef.current
    const previousRating = target.feedbackRating ?? null
    setFeedbackPendingIds((current) => new Set(current).add(messageId))
    setErrorText(undefined)
    setMessages((current) => current.map((message) => (
      message.id === messageId ? { ...message, feedbackRating: rating } : message
    )))
    try {
      const response = await api<FeedbackResponse>(`/api/chat/messages/${messageId}/feedback`, {
        method: 'PUT',
        body: JSON.stringify({ rating }),
      })
      if (contextVersionRef.current !== version) return
      setMessages((current) => current.map((message) => (
        message.id === response.messageId
          ? { ...message, feedbackRating: response.feedbackRating }
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

  function activatePair(pairId: string) {
    const target = document.getElementById(messagePairAnchorId(pairId))
    if (!target) return
    setActivePairId(pairId)
    setHighlightedPairId(pairId)
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function selectExampleQuestion(question: string) {
    setAnswerMode('CONCISE')
    setDraft(question)
  }

  const sourceBackgroundInert = Boolean(selectedCitation && sourceDrawerModal)
  const sourceBackgroundProps = sourceBackgroundInert ? { inert: '' } : {}

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
            </div>
            <ul>
              {listedConversations.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`conversation-link${conversation?.id === item.id ? ' active' : ''}`}
                    aria-current={conversation?.id === item.id ? 'page' : undefined}
                    disabled={switchLocked}
                    onClick={() => void selectConversation(item)}
                  >
                    {item.title}
                  </button>
                </li>
              ))}
              {!listedConversations.length ? (
                <li className="conversation-list-empty">{showArchived ? '暂无已归档会话' : '暂无进行中会话'}</li>
              ) : null}
            </ul>
          </aside>

          <main className="chat-main" {...sourceBackgroundProps}>
            <header className="chat-conversation-header">
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
              <div className="chat-conversation-title">
                <strong>{conversation?.title ?? '新对话'}</strong>
                {archived ? <span className="archive-label">已归档</span> : null}
              </div>
              {conversation ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={archived ? '恢复当前会话' : '归档当前对话'}
                  title={archived ? '恢复当前会话' : '归档当前对话'}
                  disabled={mutationLocked}
                  onClick={() => void (archived ? restoreConversation() : archiveConversation())}
                >
                  {archived ? <ArchiveRestore aria-hidden="true" size={17} /> : <Archive aria-hidden="true" size={17} />}
                </button>
              ) : null}
            </header>

            <ConversationOutline
              messages={messages}
              activePairId={activePairId}
              onActivate={activatePair}
              onHighlight={setHighlightedPairId}
            />

            <div className="chat-message-area">
              <div ref={messageScrollRef} className="chat-message-scroll">
                {loadingWorkspace || loadingConversation ? (
                  <div className="chat-loading" role="status"><span className="spinner" />正在加载</div>
                ) : messages.length || pendingQuestion ? (
                  <MessageThread
                    messages={messages}
                    pendingQuestion={pendingQuestion}
                    answerProgress={answerProgress}
                    answerProgressTrail={answerProgressTrail}
                    streamedAnswer={streamedAnswer}
                    highlightedPairId={highlightedPairId}
                    expandedCitationId={selectedCitation?.id}
                    onCitation={(item, trigger) => void openCitation(item, trigger)}
                    feedbackPendingIds={feedbackPendingIds}
                    feedbackDisabled={archived}
                    onProgressPlaybackComplete={finishProgressPlayback}
                    onFeedback={(messageId, rating) => void updateFeedback(messageId, rating)}
                  />
                ) : (
                  <div className="chat-empty">
                    <div className="chat-empty-copy">
                      <h2>开始一段新对话</h2>
                      <p>输入问题，查找企业正式资料中的答案。</p>
                    </div>
                    <div className="chat-recommendations">
                      <p className="chat-recommendations-label">示例问题</p>
                      <div className="chat-recommendations-list">
                        {exampleQuestions.map((question) => (
                          <button
                            key={question}
                            type="button"
                            className="chat-recommendation"
                            onClick={() => selectExampleQuestion(question)}
                          >
                            <span>{question}</span>
                            <ArrowUpRight aria-hidden="true" size={15} />
                          </button>
                        ))}
                      </div>
                    </div>
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
                onChange={setDraft}
                onModeChange={setAnswerMode}
                attachments={attachments}
                attachmentError={attachmentError}
                onFiles={addAttachments}
                onRemoveAttachment={removeAttachment}
                onSubmit={() => void send()}
              />
            </div>
          </main>

          <SourceDrawer citation={selectedCitation} modal={sourceDrawerModal} onClose={closeCitation} />
        </div>
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
