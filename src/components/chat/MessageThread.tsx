import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type {
  AnswerStatus,
  FeedbackRating,
  FeedbackReasonType,
  ProductAnswerProgress,
  ProductAgentInterrupt,
  ProductCitation,
  ProductMessage,
  SolutionDraftEditRequest,
} from '../../../shared/api/product.js'
import type { ProductMaterial } from '../../../shared/api/product.js'
import { MaterialResultList } from './MaterialResultList'
import { mermaidMarkdownComponents } from './MermaidBlock'
import { ThinkingIndicator } from './ThinkingIndicator'
import { taskDefinition } from './businessTasks'
import { groupMessagePairs, messagePairAnchorId, type MessagePair } from './messagePairs.js'
import { SolutionDraftCard } from './SolutionDraftCard'
import { ClarificationCard } from './ClarificationCard'

interface MessageThreadProps {
  messages: ProductMessage[]
  pendingQuestion?: string
  agentInterruptQuestion?: ProductAgentInterrupt | string
  answerProgress?: ProductAnswerProgress
  answerProgressTrail?: readonly ProductAnswerProgress[]
  streamedAnswer?: string
  highlightedPairId?: string
  expandedCitationId?: string
  onCitation: (citation: ProductCitation, trigger: HTMLButtonElement) => void
  feedbackPendingIds?: ReadonlySet<string>
  feedbackDisabled?: boolean
  onFeedback?: (
    messageId: string,
    rating: FeedbackRating | null,
    reasonType?: FeedbackReasonType,
    reasonText?: string,
  ) => void
  onMaterialPreview?: (material: ProductMaterial, trigger: HTMLButtonElement) => void
  onMaterialDownload?: (material: ProductMaterial) => void
  onMaterialDistribute?: (material: ProductMaterial) => void
  onDraftSave?: (draftId: string, patch: SolutionDraftEditRequest) => Promise<void>
  onDraftConfirm?: (draftId: string) => Promise<void>
  onInterruptAnswer?: (answer: string | string[], action: 'answer' | 'skip') => void
  interruptDisabled?: boolean
}

const statusLabels: Record<AnswerStatus, string> = {
  SUPPORTED: '有正式资料支持',
  INSUFFICIENT: '依据不足',
  CONFLICTING: '资料存在冲突',
}

function citationImageSrc(citation?: ProductCitation) {
  if (citation?.mediaType !== 'IMAGE') return undefined
  return citation.previewUrl || citation.imageUrl || undefined
}

const feedbackReasons: { value: FeedbackReasonType; label: string }[] = [
  { value: 'CONTENT_ERROR', label: '内容错误' },
  { value: 'OUTDATED', label: '内容过时' },
  { value: 'MISSING_SOURCE', label: '资料缺失' },
  { value: 'CITATION_ERROR', label: '引用错误' },
  { value: 'OTHER', label: '其他' },
]

