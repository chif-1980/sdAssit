import { useEffect, useRef } from 'react'

import type { AnswerStatus, ProductCitation, ProductMessage } from '../../../shared/api/product.js'

interface MessageThreadProps {
  messages: ProductMessage[]
  expandedCitationId?: string
  onCitation: (citation: ProductCitation, trigger: HTMLButtonElement) => void
}

const statusLabels: Record<AnswerStatus, string> = {
  SUPPORTED: '有正式资料支持',
  INSUFFICIENT: '依据不足',
  CONFLICTING: '资料存在冲突',
}

export function MessageThread({ messages, expandedCitationId, onCitation }: MessageThreadProps) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const end = endRef.current
    if (typeof end?.scrollIntoView === 'function') end.scrollIntoView({ block: 'end' })
  }, [messages])

  return (
    <div className="message-thread" aria-label="消息线程">
      {messages.map((message) => (
        <article key={message.id} className={`message-bubble message-${message.role.toLowerCase()}`}>
          <div className="message-role">{message.role === 'USER' ? '你' : '助手'}</div>
          {message.answerStatus ? (
            <span className={`answer-status answer-${message.answerStatus.toLowerCase()}`}>
              {statusLabels[message.answerStatus]}
            </span>
          ) : null}
          <p>{message.answerStatus === 'INSUFFICIENT' ? '暂无足够可靠资料' : message.content}</p>
          {message.citations.length ? (
            <div className="message-citations" aria-label="回答引用">
              {message.citations.map((citation, index) => (
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
        </article>
      ))}
      <div ref={endRef} aria-hidden="true" />
    </div>
  )
}
