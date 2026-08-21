import { Archive, ArrowDown, PanelLeft, Plus, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AnswerMode,
  FeedbackRating,
  ProductAnswerProgress,
  ProductCitation,
  ProductConversation,
  ProductMessage,
} from '../../shared/api/product.js'
import { api, streamApi } from '../api/client'
import { ChatComposer } from '../components/chat/ChatComposer'
import { MessageThread } from '../components/chat/MessageThread'
import { SourceDrawer } from '../components/chat/SourceDrawer'
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

function sortConversations(conversations: ProductConversation[]) {
  return [...conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function upsertConversation(current: ProductConversation[], next: ProductConversation) {
  const existing = current.some((item) => item.id === next.id)
  return sortConversations(existing
    ? current.map((item) => item.id === next.id ? next : item)
    : [next, ...current])
}

export function ChatPage() {
  const [conversations, setConversations] = useState<ProductConversation[]>([])
  const [conversation, setConversation] = useState<ProductConversation>()
  const [messages, setMessages] = useState<ProductMessage[]>([])
  const [draft, setDraft] = useState('')
  const [answerMode, setAnswerMode] = useState<AnswerMode>('CONCISE')
  const [pendingQuestion, setPendingQuestion] = useState<string>()
  const [answerProgress, setAnswerProgress] = useState<ProductAnswerProgress>()
  const [answerProgressTrail, setAnswerProgressTrail] = useState<ProductAnswerProgress[]>([])
  const [streamedAnswer, setStreamedAnswer] = useState('')
  const [loadingWorkspace, setLoadingWorkspace] = useState(true)
  const [loadingConversation, setLoadingConversation] = useState(false)
  const [sending, setSending] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [feedbackPendingIds, setFeedbackPendingIds] = useState<Set<string>>(() => new Set())
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [errorText, setErrorText] = useState<string>()
  const [conversationListOpen, setConversationListOpen] = useState(false)
  const [selectedCitation, setSelectedCitation] = useState<ProductCitation>()
  const [sourceDrawerModal, setSourceDrawerModal] = useState(false)
  const contextVersionRef = useRef(0)
  const citationVersionRef = useRef(0)
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
      if (items[0]) {
        const detail = await api<ConversationDetail>(`/api/chat/conversations/${items[0].id}`)
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
  const switchLocked = sending || archiving
  const mutationLocked = switchLocked || loadingWorkspace || loadingConversation
  const archived = conversation?.status === 'ARCHIVED'

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
    setPendingQuestion(undefined)
    setAnswerProgress(undefined)
    setAnswerProgressTrail([])
    setStreamedAnswer('')
    setDraft('')
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
    setStreamedAnswer('')
    setSelectedCitation(undefined)
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
    setStreamedAnswer('')
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
      const result = await streamApi<SendResponse, ProductAnswerProgress>(
        `/api/chat/conversations/${target.id}/messages/stream`,
        {
          method: 'POST',
          body: JSON.stringify({ content, mode }),
        },
        {
          onProgress: (progress) => {
            if (contextVersionRef.current !== version) return
            setAnswerProgress(progress)
            setAnswerProgressTrail((current) => (
              current.at(-1)?.stage === progress.stage
                ? [...current.slice(0, -1), progress]
                : [...current, progress]
            ))
          },
          onDelta: (delta) => {
            if (contextVersionRef.current === version) setStreamedAnswer((current) => current + delta)
          },
        },
      )
      if (contextVersionRef.current !== version) return
      setConversation(result.conversation)
      setConversations((current) => upsertConversation(current, result.conversation))
      setMessages((current) => [...current, result.userMessage, result.assistantMessage])
      setPendingQuestion(undefined)
      setAnswerProgress(undefined)
      setAnswerProgressTrail([])
      setStreamedAnswer('')
      setDraft('')
    } catch {
      if (contextVersionRef.current !== version) return
      setPendingQuestion(undefined)
      setAnswerProgress(undefined)
      setAnswerProgressTrail([])
      setStreamedAnswer('')
      setErrorText('发送失败，请重试')
    } finally {
      if (contextVersionRef.current === version) setSending(false)
    }
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
            <button type="button" className="new-conversation-button" disabled={switchLocked} onClick={startConversation}>
              <Plus aria-hidden="true" size={17} />
              新对话
            </button>
            <ul>
              {visibleConversations.map((item) => (
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
                  aria-label="归档当前对话"
                  title="归档当前对话"
                  disabled={mutationLocked || archived}
                  onClick={() => void archiveConversation()}
                >
                  <Archive aria-hidden="true" size={17} />
                </button>
              ) : null}
            </header>

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
                  expandedCitationId={selectedCitation?.id}
                  onCitation={(item, trigger) => void openCitation(item, trigger)}
                  feedbackPendingIds={feedbackPendingIds}
                  feedbackDisabled={archived}
                  onFeedback={(messageId, rating) => void updateFeedback(messageId, rating)}
                />
              ) : (
                <div className="chat-empty">
                  <h2>开始一段新对话</h2>
                  <p>输入问题，查找企业正式资料中的答案。</p>
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