interface MarkdownNode {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

function createRemarkCitationLinks(citations: ProductCitation[]) {
  return function remarkCitationLinks() {
    return (tree: MarkdownNode) => {
      const placedImageCitations = new Set<number>()
      const visit = (node: MarkdownNode) => {
        if (!node.children || ['link', 'linkReference', 'code', 'inlineCode'].includes(node.type)) return
        const children: MarkdownNode[] = []
        for (const child of node.children) {
          if (child.type !== 'text' || !child.value) {
            visit(child)
            children.push(child)
            continue
          }
          for (const part of child.value.split(/(\[\d+\])/g)) {
            if (!part) continue
            const match = /^\[(\d+)\]$/.exec(part)
            const citationIndex = match ? Number(match[1]) - 1 : -1
            const placeImage = match
              && citationImageSrc(citations[citationIndex])
              && !placedImageCitations.has(citationIndex)
            if (placeImage) placedImageCitations.add(citationIndex)
            children.push(match
              ? {
                  type: 'link',
                  url: `#citation${placeImage ? '-image' : ''}-${match[1]}`,
                  children: [{ type: 'text', value: part }],
                }
              : { type: 'text', value: part })
          }
        }
        node.children = children
      }
      visit(tree)
    }
  }
}

function AssistantMarkdown({
  content,
  citations,
  expandedCitationId,
  onCitation,
}: {
  content: string
  citations: ProductCitation[]
  expandedCitationId?: string
  onCitation: (citation: ProductCitation, trigger: HTMLButtonElement) => void
}) {
  return (
    <div className="assistant-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, createRemarkCitationLinks(citations)]}
        skipHtml
        components={{
          ...mermaidMarkdownComponents,
          a: ({ href, children }) => {
            const match = /^#citation(-image)?-(\d+)$/.exec(href ?? '')
            if (!match) {
              return <a href={href} target="_blank" rel="noreferrer">{children}</a>
            }
            const citationNumber = match[2]
            const citation = citations[Number(citationNumber) - 1]
            if (!citation) return <>{children}</>
            const imageSrc = citationImageSrc(citation)
            if (match[1] && imageSrc) {
              return (
                <button
                  type="button"
                  className="inline-image-citation"
                  aria-label={`查看图片来源 [${citationNumber}]`}
                  aria-controls="source-drawer"
                  aria-haspopup="dialog"
                  aria-expanded={citation.id === expandedCitationId}
                  onClick={(event) => onCitation(citation, event.currentTarget)}
                >
                  <img src={imageSrc} alt={citation.imageAlt || citation.title} loading="lazy" />
                  <span className="inline-image-citation-caption">
                    <span className="inline-image-citation-index">[{citationNumber}]</span>
                    <span>{citation.imageAlt || citation.title}</span>
                  </span>
                </button>
              )
            }
            return (
              <button
                type="button"
                className="inline-citation"
                aria-label={`查看来源 [${citationNumber}]`}
                aria-controls="source-drawer"
                aria-haspopup="dialog"
                aria-expanded={citation.id === expandedCitationId}
                onClick={(event) => onCitation(citation, event.currentTarget)}
              >
                {children}
              </button>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

interface MessageBubbleProps {
  message: ProductMessage
  expandedCitationId?: string
  onCitation: (citation: ProductCitation, trigger: HTMLButtonElement) => void
  feedbackPendingIds?: ReadonlySet<string>
  feedbackDisabled: boolean
  onFeedback?: MessageThreadProps['onFeedback']
  onMaterialPreview?: MessageThreadProps['onMaterialPreview']
  onMaterialDownload?: MessageThreadProps['onMaterialDownload']
  onMaterialDistribute?: MessageThreadProps['onMaterialDistribute']
  onDraftSave?: MessageThreadProps['onDraftSave']
  onDraftConfirm?: MessageThreadProps['onDraftConfirm']
}

function MessageBubble({
  message,
  expandedCitationId,
  onCitation,
  feedbackPendingIds,
  feedbackDisabled,
  onFeedback,
  onMaterialPreview,
  onMaterialDownload,
  onMaterialDistribute,
  onDraftSave,
  onDraftConfirm,
}: MessageBubbleProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [reasonType, setReasonType] = useState<FeedbackReasonType>(
    message.feedbackReasonType ?? 'CONTENT_ERROR',
  )
  const [reasonText, setReasonText] = useState(message.feedbackReasonText ?? '')

  function handleDislike() {
    if (message.feedbackRating === 'DISLIKE') {
      setFeedbackOpen(false)
      onFeedback?.(message.id, null)
      return
    }
    setFeedbackOpen(true)
  }

  function submitDislike() {
    onFeedback?.(message.id, 'DISLIKE', reasonType, reasonText.trim() || undefined)
    setFeedbackOpen(false)
  }

  const skill = message.skillId ? taskDefinition(message.skillId) : undefined

  return (
    <article className={`message-bubble message-${message.role.toLowerCase()}`}>
      <div className="message-role">{message.role === 'USER' ? '你' : '助手'}</div>
      {skill ? (
        <div className={`message-skill-call${skill.availability === 'PLANNED' ? ' is-planned' : ''}`} role="status">
          <span>已调用技能</span>
          <strong>{skill.label}</strong>
          {skill.availability === 'PLANNED' ? <small>第 {skill.stage} 阶段开放</small> : null}
        </div>
      ) : null}
      {message.answerStatus ? (
        <span className={`answer-status answer-${message.answerStatus.toLowerCase()}`}>
          {statusLabels[message.answerStatus]}
        </span>
      ) : null}
      {message.role === 'ASSISTANT' ? (
        <AssistantMarkdown
          // Planned skills use INSUFFICIENT as their honest status, but their
          // response is still actionable (it explains the rollout boundary).
          // Only ordinary knowledge answers should replace the raw text with
          // the generic evidence-shortage message.
          content={message.answerStatus === 'INSUFFICIENT' && !skill
            ? '暂无足够可靠资料'
            : message.content}
          citations={message.citations}
          expandedCitationId={expandedCitationId}
          onCitation={onCitation}
        />
      ) : <p>{message.content}</p>}
      {message.role === 'ASSISTANT' && message.citations.some((citation) => !citationImageSrc(citation)) ? (
        <div className="message-citations message-citations-inline" aria-label="回答引用">
          {message.citations.map((citation, index) => citationImageSrc(citation) ? null : (
            <button
              type="button"
              className="citation-button"
              key={citation.id}
              aria-label={`[${index + 1}]`}
              aria-controls="source-drawer"
              aria-haspopup="dialog"
              aria-expanded={citation.id === expandedCitationId}
              onClick={(event) => onCitation(citation, event.currentTarget)}
            >
              [{index + 1}]
            </button>
          ))}
        </div>
      ) : null}
      {message.role === 'ASSISTANT' && message.materials?.length ? (
        <MaterialResultList
          materials={message.materials}
          onPreview={(material, trigger) => onMaterialPreview?.(material, trigger)}
          onDownload={(material) => onMaterialDownload?.(material)}
          onDistribute={(material) => onMaterialDistribute?.(material)}
        />
      ) : null}
      {message.role === 'ASSISTANT' && message.solutionDraft ? (
        <SolutionDraftCard
          draft={message.solutionDraft}
          onSave={onDraftSave ? (patch) => onDraftSave(message.solutionDraft!.id, patch) : undefined}
          onConfirm={onDraftConfirm ? () => onDraftConfirm(message.solutionDraft!.id) : undefined}
        />
      ) : null}
      {message.role === 'ASSISTANT' ? (
        <div className="message-footer">
          <div className="message-feedback" aria-label="回答反馈">
            <button
              type="button"
              className={`feedback-button${message.feedbackRating === 'LIKE' ? ' is-selected is-like' : ''}`}
              aria-label="点赞这条回答"
              aria-pressed={message.feedbackRating === 'LIKE'}
              title="点赞这条回答"
              disabled={feedbackDisabled || feedbackPendingIds?.has(message.id)}
              onClick={() => onFeedback?.(message.id, message.feedbackRating === 'LIKE' ? null : 'LIKE')}
            >
              <ThumbsUp aria-hidden="true" size={15} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={`feedback-button${message.feedbackRating === 'DISLIKE' ? ' is-selected is-dislike' : ''}`}
              aria-label="点踩这条回答"
              aria-pressed={message.feedbackRating === 'DISLIKE'}
              title="点踩这条回答"
              disabled={feedbackDisabled || feedbackPendingIds?.has(message.id)}
              onClick={handleDislike}
            >
              <ThumbsDown aria-hidden="true" size={15} strokeWidth={1.8} />
            </button>
          </div>
          {feedbackOpen ? (
            <div className="feedback-reason-panel" role="dialog" aria-label="选择不满意原因">
              <div className="feedback-reason-options" role="radiogroup" aria-label="不满意原因">
                {feedbackReasons.map((reason) => (
                  <label key={reason.value} className={reasonType === reason.value ? 'is-selected' : ''}>
                    <input
                      type="radio"
                      name={`feedback-reason-${message.id}`}
                      value={reason.value}
                      checked={reasonType === reason.value}
                      onChange={() => setReasonType(reason.value)}
                    />
                    <span>{reason.label}</span>
                  </label>
                ))}
              </div>
              <textarea
                value={reasonText}
                maxLength={500}
                rows={2}
                placeholder="补充说明（选填）"
                aria-label="补充说明"
                onChange={(event) => setReasonText(event.target.value)}
              />
              <div className="feedback-reason-actions">
                <button type="button" onClick={() => setFeedbackOpen(false)}>取消</button>
                <button type="button" className="is-primary" onClick={submitDislike}>提交反馈</button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function MessagePairBlock({
  pair,
  highlighted,
  expandedCitationId,
  onCitation,
  feedbackPendingIds,
  feedbackDisabled,
  onFeedback,
  onMaterialPreview,
  onMaterialDownload,
  onMaterialDistribute,
  onDraftSave,
  onDraftConfirm,
}: {
  pair: MessagePair
  highlighted: boolean
  expandedCitationId?: string
  onCitation: (citation: ProductCitation, trigger: HTMLButtonElement) => void
  feedbackPendingIds?: ReadonlySet<string>
  feedbackDisabled: boolean
  onFeedback?: MessageThreadProps['onFeedback']
  onMaterialPreview?: MessageThreadProps['onMaterialPreview']
  onMaterialDownload?: MessageThreadProps['onMaterialDownload']
  onMaterialDistribute?: MessageThreadProps['onMaterialDistribute']
  onDraftSave?: MessageThreadProps['onDraftSave']
  onDraftConfirm?: MessageThreadProps['onDraftConfirm']
}) {
  return (
    <div
      id={messagePairAnchorId(pair.id)}
      data-message-pair={pair.id}
      className={`message-pair${highlighted ? ' is-highlighted' : ''}`}
    >
      {pair.user ? <MessageBubble message={pair.user} expandedCitationId={expandedCitationId} onCitation={onCitation} feedbackPendingIds={feedbackPendingIds} feedbackDisabled={feedbackDisabled} onFeedback={onFeedback} onMaterialPreview={onMaterialPreview} onMaterialDownload={onMaterialDownload} onMaterialDistribute={onMaterialDistribute} onDraftSave={onDraftSave} onDraftConfirm={onDraftConfirm} /> : null}
      {pair.assistant ? <MessageBubble message={pair.assistant} expandedCitationId={expandedCitationId} onCitation={onCitation} feedbackPendingIds={feedbackPendingIds} feedbackDisabled={feedbackDisabled} onFeedback={onFeedback} onMaterialPreview={onMaterialPreview} onMaterialDownload={onMaterialDownload} onMaterialDistribute={onMaterialDistribute} onDraftSave={onDraftSave} onDraftConfirm={onDraftConfirm} /> : null}
    </div>
  )
}

export function MessageThread({
  messages,
  pendingQuestion,
  agentInterruptQuestion,
  answerProgress,
  answerProgressTrail,
  streamedAnswer,
  highlightedPairId,
  expandedCitationId,
  onCitation,
  feedbackPendingIds,
  feedbackDisabled = false,
  onFeedback,
  onMaterialPreview,
  onMaterialDownload,
  onMaterialDistribute,
  onDraftSave,
  onDraftConfirm,
  onInterruptAnswer,
  interruptDisabled = false,
}: MessageThreadProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const lastMessageId = messages.at(-1)?.id
  const pairs = groupMessagePairs(messages)

  useEffect(() => {
    const end = endRef.current
    if (typeof end?.scrollIntoView === 'function') end.scrollIntoView({ block: 'end' })
  }, [messages.length, lastMessageId, pendingQuestion])

  return (
    <div className="message-thread" aria-label="消息线程">
      {pairs.map((pair) => (
        <MessagePairBlock
          key={pair.id}
          pair={pair}
          highlighted={pair.id === highlightedPairId}
          expandedCitationId={expandedCitationId}
          onCitation={onCitation}
          feedbackPendingIds={feedbackPendingIds}
          feedbackDisabled={feedbackDisabled}
          onFeedback={onFeedback}
          onMaterialPreview={onMaterialPreview}
          onMaterialDownload={onMaterialDownload}
          onMaterialDistribute={onMaterialDistribute}
          onDraftSave={onDraftSave}
          onDraftConfirm={onDraftConfirm}
        />
      ))}
      {pendingQuestion ? (
        <>
          <article className="message-bubble message-user message-pending-question">
            <div className="message-role">你</div>
            <p>{pendingQuestion}</p>
          </article>
          {agentInterruptQuestion ? (
            <article className="message-bubble message-assistant message-agent-interrupt" role="status">
              <div className="message-role">助手</div>
              {typeof agentInterruptQuestion === 'string' ? (
                <><p>为了继续生成方案，请补充：</p><p>{agentInterruptQuestion}</p></>
              ) : (
                <ClarificationCard interrupt={agentInterruptQuestion} disabled={interruptDisabled} onSubmit={onInterruptAnswer} />
              )}
            </article>
          ) : (
            <article className={`message-bubble message-assistant message-pending${streamedAnswer ? ' message-streaming' : ''}`}>
              <div className="message-role">助手</div>
              <ThinkingIndicator
                progress={answerProgress}
                progressTrail={answerProgressTrail}
                streaming={Boolean(streamedAnswer)}
              />
              {streamedAnswer ? (
                <div className="message-streaming-body" aria-live="polite">
                  <span className="message-streaming-status" role="status">正在生成预览</span>
                  <AssistantMarkdown content={streamedAnswer} citations={[]} onCitation={onCitation} />
                </div>
              ) : null}
            </article>
          )}
        </>
      ) : null}
      <div ref={endRef} aria-hidden="true" />
    </div>
  )
}
