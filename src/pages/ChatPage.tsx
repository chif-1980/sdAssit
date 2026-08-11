import { AlertTriangle, Archive, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Asset, Conversation, ConversationMessage, Citation } from '../../shared/domain/models.js'
import type { BusinessType, ConversationScope } from '../../shared/domain/enums.js'
import { api, ApiError } from '../api/client'
import { ChatComposer } from '../components/chat/ChatComposer'
import { MessageThread } from '../components/chat/MessageThread'
import { SourceDrawer } from '../components/chat/SourceDrawer'
import { AsyncState, type AsyncStatus } from '../components/ui/AsyncState'
import { useSession } from '../session/SessionProvider'

interface ConversationDetail {
  conversation: Conversation
  messages: ConversationMessage[]
  sessionAssets?: Asset[]
}

interface MessageResponse {
  conversation: Conversation
  message: ConversationMessage
  answer: { text: string; confidence: string; citations: Citation[] }
}

interface SessionAttachment {
  asset: Asset
  status: 'processing' | 'ready' | 'failed' | 'expired'
  error?: string
}

const businessTypes: Array<{ value: Exclude<BusinessType, 'SESSION_UPLOAD'>; label: string }> = [
  { value: 'PRODUCT_DOCUMENT', label: '产品文档' },
  { value: 'SOLUTION', label: '解决方案' },
  { value: 'POLICY', label: '制度' },
  { value: 'PROCESS', label: '流程' },
  { value: 'TRAINING', label: '培训' },
  { value: 'CUSTOMER_MEETING', label: '客户会议' },
  { value: 'INTERNAL_MEETING', label: '内部会议' },
  { value: 'PROJECT_DOCUMENT', label: '项目文档' },
  { value: 'OTHER', label: '其他' },
]

function sortConversations(conversations: Conversation[]) {
  return [...conversations].sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt))
}

function attachmentFromAsset(asset: Asset): SessionAttachment {
  if (asset.isSessionAsset && asset.expiresAt !== undefined && asset.expiresAt <= new Date().toISOString()) {
    return { asset, status: 'expired' }
  }
  if (asset.processStatus === 'PROCESSED') return { asset, status: 'ready' }
  if (asset.processStatus === 'FAILED') return { asset, status: 'failed', error: asset.errorMessage ?? '资料处理失败' }
  return { asset, status: 'processing' }
}

function upsertAttachment(current: SessionAttachment[], next: SessionAttachment) {
  const index = current.findIndex((item) => item.asset.id === next.asset.id)
  if (index === -1) return [...current, next]
  return current.map((item, itemIndex) => itemIndex === index ? next : item)
}

