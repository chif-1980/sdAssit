import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type {
  AnswerStatus,
  FeedbackRating,
  FeedbackReasonType,
  ProductAnswerProgress,
  ProductCitation,
  ProductMessage,
} from '../../../shared/api/product.js'
import { ThinkingIndicator } from './ThinkingIndicator'
import { groupMessagePairs, messagePairAnchorId, type MessagePair } from './messagePairs.js'

interface MessageThreadProps {
  messages: ProductMessage[]
  pendingQuestion?: string
  answerProgress?: ProductAnswerProgress
  answerProgressTrail?: readonly ProductAnswerProgress[]
  streamedAnswer?: string
  highlightedPairId?: string
  expandedCitationId?: string
  onCitation: (citation: ProductCitation, trigger: HTMLButtonElement) => void
  feedbackPendingIds?: ReadonlySet<string>
  feedbackDisabled?: boolean
  onProgressPlaybackComplete?: () => void
  onFeedback?: (
    messageId: string,
    rating: FeedbackRating | null,
    reasonType?: FeedbackReasonType,
    reasonText?: string,
  ) => void
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
}

function MessageBubble({
  message,
  expandedCitationId,
  onCitation,
  feedbackPendingIds,
  feedbackDisabled,
  onFeedback,
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

  return (
    <article className={`message-bubble message-${message.role.toLowerCase()}`}>
      <div className="message-role">{message.role === 'USER' ? '你' : '助手'}</div>
      {message.answerStatus ? (
        <span className={`answer-status answer-${message.answerStatus.toLowerCase()}`}>
          {statusLabels[message.answerStatus]}
        </span>
      ) : null}
      {message.role === 'ASSISTANT' ? (
        <AssistantMarkdown
          content={message.answerStatus === 'INSUFFICIENT' ? '暂无足够可靠资料' : message.content}
          citations={message.citations}
          expandedCitationId={expandedCitationId}
          onCitation={onCitation}
        />
      ) : <p>{message.content}</p>}
      {message.role === 'ASSISTANT' ? (
        <div className="message-footer">
          {message.citations.some((citation) => !citationImageSrc(citation)) ? (
            <div className="message-citations" aria-label="回答引用">
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
}: {
  pair: MessagePair
  highlighted: boolean
  expandedCitationId?: string
  onCitation: (citation: ProductCitation, trigger: HTMLButtonElement) => void
  feedbackPendingIds?: ReadonlySet<string>
  feedbackDisabled: boolean
  onFeedback?: MessageThreadProps['onFeedback']
}) {
  return (
    <div
      id={messagePairAnchorId(pair.id)}
      data-message-pair={pair.id}
      className={`message-pair${highlighted ? ' is-highlighted' : ''}`}
    >
      {pair.user ? <MessageBubble message={pair.user} expandedCitationId={expandedCitationId} onCitation={onCitation} feedbackPendingIds={feedbackPendingIds} feedbackDisabled={feedbackDisabled} onFeedback={onFeedback} /> : null}
      {pair.assistant ? <MessageBubble message={pair.assistant} expandedCitationId={expandedCitationId} onCitation={onCitation} feedbackPendingIds={feedbackPendingIds} feedbackDisabled={feedbackDisabled} onFeedback={onFeedback} /> : null}
    </div>
  )
}

export function MessageThread({
  messages,
  pendingQuestion,
  answerProgress,
  answerProgressTrail,
  streamedAnswer,
  highlightedPairId,
  expandedCitationId,
  onCitation,
  feedbackPendingIds,
  feedbackDisabled = false,
  onProgressPlaybackComplete,
  onFeedback,
}: MessageThreadProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const lastMessageId = messages.at(-1)?.id
  const pairs = groupMessagePairs(messages)
  const handleProgressPlaybackComplete = useCallback(() => {
    onProgressPlaybackComplete?.()
  }, [onProgressPlaybackComplete])

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
        />
      ))}
      {pendingQuestion ? (
        <>
          <article className="message-bubble message-user message-pending-question">
            <div className="message-role">你</div>
            <p>{pendingQuestion}</p>
          </article>
          {streamedAnswer ? (
            <article className="message-bubble message-assistant message-streaming" aria-live="polite">
              <div className="message-streaming-heading">
                <div className="message-role">助手</div>
                <span className="message-streaming-status" role="status">正在生成</span>
              </div>
              <AssistantMarkdown content={streamedAnswer} citations={[]} onCitation={onCitation} />
            </article>
          ) : (
            <ThinkingIndicator
              progress={answerProgress}
              progressTrail={answerProgressTrail}
              onPlaybackComplete={handleProgressPlaybackComplete}
            />
          )}
        </>
      ) : null}
      <div ref={endRef} aria-hidden="true" />
    </div>
  )
}