export function ChatPage() {
  const { user, users } = useSession()
  const [status, setStatus] = useState<AsyncStatus>('loading')
  const [errorText, setErrorText] = useState<string>()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [conversation, setConversation] = useState<Conversation>()
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [scope, setScope] = useState<ConversationScope>('ENTERPRISE')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [selectedCitation, setSelectedCitation] = useState<Citation>()
  const [attachments, setAttachments] = useState<SessionAttachment[]>([])
  const [pendingUploads, setPendingUploads] = useState(0)
  const [loadingConversation, setLoadingConversation] = useState(false)
  const [promotingAssetId, setPromotingAssetId] = useState<string>()
  const [promoteType, setPromoteType] = useState<Exclude<BusinessType, 'SESSION_UPLOAD'>>('PRODUCT_DOCUMENT')
  const [promoteOwnerId, setPromoteOwnerId] = useState('')
  const contextVersionRef = useRef(0)
  const activeUserIdRef = useRef(user?.id)
  activeUserIdRef.current = user?.id

  const loadDetail = useCallback(async (id: string) => {
    return api<ConversationDetail>(`/api/conversations/${id}`)
  }, [])

  const isCurrentContext = useCallback((version: number, actorId: string | undefined) => (
    contextVersionRef.current === version && activeUserIdRef.current === actorId
  ), [])

  const load = useCallback(async () => {
    const version = ++contextVersionRef.current
    const actorId = user?.id
    setStatus('loading')
    setErrorText(undefined)
    setSending(false)
    setArchiving(false)
    setPendingUploads(0)
    setLoadingConversation(false)
    setPromotingAssetId(undefined)
    try {
      const result = await api<{ conversations?: Conversation[] }>('/api/conversations')
      if (!isCurrentContext(version, actorId)) return
      const items = sortConversations(result.conversations ?? [])
      setConversations(items)
      if (items[0]) {
        const detail = await loadDetail(items[0].id)
        if (!isCurrentContext(version, actorId)) return
        setConversation(detail.conversation)
        setScope(detail.conversation.scope)
        setMessages(detail.messages)
        setAttachments((detail.sessionAssets ?? []).map(attachmentFromAsset))
      } else {
        setConversation(undefined)
        setMessages([])
        setAttachments([])
      }
      setStatus(items.length ? 'ready' : 'empty')
    } catch (cause) {
      if (!isCurrentContext(version, actorId)) return
      setStatus(cause instanceof ApiError && cause.status === 403 ? 'forbidden' : 'error')
      setErrorText(cause instanceof ApiError ? cause.message : '请求失败')
    }
  }, [isCurrentContext, loadDetail, user?.id])

  useEffect(() => { void load() }, [load])

  const activeConversationId = conversation?.id
  const visibleConversations = useMemo(() => sortConversations(conversations), [conversations])
  const factoryOwners = useMemo(() => users.filter((item) => item.role === 'OWNER' || item.role === 'ADMIN'), [users])
  const activeSessionAssetIds = useMemo(() => attachments
    .filter((item) => item.status === 'ready' && item.asset.isSessionAsset)
    .map((item) => item.asset.id), [attachments])
  const promotableAttachments = useMemo(() => attachments
    .filter((item) => item.status === 'ready' && item.asset.isSessionAsset), [attachments])
  const composerAttachments = useMemo(() => attachments.map((item) => ({
    id: item.asset.id,
    label: item.asset.title,
    status: item.status,
    error: item.error,
  })), [attachments])
  const navigationLocked = sending || archiving || pendingUploads > 0 || loadingConversation || Boolean(promotingAssetId)
  const canViewFactoryAsset = user?.role === 'ADMIN'
    || (user?.role === 'OWNER' && selectedCitation?.assetOwnerId === user.id)

  useEffect(() => {
    if (!factoryOwners.some((owner) => owner.id === promoteOwnerId)) setPromoteOwnerId(factoryOwners[0]?.id ?? '')
  }, [factoryOwners, promoteOwnerId])

  async function selectConversation(item: Conversation) {
    if (navigationLocked) return
    const version = ++contextVersionRef.current
    const actorId = user?.id
    setErrorText(undefined)
    setSelectedCitation(undefined)
    setLoadingConversation(true)
    try {
      const detail = await loadDetail(item.id)
      if (!isCurrentContext(version, actorId)) return
      setConversation(detail.conversation)
      setScope(detail.conversation.scope)
      setMessages(detail.messages)
      setAttachments((detail.sessionAssets ?? []).map(attachmentFromAsset))
      setStatus('ready')
    } catch (cause) {
      if (!isCurrentContext(version, actorId)) return
      setStatus('error')
      setErrorText(cause instanceof ApiError ? cause.message : '会话加载失败')
    } finally {
      if (isCurrentContext(version, actorId)) setLoadingConversation(false)
    }
  }

  function startConversation() {
    if (navigationLocked) return
    contextVersionRef.current += 1
    setConversation(undefined)
    setMessages([])
    setScope('ENTERPRISE')
    setDraft('')
    setSelectedCitation(undefined)
    setAttachments([])
    setStatus('empty')
  }

  async function uploadFile(file: File) {
    const isText = file.type === 'text/plain' || file.type === 'text/markdown' || /\.(?:txt|md|markdown)$/iu.test(file.name)
    if (!isText || !user) {
      const localId = `LOCAL-FAILED-${Date.now()}`
      setAttachments((current) => [...current, {
        asset: { id: localId, title: file.name, assetType: 'DOCUMENT', businessType: 'SESSION_UPLOAD', provider: 'LOCAL', externalId: localId, ownerId: user?.id ?? '', authority: 'L0', processStatus: 'FAILED', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isSessionAsset: true, sections: [] },
        status: 'failed', error: '仅支持 TXT 或 Markdown 文本资料',
      }])
      return
    }

    const version = contextVersionRef.current
    const actorId = user.id
    let createdAsset: Asset | undefined
    setPendingUploads((current) => current + 1)
    try {
      const content = await file.text()
      if (!isCurrentContext(version, actorId)) return
      const created = await api<{ asset: Asset }>('/api/assets', {
        method: 'POST',
        body: JSON.stringify({ title: file.name, assetType: 'DOCUMENT', businessType: 'SESSION_UPLOAD', ownerId: user.id, content, mimeType: file.type || 'text/plain', isSessionAsset: true }),
      })
      if (!isCurrentContext(version, actorId)) return
      createdAsset = created.asset
      setAttachments((current) => upsertAttachment(current, { asset: created.asset, status: 'processing' }))
      const processed = await api<{ asset: Asset }>(`/api/assets/${created.asset.id}/process`, { method: 'POST' })
      if (!isCurrentContext(version, actorId)) return
      if (processed.asset.processStatus !== 'PROCESSED') {
        setAttachments((current) => upsertAttachment(current, { asset: processed.asset, status: 'failed', error: processed.asset.errorMessage ?? '资料处理失败' }))
        return
      }
      setAttachments((current) => upsertAttachment(current, { asset: processed.asset, status: 'ready' }))
      setConversation((current) => current
        ? { ...current, sessionAssetIds: [...new Set([...current.sessionAssetIds, processed.asset.id])] }
        : current)
    } catch (cause) {
      if (!isCurrentContext(version, actorId)) return
      const failedAsset = createdAsset ?? { id: `LOCAL-FAILED-${Date.now()}`, title: file.name, assetType: 'DOCUMENT' as const, businessType: 'SESSION_UPLOAD' as const, provider: 'LOCAL' as const, externalId: `local-failed-${Date.now()}`, ownerId: user.id, authority: 'L0' as const, processStatus: 'FAILED' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isSessionAsset: true, sections: [] }
      setAttachments((current) => upsertAttachment(current, { asset: failedAsset, status: 'failed', error: cause instanceof ApiError ? cause.message : '资料处理失败' }))
    } finally {
      if (isCurrentContext(version, actorId)) setPendingUploads((current) => Math.max(0, current - 1))
    }
  }

  async function promoteAttachment(assetId: string) {
    const attachment = attachments.find((item) => item.asset.id === assetId)
    if (!attachment || attachment.status !== 'ready' || !promoteOwnerId) return
    const version = contextVersionRef.current
    const actorId = user?.id
    setPromotingAssetId(assetId)
    try {
      const result = await api<{ asset: Asset }>(`/api/assets/${attachment.asset.id}/promote`, {
        method: 'POST',
        body: JSON.stringify({ businessType: promoteType, ownerId: promoteOwnerId }),
      })
      if (!isCurrentContext(version, actorId)) return
      setAttachments((current) => current.filter((item) => item.asset.id !== result.asset.id))
      setConversation((current) => current
        ? { ...current, sessionAssetIds: current.sessionAssetIds.filter((id) => id !== result.asset.id) }
        : current)
      setConversations((current) => current.map((item) => item.id === conversation?.id
        ? { ...item, sessionAssetIds: item.sessionAssetIds.filter((id) => id !== result.asset.id) }
        : item))
      if (result.asset.processStatus === 'FAILED') {
        setErrorText(`企业资料已提交，但处理失败：${result.asset.errorMessage ?? '请联系知识负责人重新处理'}`)
      }
    } catch (cause) {
      if (!isCurrentContext(version, actorId)) return
      setErrorText(cause instanceof ApiError ? cause.message : '提交失败')
    } finally {
      if (isCurrentContext(version, actorId)) setPromotingAssetId(undefined)
    }
  }

  async function archiveConversation() {
    if (!conversation || conversation.status === 'ARCHIVED' || navigationLocked) return
    const version = contextVersionRef.current
    const actorId = user?.id
    setErrorText(undefined)
    setArchiving(true)
    try {
      const result = await api<{ conversation: Conversation }>(`/api/conversations/${conversation.id}/archive`, { method: 'POST' })
      if (!isCurrentContext(version, actorId)) return
      setConversation(result.conversation)
      setConversations((current) => current.map((item) => item.id === result.conversation.id ? result.conversation : item))
    } catch (cause) {
      if (!isCurrentContext(version, actorId)) return
      setErrorText(cause instanceof ApiError ? cause.message : '归档失败')
    } finally {
      if (isCurrentContext(version, actorId)) setArchiving(false)
    }
  }

  async function send() {
    const text = draft.trim()
    if (!text || sending || conversation?.status === 'ARCHIVED') return
    const version = contextVersionRef.current
    const actorId = user?.id
    setSending(true)
    setErrorText(undefined)
    const userMessage: ConversationMessage = {
      id: `LOCAL-${Date.now()}`,
      conversationId: conversation?.id ?? 'pending',
      role: 'USER',
      text,
      citations: [],
      createdAt: new Date().toISOString(),
    }
    setMessages((current) => [...current, userMessage])
    setDraft('')

    try {
      let target = conversation
      if (!target) {
        const created = await api<{ conversation: Conversation }>('/api/conversations', {
          method: 'POST',
          body: JSON.stringify({ scope, sessionAssetIds: activeSessionAssetIds }),
        })
        if (!isCurrentContext(version, actorId)) return
        target = created.conversation
        setConversation(target)
        setConversations((current) => sortConversations([target!, ...current]))
      }
      const response = await api<MessageResponse>(`/api/conversations/${target.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text, scope, sessionAssetIds: activeSessionAssetIds }),
      })
      if (!isCurrentContext(version, actorId)) return
      setConversation(response.conversation)
      setConversations((current) => sortConversations(current.map((item) => item.id === response.conversation.id ? response.conversation : item)))
      setMessages((current) => [...current, response.message])
    } catch (cause) {
      if (!isCurrentContext(version, actorId)) return
      setMessages((current) => current.filter((message) => message.id !== userMessage.id))
      setDraft(text)
      setErrorText(cause instanceof ApiError ? cause.message : '发送失败，请稍后重试')
    } finally {
      if (isCurrentContext(version, actorId)) {
        setSending(false)
        setStatus('ready')
      }
    }
  }

  const promotePanel = promotableAttachments.length ? (
    <div className="promote-panel">
      <strong>将会话资料提交为企业资料</strong>
      <div className="promote-controls">
        <label className="field"><span>资料类型</span><select value={promoteType} onChange={(event) => setPromoteType(event.target.value as Exclude<BusinessType, 'SESSION_UPLOAD'>)}>{businessTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label className="field"><span>负责人</span><select value={promoteOwnerId} onChange={(event) => setPromoteOwnerId(event.target.value)}>{factoryOwners.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      </div>
      <ul className="promote-list">
        {promotableAttachments.map((item) => (
          <li key={item.asset.id}>
            <span>{item.asset.title}</span>
            <button
              type="button"
              className="secondary-button"
              aria-label={`提交 ${item.asset.title} 为企业资料`}
              disabled={Boolean(promotingAssetId) || !promoteOwnerId}
              onClick={() => void promoteAttachment(item.asset.id)}
            >
              {promotingAssetId === item.asset.id ? '提交中' : '提交为企业资料'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ) : null

  const composer = (
    <ChatComposer
      value={draft}
      scope={scope}
      disabled={navigationLocked || conversation?.status === 'ARCHIVED'}
      attachments={composerAttachments}
      onChange={setDraft}
      onScopeChange={setScope}
      onSubmit={() => void send()}
      onFile={(file) => void uploadFile(file)}
    />
  )

  return (
    <section className="chat-page">
      <div className="chat-page-heading">
        <div>
          <h1>知识问答</h1>
          <p>基于已验证企业知识回答，并保留可追溯来源。</p>
        </div>
        <button type="button" className="secondary-button" disabled={navigationLocked} onClick={startConversation}>
          <Plus aria-hidden="true" size={16} />
          新对话
        </button>
      </div>
      {errorText ? <p className="error-banner"><AlertTriangle aria-hidden="true" size={16} />{errorText}</p> : null}
      {status === 'loading' || status === 'error' || status === 'forbidden' ? (
        <AsyncState status={status} emptyTitle="还没有会话" errorTitle="会话加载失败" onRetry={() => void load()}>
          <div />
        </AsyncState>
      ) : conversation ? (
        <div className={selectedCitation ? 'chat-layout source-open' : 'chat-layout'}>
          <aside className="conversation-sidebar" aria-label="会话历史">
            <div className="sidebar-heading"><h2>会话历史</h2><button type="button" className="icon-button" aria-label="新对话" disabled={navigationLocked} onClick={startConversation}><Plus aria-hidden="true" size={17} /></button></div>
            {visibleConversations.length ? <ul>{visibleConversations.map((item) => <li key={item.id}><button type="button" disabled={navigationLocked} className={item.id === activeConversationId ? 'conversation-link active' : 'conversation-link'} onClick={() => void selectConversation(item)}>{item.title}</button></li>)}</ul> : <p className="inline-empty">暂无历史会话</p>}
          </aside>
          <section className="chat-main active" aria-label="对话工作区">
            <div className="chat-content">
              <div className="chat-conversation-header">
                <strong>{conversation.title}</strong>
                {conversation.status === 'ACTIVE' ? <button type="button" className="secondary-button" disabled={navigationLocked} onClick={() => void archiveConversation()}><Archive aria-hidden="true" size={16} />归档会话</button> : <span className="status-chip">已归档</span>}
              </div>
              {messages.length ? <MessageThread messages={messages} onCitation={setSelectedCitation} /> : (
                <div className="chat-empty"><Archive aria-hidden="true" size={28} /><h2>从一个问题开始</h2><p>提问后，回答会显示在这里，并附带可核验来源。</p></div>
              )}
            </div>
            {promotePanel}
            {composer}
          </section>
          <SourceDrawer citation={selectedCitation} canViewAsset={canViewFactoryAsset} onClose={() => setSelectedCitation(undefined)} />
        </div>
      ) : (
        <div className="chat-start" aria-label="新对话">
          <div className="chat-start-content">
            {composer}
            {promotePanel}
          </div>
        </div>
      )}
      {status === 'ready' && conversation?.status === 'ARCHIVED' ? <p className="inline-empty">此会话已归档。</p> : null}
      {status === 'ready' && conversation && sending ? <p className="chat-loading"><RefreshCw aria-hidden="true" size={14} />正在生成回答</p> : null}
    </section>
  )
}
